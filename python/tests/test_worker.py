"""Offline tests for the HyMemory worker (no network, no model endpoint).

Every test drives the real HTTP surface over ``127.0.0.1`` on an ephemeral port
with a temporary token file and the deterministic :class:`MockEngine`.

Run from the repository root::

    .venv\\Scripts\\python.exe -m pytest python/tests -q
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

import hymem_worker.server as worker_server
from hymem_worker.__main__ import _load_env_file
from hymem_worker.__main__ import main as worker_main
from hymem_worker.engine import EngineError, EngineHealth, IngestInput, SearchInput
from hymem_worker.mock_engine import MockEngine
from hymem_worker.server import (
    MAX_BODY_BYTES,
    WorkerConfig,
    create_server,
    resolve_token,
    select_engine,
    serve_forever,
)

TOKEN = "test-worker-token-0123456789abcdef"
NAMESPACE = "project:11111111-1111-7111-8111-111111111111"


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def token_file(tmp_path: Path) -> Path:
    """A ``0600`` token file, as the installer would create it."""
    path = tmp_path / "worker.token"
    path.write_text(TOKEN, encoding="utf-8")
    path.chmod(0o600)
    return path


@pytest.fixture()
def worker(token_file: Path) -> Iterator[dict[str, Any]]:
    """Start the worker on port 0 in a background thread; yield its coordinates."""
    token_info = resolve_token(str(token_file))
    server, selection = create_server(WorkerConfig(port=0, token=token_info.token, engine="mock"))
    thread = threading.Thread(target=serve_forever, args=(server,), daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield {
            "host": host,
            "port": port,
            "server": server,
            "engine": selection.engine,
            "token": token_info.token,
        }
    finally:
        server.shutdown()
        thread.join(timeout=10)
        server.server_close()


def call(
    worker: dict[str, Any],
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    token: str | None = TOKEN,
    timeout: float = 15.0,
) -> tuple[int, dict[str, str], bytes]:
    """Perform one HTTP call and return ``(status, headers, raw body)``."""
    connection = http.client.HTTPConnection(worker["host"], worker["port"], timeout=timeout)
    headers: dict[str, str] = {}
    payload: bytes | None = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        return response.status, dict(response.getheaders()), raw
    finally:
        connection.close()


def call_json(
    worker: dict[str, Any],
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    token: str | None = TOKEN,
) -> tuple[int, dict[str, Any], bytes]:
    """Like :func:`call` but decode the JSON body."""
    status, _headers, raw = call(worker, method, path, body, token=token)
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except json.JSONDecodeError:  # pragma: no cover - defensive
        parsed = {}
    return status, parsed, raw


def chat_message(content: str) -> dict[str, Any]:
    """One user message in the contract wire shape."""
    return {
        "role": "user",
        "content": content,
        "toolCallId": None,
        "toolName": None,
        "toolCalls": [],
    }


def ingest_chat(worker: dict[str, Any], content: str, job: str = "job-chat") -> dict[str, Any]:
    """POST one chat ingest and return the parsed response."""
    status, body, _raw = call_json(
        worker,
        "POST",
        "/v1/ingest",
        {
            "jobId": job,
            "namespace": NAMESPACE,
            "workspaceId": None,
            "branch": None,
            "scene": "chat",
            "messages": [chat_message(content)],
            "toolOutcomes": [],
            "observedAt": "2026-10-20T12:00:00Z",
        },
    )
    assert status == 200, body
    return body


def coding_ingest_payload() -> dict[str, Any]:
    """A real ``[OI]``-style coding trace: user turn + tool call + tool result."""
    diff = (
        "diff --git a/src/calc.py b/src/calc.py\n"
        "--- a/src/calc.py\n"
        "+++ b/src/calc.py\n"
        "@@ -10,3 +10,4 @@ def divide(a, b):\n"
        "     if b == 0:\n"
        "-        return None\n"
        '+        raise ValueError("b must not be zero")\n'
        "     return a / b\n"
        "exit code: 0\n"
    )
    return {
        "jobId": "job-coding",
        "namespace": NAMESPACE,
        "workspaceId": "demo-repo",
        "branch": "fix/divzero",
        "scene": "coding",
        "messages": [
            {
                "role": "user",
                "content": "Fix the divide-by-zero crash in src/calc.py on branch fix/divzero.",
                "toolCallId": None,
                "toolName": None,
                "toolCalls": [],
            },
            {
                "role": "assistant",
                "content": "I will patch the guard in divide().",
                "toolCallId": None,
                "toolName": None,
                "toolCalls": [
                    {
                        "id": "call_patch_1",
                        "name": "apply_patch",
                        "arguments": json.dumps({"path": "src/calc.py", "branch": "fix/divzero"}),
                    }
                ],
            },
            {
                "role": "tool",
                "content": diff,
                "toolCallId": "call_patch_1",
                "toolName": "apply_patch",
                "toolCalls": [],
            },
        ],
        "toolOutcomes": [
            {"callId": "call_patch_1", "name": "apply_patch", "exitCode": 0, "success": True}
        ],
        "observedAt": "2026-10-20T12:00:00Z",
    }


# ---------------------------------------------------------------------------
# 1. Authentication
# ---------------------------------------------------------------------------


def test_missing_token_is_rejected_with_401(worker: dict[str, Any]) -> None:
    """Every /v1 route requires the bearer token."""
    status, body, _raw = call_json(worker, "GET", "/v1/health", token=None)
    assert status == 401
    assert body["error"]["code"] == "E_UNAUTHORIZED"


def test_wrong_token_is_rejected_with_401(worker: dict[str, Any]) -> None:
    """A wrong token fails the constant-time compare."""
    status, body, _raw = call_json(worker, "GET", "/v1/health", token="not-the-token")
    assert status == 401
    assert body["error"]["code"] == "E_UNAUTHORIZED"
    assert "token" in body["error"]["message"]


def test_valid_token_opens_health(worker: dict[str, Any]) -> None:
    """The right token reaches the handler."""
    status, body, _raw = call_json(worker, "GET", "/v1/health")
    assert status == 200
    assert body["ok"] is True


# ---------------------------------------------------------------------------
# 2. Health
# ---------------------------------------------------------------------------


def test_health_shape_reports_mock_and_degraded(worker: dict[str, Any]) -> None:
    """``/v1/health`` follows the contract field names exactly."""
    status, body, _raw = call_json(worker, "GET", "/v1/health")
    assert status == 200
    assert body["ok"] is True
    assert body["engine"] == "mock"
    assert body["degraded"] is True
    assert body["reason"] == "no model endpoint configured"
    assert body["queueDepth"] == 0
    assert body["embeddingDims"] == 0
    assert body["mode"] == "mock"
    assert isinstance(body["uptimeSeconds"], float)
    assert isinstance(body["engineVersion"], str) and body["engineVersion"]
    assert set(body) == {
        "ok",
        "engine",
        "engineVersion",
        "degraded",
        "reason",
        "queueDepth",
        "embeddingDims",
        "mode",
        "uptimeSeconds",
    }


def test_no_cors_headers_are_emitted(worker: dict[str, Any]) -> None:
    """This worker never enables CORS."""
    _status, headers, _raw = call(worker, "GET", "/v1/health")
    lowered = {key.lower() for key in headers}
    assert not any(key.startswith("access-control-") for key in lowered)
    assert lowered & {"content-type"} == {"content-type"}


def test_options_preflight_is_rejected_without_cors(worker: dict[str, Any]) -> None:
    """``OPTIONS`` is not a supported verb and gains no CORS headers."""
    status, headers, _raw = call(worker, "OPTIONS", "/v1/health")
    assert status == 405
    assert not any(key.lower().startswith("access-control-") for key in headers)


# ---------------------------------------------------------------------------
# 3. Ingest: chat
# ---------------------------------------------------------------------------


def test_ingest_chat_preference_candidate(worker: dict[str, Any]) -> None:
    """A user preference statement becomes a chat/preference candidate."""
    body = ingest_chat(worker, "Please remember I prefer dark mode in the editor.")
    assert body["ok"] is True
    assert body["engine"] == "mock"
    assert len(body["candidates"]) >= 1
    candidate = body["candidates"][0]
    assert candidate["scene"] == "chat"
    assert candidate["kind"] == "preference"
    assert candidate["source"] == "mock"
    assert candidate["engineMemoryId"] in body["engineMemoryIds"]
    assert len(candidate["title"]) <= 120
    assert candidate["claims"]
    claim = candidate["claims"][0]
    assert set(claim) == {"subject", "predicate", "object"}
    assert claim["subject"] == "user"
    assert claim["predicate"] == "prefers"


def test_ingest_assistant_claim_is_low_confidence_hypothesis(worker: dict[str, Any]) -> None:
    """Assistant self-claims are hypotheses with confidence 0.3, never evidence."""
    status, body, _raw = call_json(
        worker,
        "POST",
        "/v1/ingest",
        {
            "jobId": "job-assistant",
            "namespace": NAMESPACE,
            "scene": "chat",
            "messages": [
                {
                    "role": "assistant",
                    "content": "I believe the deployment is already fixed.",
                    "toolCallId": None,
                    "toolName": None,
                    "toolCalls": [],
                }
            ],
            "toolOutcomes": [],
        },
    )
    assert status == 200, body
    hypothesis = [item for item in body["candidates"] if item["kind"] == "hypothesis"]
    assert hypothesis, body
    assert hypothesis[0]["confidence"] == pytest.approx(0.3)
    assert hypothesis[0]["source"] == "model_generated"


def test_ingest_titles_are_capped_at_120_chars(worker: dict[str, Any]) -> None:
    """Titles never exceed the contract's 120-character cap."""
    long_text = "Please remember " + ("the release checklist is long " * 40)
    body = ingest_chat(worker, long_text, job="job-long")
    assert body["candidates"]
    for candidate in body["candidates"]:
        assert len(candidate["title"]) <= 120


