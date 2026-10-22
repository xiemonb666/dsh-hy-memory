"""Loopback HTTP surface for the HyMemory worker.

Contract: ``docs/internal/API_CONTRACT.md`` section 1. Summary of the rules
enforced here:

* binds ``127.0.0.1`` only (never ``0.0.0.0``);
* every ``/v1`` route requires ``Authorization: Bearer <token>`` compared in
  constant time; the token never appears in a log line or an error body;
* request bodies are JSON, capped at 4 MiB, and parsed strictly;
* errors use ``{"error": {"code": "E_*", "message": ...}}``;
* no CORS headers are ever emitted (``Origin`` is not trusted);
* every log line is redacted, and every response payload is redacted again on
  the way out (defence in depth; the Host redacts too).
"""

from __future__ import annotations

import contextlib
import hmac
import json
import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from .engine import (
    FEEDBACK_KINDS,
    EngineError,
    IngestInput,
    MemoryEngine,
    SearchInput,
    ValidationError,
    redact_text,
    redact_value,
)
from .hy_engine import HyMemoryEngine
from .mock_engine import MockEngine

LOGGER = logging.getLogger("hymem_worker")

HOST = "127.0.0.1"
MAX_BODY_BYTES = 4 * 1024 * 1024
DEFAULT_REQUEST_TIMEOUT = 30.0
DEFAULT_PORT = 48732
TOKEN_ENV = "HYMEM_WORKER_TOKEN"

ENGINE_CHOICES: tuple[str, ...] = ("auto", "mock", "hy")