# ---------------------------------------------------------------------------
# 4. Ingest: coding
# ---------------------------------------------------------------------------


def test_ingest_coding_with_tool_trace_returns_file_path(worker: dict[str, Any]) -> None:
    """A tool trace yields a coding candidate carrying the touched file path."""
    status, body, _raw = call_json(worker, "POST", "/v1/ingest", coding_ingest_payload())
    assert status == 200, body
    coding = [item for item in body["candidates"] if item["scene"] == "coding"]
    assert coding, body["candidates"]
    candidate = coding[0]
    assert candidate["kind"] == "experience"
    assert "src/calc.py" in candidate["text"]
    assert "passed" in candidate["text"]
    # The touched-file list is normalized to repo-relative paths (git's a//b/
    # prefixes dropped, one entry per file). The verbatim diff that follows is
    # evidence and keeps its own markers untouched.
    assert "files: src/calc.py diff:" in candidate["text"]
    assert "files: a/src/calc.py" not in candidate["text"]
    assert candidate["confidence"] >= 0.8
    claim_subjects = {claim["subject"] for claim in candidate["claims"]}
    assert "src/calc.py" in claim_subjects


def test_ingest_coding_without_tool_trace_skips_coding(worker: dict[str, Any]) -> None:
    """``scene='coding'`` without a tool message produces no coding candidate."""
    payload = coding_ingest_payload()
    payload["jobId"] = "job-coding-no-tool"
    payload["messages"] = [payload["messages"][0]]
    payload["toolOutcomes"] = []
    status, body, _raw = call_json(worker, "POST", "/v1/ingest", payload)
    assert status == 200, body
    assert not [item for item in body["candidates"] if item["scene"] in ("coding", "working")]


def test_ingest_rejects_unknown_scene(worker: dict[str, Any]) -> None:
    """An out-of-vocabulary scene is a validation error."""
    payload = coding_ingest_payload()
    payload["scene"] = "planning"
    status, body, _raw = call_json(worker, "POST", "/v1/ingest", payload)
    assert status == 400
    assert body["error"]["code"] == "E_VALIDATION"


# ---------------------------------------------------------------------------
# 5. Search and allowIds
# ---------------------------------------------------------------------------


def _seed_two_preferences(worker: dict[str, Any]) -> tuple[str, str]:
    first = ingest_chat(worker, "Please remember I prefer tabs over spaces.", job="job-a")
    second = ingest_chat(worker, "Please remember I prefer spaces over tabs.", job="job-b")
    return (
        first["candidates"][0]["engineMemoryId"],
        second["candidates"][0]["engineMemoryId"],
    )


def test_search_honours_allow_ids(worker: dict[str, Any]) -> None:
    """An id outside ``allowIds`` is never returned (defence in depth)."""
    allowed_id, denied_id = _seed_two_preferences(worker)
    status, body, _raw = call_json(
        worker,
        "POST",
        "/v1/search",
        {
            "namespace": NAMESPACE,
            "query": "prefer tabs spaces",
            "scene": "chat",
            "limit": 20,
            "allowIds": [allowed_id],
        },
    )
    assert status == 200, body
    returned = {hit["engineMemoryId"] for hit in body["results"]}
    assert returned <= {allowed_id}
    assert denied_id not in returned
    for hit in body["results"]:
        assert hit["governanceId"] in {allowed_id}
        assert set(hit) == {
            "engineMemoryId",
            "governanceId",
            "text",
            "score",
            "scene",
            "kind",
            "chainBlock",
        }