RouteHandler = Callable[["WorkerRequestHandler", dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class Route:
    """One ``/v1`` endpoint: HTTP method plus its handler."""

    method: str
    handler: RouteHandler


# ---------------------------------------------------------------------------
# Engine selection
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EngineSelection:
    """Chosen engine plus how it was chosen (reported in the ready line)."""

    engine: MemoryEngine
    requested: str
    reason: str


def select_engine(
    requested: str = "auto",
    *,
    data_dir: str | None = None,
    env: dict[str, str] | None = None,
) -> EngineSelection:
    """Pick an engine only after checking the host's explicit egress policy.

    Configured endpoints and credentials are not permission. ``auto`` degrades
    to the deterministic mock when policy denies egress; explicit ``hy`` fails
    with a typed refusal. A real SDK engine is never constructed before these
    checks pass.
    """
    environ = os.environ if env is None else env
    if requested == "mock":
        return EngineSelection(MockEngine(), requested, "explicit --engine mock")
    if requested not in ("auto", "hy"):
        raise ValidationError(
            f"engine must be one of {list(ENGINE_CHOICES)}",
            details={"field": "engine", "value": requested},
        )
    policy, policy_error = _read_model_policy(environ)
    configured = any(
        bool(environ.get(name))
        for name in (
            policy["extractionEndpointEnv"],
            policy["embeddingEndpointEnv"],
            "MEMORY_LLM_BASE_URL",
            "MEMORY_EMBEDDER_BASE_URL",
            "OPENAI_BASE_URL",
            "LLM_BASE_URL",
            "OPENAI_API_KEY",
        )
    )
    if requested == "auto" and not configured and not policy_error:
        return EngineSelection(MockEngine(), requested, "no model endpoint or key configured")
    denial = policy_error or _model_egress_denial(policy, environ)
    if denial:
        if requested == "hy":
            raise EngineError(
                "E_FORBIDDEN",
                f"HyMemory SDK startup refused: {denial}",
                details={"policy": "models.externalEgress", "reason": denial},
            )
        return EngineSelection(MockEngine(), requested, f"model egress denied by policy: {denial}")
    return EngineSelection(
        HyMemoryEngine(data_dir=data_dir),
        requested,
        "explicit --engine hy" if requested == "hy" else "host policy allows configured model egress",
    )


def _read_model_policy(environ: dict[str, str]) -> tuple[dict[str, Any], str | None]:
    """Parse the host-owned model policy; missing or malformed policy denies."""
    defaults: dict[str, Any] = {
        "externalEgress": "ask-first",
        "localOnly": True,
        "extractionEndpointEnv": "MEMORY_LLM_BASE_URL",
        "embeddingEndpointEnv": "MEMORY_EMBEDDER_BASE_URL",
    }
    raw = environ.get("HYMEM_MODEL_POLICY")
    if raw is None:
        return defaults, None
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return defaults, "host model policy is malformed"
    if not isinstance(value, dict):
        return defaults, "host model policy is malformed"
    policy = {**defaults, **value}
    if policy["externalEgress"] not in ("ask-first", "deny", "allow-configured"):
        return defaults, "host model egress setting is invalid"
    if not isinstance(policy["localOnly"], bool):
        return defaults, "host localOnly setting is invalid"
    for field_name in ("extractionEndpointEnv", "embeddingEndpointEnv"):
        env_name = policy[field_name]
        if not isinstance(env_name, str) or not env_name or env_name.strip() != env_name:
            return defaults, f"host {field_name} setting is invalid"
    return policy, None


def _strict_loopback_http_url(value: str) -> bool:
    """Accept only explicit HTTP(S) localhost/127.0.0.1/::1 endpoint URLs."""
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        # Accessing port also validates malformed numeric ports.
        _ = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme in ("http", "https")
        and parsed.username is None
        and parsed.password is None
        and hostname is not None
        and hostname.lower() in ("127.0.0.1", "::1", "localhost")
    )


def _model_egress_denial(policy: dict[str, Any], environ: dict[str, str]) -> str | None:
    if policy["externalEgress"] != "allow-configured":
        return f"externalEgress is {policy['externalEgress']}"
    if policy["localOnly"]:
        for policy_field, description, sdk_env_name in (
            ("extractionEndpointEnv", "chat", "MEMORY_LLM_BASE_URL"),
            ("embeddingEndpointEnv", "embedding", "MEMORY_EMBEDDER_BASE_URL"),
        ):
            for env_name in dict.fromkeys((policy[policy_field], sdk_env_name)):
                endpoint = environ.get(env_name)
                if not endpoint:
                    return f"localOnly requires an explicit loopback {description} endpoint ({env_name})"
                if not _strict_loopback_http_url(endpoint):
                    return f"localOnly requires {description} endpoint ({env_name}) to be HTTP(S) loopback"
        for fallback_name in ("OPENAI_BASE_URL", "LLM_BASE_URL", "EMBEDDING_BASE_URL"):
            fallback = environ.get(fallback_name)
            if fallback and not _strict_loopback_http_url(fallback):
                return f"localOnly rejects non-loopback fallback endpoint ({fallback_name})"
    return None


# ---------------------------------------------------------------------------
# Token resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TokenInfo:
    """Resolved worker token plus a non-secret description of its source."""

    token: str
    source: str


def resolve_token(
    token_file: str | None = None,
    *,
    env: dict[str, str] | None = None,
) -> TokenInfo:
    """Read the bearer token from ``--token-file`` or ``HYMEM_WORKER_TOKEN``."""
    environ = os.environ if env is None else env
    if token_file:
        try:
            with open(token_file, encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError as exc:
            raise ValidationError(
                f"cannot read token file: {exc.strerror or exc}",
                details={"field": "tokenFile"},
            ) from exc
        if not token:
            raise ValidationError("token file is empty", details={"field": "tokenFile"})
        return TokenInfo(token, f"file:{token_file}")
    env_token = (environ.get(TOKEN_ENV) or "").strip()
    if env_token:
        return TokenInfo(env_token, f"env:{TOKEN_ENV}")
    raise ValidationError(
        "no worker token: pass --token-file or set HYMEM_WORKER_TOKEN",
        details={"field": "token"},
    )


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class WorkerServer(ThreadingHTTPServer):
    """Thread-per-request HTTP server carrying the engine and request counters."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        *,
        engine: MemoryEngine,
        token: str,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        selection_reason: str = "",
    ) -> None:
        super().__init__(address, handler)
        self.engine = engine
        self.token = token
        self.request_timeout = request_timeout
        self.selection_reason = selection_reason
        self.started_at = time.monotonic()
        self._counter_lock = threading.Lock()
        self._counters: dict[str, int] = {
            "total": 0,
            "health": 0,
            "ingest": 0,
            "search": 0,
            "get": 0,
            "delete": 0,
            "feedback": 0,
            "metrics": 0,
            "errors": 0,
        }

    def bump(self, name: str, amount: int = 1) -> None:
        """Increment one request counter under the server lock."""
        with self._counter_lock:
            self._counters[name] = self._counters.get(name, 0) + amount

    def snapshot(self) -> dict[str, int]:
        """Return a copy of the request counters."""
        with self._counter_lock:
            return dict(self._counters)

    def uptime_seconds(self) -> float:
        """Seconds since the server was constructed."""
        return time.monotonic() - self.started_at


class WorkerRequestHandler(BaseHTTPRequestHandler):
    """JSON request handler for every ``/v1`` route."""

    server_version = "hymem-worker/0.1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # -- plumbing ------------------------------------------------------

    @property
    def worker(self) -> WorkerServer:
        """Typed access to the carrying server."""
        return self.server  # type: ignore[return-value]

    def setup(self) -> None:
        """Apply the per-connection socket timeout before the first read."""
        super().setup()
        with contextlib.suppress(OSError):  # pragma: no cover - defensive
            self.connection.settimeout(self.worker.request_timeout)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Silence the default stderr access log (we emit redacted lines)."""
        return

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        """Do not let the stdlib log raw request lines (they may hold tokens)."""
        return

    def _log(self, method: str, path: str, status: int, started: float) -> None:
        elapsed_ms = (time.monotonic() - started) * 1000
        LOGGER.info("%s %s -> %s %.1fms", method, redact_text(path), status, elapsed_ms)

    # -- HTTP verbs ----------------------------------------------------

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:
        """Reject preflight: this worker is loopback-only and never CORS-enabled."""
        self._dispatch("OPTIONS")

    # -- dispatch ------------------------------------------------------

    def _dispatch(self, method: str) -> None:
        started = time.monotonic()
        path = urlsplit(self.path).path or "/"
        self.worker.bump("total")
        try:
            if not path.startswith("/v1/"):
                raise EngineError("E_NOT_FOUND", f"unknown path {path}")
            self._require_auth()
            route = self._route_table().get(path)
            if route is None:
                raise EngineError("E_NOT_FOUND", f"unknown path {path}")
            if route.method != method:
                raise EngineError(
                    "E_METHOD_NOT_ALLOWED",
                    f"{path} only accepts {route.method}",
                    details={"allow": route.method},
                )
            if method == "POST":
                body = self._read_json()
            else:
                body = {}
                # A body on a GET must not be parsed as the next pipelined
                # request; drop the connection instead of desyncing keep-alive.
                if (self.headers.get("Content-Length") or "0").strip() not in ("", "0"):
                    self.close_connection = True
            payload = route.handler(self, body)
        except EngineError as exc:
            if exc.code != "E_UNAUTHORIZED":
                self.worker.bump("errors")
            self._send_error(exc, started, method, path)
            return
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return
        except Exception as exc:
            LOGGER.warning(
                "unhandled error on %s %s: %s", method, redact_text(path), type(exc).__name__
            )
            self.worker.bump("errors")
            self._send_error(
                EngineError(
                    "E_INTERNAL",
                    redact_text(f"{type(exc).__name__}: {exc}"),
                ),
                started,
                method,
                path,
            )
            return
        self._send_json(200, payload)
        self._log(method, path, 200, started)

    def _send_error(self, error: EngineError, started: float, method: str, path: str) -> None:
        self._send_json(error.status, error.to_envelope())
        self._log(method, path, error.status, started)

    # -- auth ----------------------------------------------------------

    def _require_auth(self) -> None:
        header = self.headers.get("Authorization") or ""
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not presented:
            raise EngineError("E_UNAUTHORIZED", "missing bearer token")
        expected = self.worker.token
        if not hmac.compare_digest(presented.strip().encode("utf-8"), expected.encode("utf-8")):
            raise EngineError("E_UNAUTHORIZED", "invalid bearer token")

    # -- body ----------------------------------------------------------

    def _read_json(self) -> dict[str, Any]:
        """Read and parse a JSON object body, enforcing the 4 MiB cap."""
        transfer_encoding = (self.headers.get("Transfer-Encoding") or "").strip()
        if transfer_encoding:
            self.close_connection = True
            raise EngineError("E_VALIDATION", "chunked request bodies are not supported")
        raw_length = (self.headers.get("Content-Length") or "0").strip()
        try:
            length = int(raw_length)
        except ValueError as exc:
            self.close_connection = True
            raise EngineError("E_VALIDATION", "invalid Content-Length") from exc
        if length < 0:
            self.close_connection = True
            raise EngineError("E_VALIDATION", "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            # Do not read the oversized body: close so the peer cannot stream it.
            self.close_connection = True
            raise EngineError(
                "E_BUDGET_EXCEEDED",
                f"request body exceeds {MAX_BODY_BYTES} bytes",
                details={"limitBytes": MAX_BODY_BYTES, "receivedBytes": length},
            )
        if length == 0:
            raise EngineError("E_VALIDATION", "request body is required")
        try:
            raw = self.rfile.read(length)
        except TimeoutError as exc:
            self.close_connection = True
            raise EngineError("E_BACKEND_TIMEOUT", "timed out reading request body") from exc
        if len(raw) != length:
            self.close_connection = True
            raise EngineError("E_VALIDATION", "truncated request body")
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EngineError("E_VALIDATION", "request body is not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise EngineError("E_VALIDATION", "request body must be a JSON object")
        return parsed

    # -- responses -----------------------------------------------------

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(redact_value(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        # Deliberately no Access-Control-* headers: this worker never enables CORS.
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
            self.close_connection = True

    # -- routes --------------------------------------------------------

    @staticmethod
    def _route_table() -> dict[str, Route]:
        return {
            "/v1/health": Route("GET", _handle_health),
            "/v1/ingest": Route("POST", _handle_ingest),
            "/v1/search": Route("POST", _handle_search),
            "/v1/get": Route("POST", _handle_get),
            "/v1/delete": Route("POST", _handle_delete),
            "/v1/feedback": Route("POST", _handle_feedback),
            "/v1/metrics": Route("GET", _handle_metrics),
        }


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------


def _handle_health(handler: WorkerRequestHandler, _body: dict[str, Any]) -> dict[str, Any]:
    """Report engine health.

    ``ok`` mirrors :attr:`EngineHealth.ok` (it is ``false`` for a degraded
    engine), while ``degraded``/``reason`` explain why. The HTTP status stays
    ``200``: the worker itself is alive, and the Host branches on the payload.
    """
    server = handler.worker
    server.bump("health")
    health = server.engine.health()
    return health.to_dict(uptime_seconds=server.uptime_seconds())


def _handle_ingest(handler: WorkerRequestHandler, body: dict[str, Any]) -> dict[str, Any]:
    server = handler.worker
    server.bump("ingest")
    request = IngestInput.from_dict(body)
    result = server.engine.ingest(request)
    return {
        "ok": True,
        "engine": server.engine.name,
        "engineMemoryIds": list(result.engine_memory_ids),
        "candidates": [candidate.to_dict() for candidate in result.candidates],
        "elapsedMs": round(result.elapsed_ms, 3),
    }


def _handle_search(handler: WorkerRequestHandler, body: dict[str, Any]) -> dict[str, Any]:
    server = handler.worker
    server.bump("search")
    request = SearchInput.from_dict(body)
    result = server.engine.search(request)
    return {
        "ok": True,
        "results": [hit.to_dict() for hit in result.results],
        "elapsedMs": round(result.elapsed_ms, 3),
    }


def _handle_get(handler: WorkerRequestHandler, body: dict[str, Any]) -> dict[str, Any]:
    server = handler.worker
    server.bump("get")
    engine_id = _require_engine_id(body)
    record = server.engine.get(engine_id)
    if record is None:
        raise EngineError("E_NOT_FOUND", "memory not found", details={"field": "engineMemoryId"})
    return {"ok": True, "text": record.get("text", ""), "metadata": record.get("metadata", {})}


def _handle_delete(handler: WorkerRequestHandler, body: dict[str, Any]) -> dict[str, Any]:
    server = handler.worker
    server.bump("delete")
    engine_id = _require_engine_id(body)
    deleted = server.engine.delete(engine_id)
    return {"ok": True, "deleted": bool(deleted)}


def _handle_feedback(handler: WorkerRequestHandler, body: dict[str, Any]) -> dict[str, Any]:
    server = handler.worker
    server.bump("feedback")
    engine_id = _require_engine_id(body)
    kind = body.get("kind")
    if kind not in FEEDBACK_KINDS:
        raise EngineError(
            "E_VALIDATION",
            f"kind must be one of {list(FEEDBACK_KINDS)}",
            details={"field": "kind"},
        )
    server.engine.feedback(engine_id, str(kind))
    return {"ok": True}


def _handle_metrics(handler: WorkerRequestHandler, _body: dict[str, Any]) -> dict[str, Any]:
    server = handler.worker
    server.bump("metrics")
    engine_metrics = server.engine.metrics()
    counters = server.snapshot()
    calls = dict(engine_metrics.get("calls") or {})
    calls.setdefault("chatCompletions", 0)
    calls.setdefault("embeddings", 0)
    return {
        "ok": True,
        "engine": server.engine.name,
        "calls": calls,
        "tokens": int(engine_metrics.get("tokens") or 0),
        "errors": int(engine_metrics.get("errors") or 0) + int(counters.get("errors") or 0),
        "requests": counters,
    }


def _require_engine_id(body: dict[str, Any]) -> str:
    value = body.get("engineMemoryId")
    if not isinstance(value, str) or not value.strip():
        raise EngineError(
            "E_VALIDATION",
            "engineMemoryId is required",
            details={"field": "engineMemoryId"},
        )
    return value.strip()


# ---------------------------------------------------------------------------
# Lifecycle helpers
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class WorkerConfig:
    """Resolved runtime configuration for one worker process."""

    port: int = DEFAULT_PORT
    token: str = ""
    token_source: str = ""
    engine: str = "auto"
    data_dir: str | None = None
    request_timeout: float = DEFAULT_REQUEST_TIMEOUT
    extra: dict[str, Any] = field(default_factory=dict)


def create_server(config: WorkerConfig) -> tuple[WorkerServer, EngineSelection]:
    """Bind a loopback server on ``config.port`` (``0`` picks a free port)."""
    if not config.token:
        raise ValidationError("worker token must not be empty")
    selection = select_engine(config.engine, data_dir=config.data_dir)
    server = WorkerServer(
        (HOST, int(config.port)),
        WorkerRequestHandler,
        engine=selection.engine,
        token=config.token,
        request_timeout=config.request_timeout,
        selection_reason=selection.reason,
    )
    # The real engine builds its HTTP client lazily: the first embedding call
    # pays ~650 ms of construction, which is most of a recall budget. Pay it
    # here, off the readiness path. The warmup is read-only and non-fatal by
    # construction (HyMemoryEngine.warmup swallows its own errors).
    warmup = getattr(selection.engine, "warmup", None)
    if callable(warmup):
        threading.Thread(target=warmup, name="hymem-warmup", daemon=True).start()
    return server, selection


def serve_forever(server: WorkerServer) -> None:
    """Run the server until :meth:`shutdown` is called (SIGTERM/SIGINT path)."""
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        # Shutdown must never raise: the process is already on its way out.
        with contextlib.suppress(Exception):
            server.engine.close()


__all__ = [
    "DEFAULT_PORT",
    "DEFAULT_REQUEST_TIMEOUT",
    "ENGINE_CHOICES",
    "HOST",
    "MAX_BODY_BYTES",
    "EngineSelection",
    "Route",
    "TokenInfo",
    "WorkerConfig",
    "WorkerRequestHandler",
    "WorkerServer",
    "create_server",
    "resolve_token",
    "select_engine",
    "serve_forever",
]