def test_search_without_allow_ids_returns_matches(worker: dict[str, Any]) -> None:
    """Omitting ``allowIds`` returns every lexical match in the namespace."""
    first, second = _seed_two_preferences(worker)
    status, body, _raw = call_json(
        worker,
        "POST",
        "/v1/search",
        {"namespace": NAMESPACE, "query": "prefer tabs spaces", "limit": 20},
    )
    assert status == 200, body
    returned = {hit["engineMemoryId"] for hit in body["results"]}
    assert {first, second} <= returned
    assert body["elapsedMs"] >= 0


def test_search_is_namespace_scoped(worker: dict[str, Any]) -> None:
    """Memories never leak across namespaces."""
    ingest_chat(worker, "Please remember I prefer dark mode.")
    status, body, _raw = call_json(
        worker,
        "POST",
        "/v1/search",
        {
            "namespace": "project:22222222-2222-7222-8222-222222222222",
            "query": "prefer dark mode",
        },
    )
    assert status == 200, body
    assert body["results"] == []


# ---------------------------------------------------------------------------
# 6. get / delete / feedback
# ---------------------------------------------------------------------------


def test_get_then_delete_roundtrip(worker: dict[str, Any]) -> None:
    """``/v1/get`` reads a memory and ``/v1/delete`` removes it."""
    body = ingest_chat(worker, "Please remember I prefer dark mode.", job="job-roundtrip")
    engine_id = body["candidates"][0]["engineMemoryId"]

    status, fetched, _raw = call_json(worker, "POST", "/v1/get", {"engineMemoryId": engine_id})
    assert status == 200
    assert fetched["ok"] is True
    assert "dark mode" in fetched["text"]
    assert fetched["metadata"]["engineMemoryId"] == engine_id
    assert fetched["metadata"]["governanceId"] == engine_id

    status, deleted, _raw = call_json(worker, "POST", "/v1/delete", {"engineMemoryId": engine_id})
    assert status == 200
    assert deleted == {"ok": True, "deleted": True}

    status, missing, _raw = call_json(worker, "POST", "/v1/get", {"engineMemoryId": engine_id})
    assert status == 404
    assert missing["error"]["code"] == "E_NOT_FOUND"


def test_feedback_accepts_known_kinds_only(worker: dict[str, Any]) -> None:
    """``/v1/feedback`` validates the kind vocabulary."""
    body = ingest_chat(worker, "Please remember I prefer dark mode.", job="job-feedback")
    engine_id = body["candidates"][0]["engineMemoryId"]
    status, accepted, _raw = call_json(
        worker,
        "POST",
        "/v1/feedback",
        {"engineMemoryId": engine_id, "kind": "useful"},
    )
    assert status == 200
    assert accepted == {"ok": True}

    status, rejected, _raw = call_json(
        worker,
        "POST",
        "/v1/feedback",
        {"engineMemoryId": engine_id, "kind": "amazing"},
    )
    assert status == 400
    assert rejected["error"]["code"] == "E_VALIDATION"


# ---------------------------------------------------------------------------
# 7. Metrics
# ---------------------------------------------------------------------------


def test_metrics_counts_requests(worker: dict[str, Any]) -> None:
    """``/v1/metrics`` reports the contract counters plus request tallies."""
    ingest_chat(worker, "Please remember I prefer dark mode.", job="job-metrics")
    call_json(worker, "POST", "/v1/search", {"namespace": NAMESPACE, "query": "dark mode"})
    status, body, _raw = call_json(worker, "GET", "/v1/metrics")
    assert status == 200
    assert body["ok"] is True
    assert set(body["calls"]) == {"chatCompletions", "embeddings"}
    assert isinstance(body["tokens"], int)
    assert isinstance(body["errors"], int)
    assert body["requests"]["ingest"] == 1
    assert body["requests"]["search"] == 1
    assert body["requests"]["total"] >= 2


# ---------------------------------------------------------------------------
# 8. Transport limits and errors
# ---------------------------------------------------------------------------


def _read_http_response(sock: socket.socket) -> tuple[bytes, bytes]:
    """Read one HTTP response from a raw socket; return ``(head, body)``."""
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buffer += chunk
    head, _, body = buffer.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n"):
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value.strip() or 0)
    while len(body) < length:
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    return head, body


def test_oversized_body_is_rejected(worker: dict[str, Any]) -> None:
    """A body over 4 MiB is refused with ``E_BUDGET_EXCEEDED`` before reading."""
    request = (
        "POST /v1/ingest HTTP/1.1\r\n"
        f"Host: {worker['host']}\r\n"
        f"Authorization: Bearer {TOKEN}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {MAX_BODY_BYTES + 1}\r\n"
        "\r\n"
    ).encode("ascii")
    with socket.create_connection((worker["host"], worker["port"]), timeout=10) as sock:
        sock.sendall(request)
        head, payload = _read_http_response(sock)
    assert b" 413 " in head.split(b"\r\n")[0]
    decoded = json.loads(payload.decode("utf-8"))
    assert decoded["error"]["code"] == "E_BUDGET_EXCEEDED"
    assert decoded["error"]["details"]["limitBytes"] == MAX_BODY_BYTES


def test_unknown_route_and_wrong_method(worker: dict[str, Any]) -> None:
    """Unknown paths are 404; a known path with the wrong verb is 405."""
    status, body, _raw = call_json(worker, "GET", "/v1/nope")
    assert status == 404
    assert body["error"]["code"] == "E_NOT_FOUND"

    status, body, _raw = call_json(worker, "GET", "/v1/ingest")
    assert status == 405
    assert body["error"]["code"] == "E_METHOD_NOT_ALLOWED"


def test_invalid_json_body_is_rejected(worker: dict[str, Any]) -> None:
    """Malformed JSON is a validation error, not a crash."""
    connection = http.client.HTTPConnection(worker["host"], worker["port"], timeout=10)
    try:
        connection.request(
            "POST",
            "/v1/search",
            body=b"{not json",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        assert response.status == 400
        assert body["error"]["code"] == "E_VALIDATION"
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# 9. Secret redaction
# ---------------------------------------------------------------------------


def test_secret_never_appears_in_responses(worker: dict[str, Any]) -> None:
    """An API key in the captured message is redacted before it is returned."""
    secret = "sk-live-abcdefghijklmnopqrstuvwx012345"
    status, body, raw = call_json(
        worker,
        "POST",
        "/v1/ingest",
        {
            "jobId": "job-secret",
            "namespace": NAMESPACE,
            "scene": "chat",
            "messages": [
                chat_message(f"Please remember the deploy key is {secret} and keep it safe.")
            ],
            "toolOutcomes": [],
        },
    )
    assert status == 200, body
    assert secret.encode("utf-8") not in raw
    assert "sk-live" not in raw.decode("utf-8")
    assert "[REDACTED:openai_key]" in raw.decode("utf-8")

    engine_id = body["candidates"][0]["engineMemoryId"]
    _status, fetched, fetch_raw = call_json(
        worker, "POST", "/v1/get", {"engineMemoryId": engine_id}
    )
    assert secret.encode("utf-8") not in fetch_raw
    assert "sk-" not in json.dumps(fetched)


# ---------------------------------------------------------------------------
# 10. Engine selection and degraded hy-memory engine
# ---------------------------------------------------------------------------


def test_select_engine_auto_prefers_mock_without_endpoint() -> None:
    """``auto`` picks the mock when no model endpoint is configured."""
    selection = select_engine("auto", env={})
    assert selection.engine.name == "mock"
    assert "no model endpoint" in selection.reason


def test_select_engine_auto_does_not_allow_egress_from_endpoint_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured endpoint is not permission to construct the SDK engine."""
    constructed = False

    def forbidden_constructor(**_kwargs: Any) -> Any:
        nonlocal constructed
        constructed = True
        raise AssertionError("SDK engine constructor must not run without policy approval")

    monkeypatch.setattr(worker_server, "HyMemoryEngine", forbidden_constructor)
    selection = select_engine(
        "auto",
        env={
            "MEMORY_LLM_BASE_URL": "https://api.example.com/v1",
            "OPENAI_API_KEY": "synthetic-test-key",
        },
    )
    assert selection.engine.name == "mock"
    assert "egress" in selection.reason
    assert constructed is False


def test_select_engine_allows_local_sdk_only_after_both_endpoints_are_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An approved localOnly policy validates both endpoints before construction."""
    policy = {
        "externalEgress": "allow-configured",
        "localOnly": True,
        "extractionEndpointEnv": "MEMORY_LLM_BASE_URL",
        "embeddingEndpointEnv": "MEMORY_EMBEDDER_BASE_URL",
    }
    constructed: list[dict[str, Any]] = []

    class FakeHyEngine:
        name = "hy-memory"

        def __init__(self, **kwargs: Any) -> None:
            constructed.append(kwargs)

    monkeypatch.setattr(worker_server, "HyMemoryEngine", FakeHyEngine)
    selection = select_engine(
        "auto",
        env={
            "HYMEM_MODEL_POLICY": json.dumps(policy),
            "MEMORY_LLM_BASE_URL": "http://127.0.0.1:9000/v1",
            "MEMORY_EMBEDDER_BASE_URL": "https://[::1]:9001/v1",
        },
    )
    assert selection.engine.name == "hy-memory"
    assert constructed == [{"data_dir": None}]


def test_local_only_rejects_missing_or_public_endpoint_before_sdk_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A partial or public endpoint fails closed for auto and explicit hy."""
    policy = {
        "externalEgress": "allow-configured",
        "localOnly": True,
        "extractionEndpointEnv": "MEMORY_LLM_BASE_URL",
        "embeddingEndpointEnv": "MEMORY_EMBEDDER_BASE_URL",
    }

    def forbidden_constructor(**_kwargs: Any) -> Any:
        raise AssertionError("SDK engine constructor must not run for an invalid localOnly endpoint")

    monkeypatch.setattr(worker_server, "HyMemoryEngine", forbidden_constructor)
    env = {
        "HYMEM_MODEL_POLICY": json.dumps(policy),
        "MEMORY_LLM_BASE_URL": "https://api.example.com/v1",
        "MEMORY_EMBEDDER_BASE_URL": "http://127.0.0.1:9001/v1",
    }
    selection = select_engine("auto", env=env)
    assert selection.engine.name == "mock"
    assert "loopback" in selection.reason
    with pytest.raises(EngineError) as excinfo:
        select_engine("hy", env=env)
    assert excinfo.value.code == "E_FORBIDDEN"


def test_external_egress_requires_explicit_allow_configured_setting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """External configured endpoints are usable only after explicit opt-in."""
    constructed = 0

    class FakeHyEngine:
        name = "hy-memory"

        def __init__(self, **_kwargs: Any) -> None:
            nonlocal constructed
            constructed += 1

    monkeypatch.setattr(worker_server, "HyMemoryEngine", FakeHyEngine)
    env = {
        "HYMEM_MODEL_POLICY": json.dumps({
            "externalEgress": "allow-configured",
            "localOnly": False,
            "extractionEndpointEnv": "MEMORY_LLM_BASE_URL",
            "embeddingEndpointEnv": "MEMORY_EMBEDDER_BASE_URL",
        }),
        "MEMORY_LLM_BASE_URL": "https://chat.example.com/v1",
        "MEMORY_EMBEDDER_BASE_URL": "https://embed.example.com/v1",
    }
    selection = select_engine("auto", env=env)
    assert selection.engine.name == "hy-memory"
    assert constructed == 1


def test_local_only_requires_the_sdk_actual_chat_and_embedding_environment_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Custom policy key names cannot hide missing SDK base URL configuration."""
    policy = {
        "externalEgress": "allow-configured",
        "localOnly": True,
        "extractionEndpointEnv": "CUSTOM_CHAT_URL",
        "embeddingEndpointEnv": "CUSTOM_EMBED_URL",
    }

    def forbidden_constructor(**_kwargs: Any) -> Any:
        raise AssertionError("SDK engine must not be constructed when its actual endpoint keys are absent")

    monkeypatch.setattr(worker_server, "HyMemoryEngine", forbidden_constructor)
    selection = select_engine(
        "auto",
        env={
            "HYMEM_MODEL_POLICY": json.dumps(policy),
            "CUSTOM_CHAT_URL": "http://127.0.0.1:9000/v1",
            "CUSTOM_EMBED_URL": "http://127.0.0.1:9001/v1",
        },
    )
    assert selection.engine.name == "mock"
    assert "MEMORY_LLM_BASE_URL" in selection.reason


@pytest.mark.parametrize("policy_key", ["HYMEM_MODEL_POLICY", "hymem_model_policy", "HyMem_Model_Policy"])
def test_env_file_cannot_set_the_host_owned_model_policy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, policy_key: str
) -> None:
    """An env file may carry SDK env but never grants host-level egress permission."""
    monkeypatch.delenv("HYMEM_MODEL_POLICY", raising=False)
    path = tmp_path / "policy.env"
    monkeypatch.delenv(policy_key, raising=False)
    path.write_text(f'{policy_key}={{"externalEgress":"allow-configured"}}\n', encoding="utf-8")
    assert _load_env_file(str(path)) == 0
    assert "HYMEM_MODEL_POLICY" not in os.environ


def test_explicit_hy_policy_refusal_is_reported_without_traceback(
    monkeypatch: pytest.MonkeyPatch, token_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI renders the typed egress refusal as a normal startup error."""
    monkeypatch.delenv("HYMEM_MODEL_POLICY", raising=False)
    original_stdout = sys.stdout
    try:
        result = worker_main(["--engine", "hy", "--token-file", str(token_file)])
    finally:
        sys.stdout = original_stdout
    assert result == 2
    captured = capsys.readouterr()
    assert "E_FORBIDDEN" in captured.err
    assert "Traceback" not in captured.err


def test_hy_engine_reports_degraded_when_sdk_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A missing SDK degrades health instead of crashing the worker."""
    import hymem_worker.hy_engine as hy_engine

    monkeypatch.setitem(sys.modules, "hy_memory", None)
    engine = hy_engine.HyMemoryEngine()
    health = engine.health()
    assert health.ok is False
    assert health.degraded is True
    assert health.engine == "hy-memory"
    assert health.reason is not None
    assert "hy_memory import failed" in health.reason
    with pytest.raises(EngineError) as excinfo:
        engine.ingest(
            IngestInput.from_dict(
                {
                    "jobId": "job-degraded",
                    "namespace": NAMESPACE,
                    "scene": "chat",
                    "messages": [chat_message("Please remember I prefer dark mode.")],
                }
            )
        )
    assert excinfo.value.code == "E_BACKEND_UNAVAILABLE"
    assert excinfo.value.status == 503
    engine.close()


def test_server_maps_degraded_engine_to_503(
    monkeypatch: pytest.MonkeyPatch, token_file: Path
) -> None:
    """A fake degraded SDK engine maps its backend error to HTTP 503."""
    class FakeDegradedEngine:
        name = "hy-memory"

        def __init__(self, **_kwargs: Any) -> None:
            pass

        def warmup(self) -> None:
            pass

        def health(self) -> EngineHealth:
            return EngineHealth(
                ok=False,
                engine="hy-memory",
                engine_version="test",
                degraded=True,
                reason="synthetic SDK unavailable",
            )

        def ingest(self, _request: IngestInput) -> Any:
            raise EngineError(
                "E_BACKEND_UNAVAILABLE",
                "synthetic SDK unavailable",
                details={"engine": "hy-memory"},
            )

        def close(self) -> None:
            pass

    monkeypatch.setattr(worker_server, "HyMemoryEngine", FakeDegradedEngine)
    monkeypatch.setenv(
        "HYMEM_MODEL_POLICY",
        json.dumps({
            "externalEgress": "allow-configured",
            "localOnly": False,
            "extractionEndpointEnv": "MEMORY_LLM_BASE_URL",
            "embeddingEndpointEnv": "MEMORY_EMBEDDER_BASE_URL",
        }),
    )
    monkeypatch.setenv("MEMORY_LLM_BASE_URL", "http://127.0.0.1:9000/v1")
    monkeypatch.setenv("MEMORY_EMBEDDER_BASE_URL", "http://127.0.0.1:9001/v1")
    token_info = resolve_token(str(token_file))
    server, selection = create_server(WorkerConfig(port=0, token=token_info.token, engine="hy"))
    thread = threading.Thread(target=serve_forever, args=(server,), daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    worker = {"host": host, "port": port}
    try:
        status, body, _raw = call_json(worker, "GET", "/v1/health")
        assert status == 200
        assert body["engine"] == "hy-memory"
        assert body["degraded"] is True
        assert "synthetic SDK unavailable" in body["reason"]

        status, body, _raw = call_json(worker, "POST", "/v1/ingest", coding_ingest_payload())
        assert status == 503
        assert body["error"]["code"] == "E_BACKEND_UNAVAILABLE"
        assert body["error"]["details"]["engine"] == "hy-memory"
    finally:
        server.shutdown()
        thread.join(timeout=10)
        server.server_close()
        selection.engine.close()


# ---------------------------------------------------------------------------
# 11. Engine-level unit checks (no HTTP)
# ---------------------------------------------------------------------------


def test_mock_engine_search_filters_allow_ids_directly() -> None:
    """``MockEngine.search`` itself enforces ``allowIds``."""
    engine = MockEngine()
    first = engine.ingest(
        IngestInput.from_dict(
            {
                "jobId": "job-1",
                "namespace": NAMESPACE,
                "scene": "chat",
                "messages": [chat_message("Please remember I prefer dark mode.")],
            }
        )
    )
    second = engine.ingest(
        IngestInput.from_dict(
            {
                "jobId": "job-2",
                "namespace": NAMESPACE,
                "scene": "chat",
                "messages": [chat_message("Please remember I prefer light mode.")],
            }
        )
    )
    allowed = first.engine_memory_ids[0]
    denied = second.engine_memory_ids[0]
    result = engine.search(
        SearchInput.from_dict(
            {
                "namespace": NAMESPACE,
                "query": "prefer dark light mode",
                "limit": 10,
                "allowIds": [allowed],
            }
        )
    )
    ids = {hit.engine_memory_id for hit in result.results}
    assert ids == {allowed}
    assert denied not in ids
    engine.close()


def test_mock_engine_is_deterministic() -> None:
    """The same envelope always yields the same ids and candidates."""
    payload = {
        "jobId": "job-deterministic",
        "namespace": NAMESPACE,
        "scene": "chat",
        "messages": [chat_message("Please remember I prefer dark mode.")],
    }
    first_engine = MockEngine()
    second_engine = MockEngine()
    try:
        first = first_engine.ingest(IngestInput.from_dict(payload))
        second = second_engine.ingest(IngestInput.from_dict(payload))
        assert first.engine_memory_ids == second.engine_memory_ids
        assert [item.to_dict() for item in first.candidates] == [
            item.to_dict() for item in second.candidates
        ]
    finally:
        first_engine.close()
        second_engine.close()


def test_worker_startup_is_fast(worker: dict[str, Any]) -> None:
    """The loopback listener is bound on 127.0.0.1 before the first request."""
    assert worker["host"] == "127.0.0.1"
    assert worker["port"] > 0
    started = time.monotonic()
    status, _body, _raw = call_json(worker, "GET", "/v1/health")
    assert status == 200
    assert time.monotonic() - started < 5.0


# ---------------------------------------------------------------------------
# 12. Spawn protocol: exactly one JSON line on stdout
# ---------------------------------------------------------------------------


def test_module_entry_prints_one_json_line_and_serves(token_file: Path, tmp_path: Path) -> None:
    """``python -m hymem_worker`` announces ``{port, tokenSource, engine}``."""
    repo_root = Path(__file__).resolve().parents[2]
    port_file = tmp_path / "port.txt"
    env = dict(os.environ)
    env["PYTHONPATH"] = str(repo_root / "python")
    env.pop("MEMORY_LLM_BASE_URL", None)
    env.pop("OPENAI_API_KEY", None)
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "hymem_worker",
            "--port",
            "0",
            "--engine",
            "mock",
            "--token-file",
            str(token_file),
            "--port-file",
            str(port_file),
        ],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        assert process.stdout is not None
        line = process.stdout.readline()
        ready = json.loads(line)
        assert set(ready) == {"port", "tokenSource", "engine"}
        assert ready["engine"] == "mock"
        assert ready["tokenSource"] == f"file:{token_file}"
        assert isinstance(ready["port"], int) and ready["port"] > 0
        assert port_file.read_text(encoding="utf-8").strip() == str(ready["port"])

        # The announced port really serves, with the file's token.
        status, body, _raw = call_json(
            {"host": "127.0.0.1", "port": ready["port"]}, "GET", "/v1/health"
        )
        assert status == 200
        assert body["engine"] == "mock"
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            process.kill()
            process.wait(timeout=5)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()
    assert process.returncode is not None
