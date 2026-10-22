"""Transport-neutral engine protocol for the DSH HyMemory worker.

This module owns the vocabulary shared by :mod:`hymem_worker.mock_engine` and
:mod:`hymem_worker.hy_engine`: the request/response dataclasses, the engine
protocol, the structured error type and the redaction helpers.

Design rules (see ``docs/internal/API_CONTRACT.md`` section 1):

* The worker never decides trust. It returns *candidates*; the Host anchors
  each candidate to evidence and owns the governance status.
* Every string that leaves the worker is redacted first. The Host redacts too,
  but defence in depth is cheap here.
* Nothing in this module imports the ``hy_memory`` SDK, so importing the worker
  package never pulls in a model stack.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

SOURCE_ID = "dsh-hy-memory"
MAX_TITLE_CHARS = 120

SCENES: tuple[str, ...] = ("chat", "working", "coding")
KINDS: tuple[str, ...] = (
    "fact",
    "preference",
    "decision",
    "experience",
    "failure",
    "todo",
    "hypothesis",
)
FEEDBACK_KINDS: tuple[str, ...] = ("useful", "incorrect", "stale")
ROLES: tuple[str, ...] = ("user", "assistant", "tool")

Scene = Literal["chat", "working", "coding"]
MemoryKind = Literal[
    "fact",
    "preference",
    "decision",
    "experience",
    "failure",
    "todo",
    "hypothesis",
]

#: Structured error codes shared with ``packages/contracts/src/index.ts``.
ERROR_STATUS: dict[str, int] = {
    "E_VALIDATION": 400,
    "E_UNAUTHORIZED": 401,
    "E_FORBIDDEN": 403,
    "E_NOT_FOUND": 404,
    "E_METHOD_NOT_ALLOWED": 405,
    "E_CONFLICT": 409,
    "E_BUDGET_EXCEEDED": 413,
    "E_BACKEND_TIMEOUT": 504,
    "E_BACKEND_UNAVAILABLE": 503,
    "E_INTERNAL": 500,
}


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class EngineError(RuntimeError):
    """Structured engine failure; the HTTP server renders it as the contract
    error envelope ``{"error": {"code", "message", "details"?}}``."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    @property
    def status(self) -> int:
        """HTTP status that matches this error code."""
        return ERROR_STATUS.get(self.code, 500)

    def to_envelope(self) -> dict[str, Any]:
        """Render the contract error envelope."""
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return {"error": error}


class ValidationError(EngineError):
    """Request payload failed validation (HTTP 400)."""

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__("E_VALIDATION", message, details=details)


# ---------------------------------------------------------------------------
# Redaction (mirrors packages/governance/src/redact.ts)
# ---------------------------------------------------------------------------

REDACTION_MARKER = "[REDACTED:{kind}]"

_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "private_key",
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"
            r"[\s\S]*?"
            r"-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"
        ),
    ),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b")),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    ),
    ("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE)),
    (
        "env_secret",
        re.compile(
            r"^\s*(?:export\s+)?[A-Z0-9_]*"
            r"(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)"
            r"[A-Z0-9_]*\s*=\s*(?!\[REDACTED)"
            r"(?:\"[^\"\n]*\"|'[^'\n]*'|[^\s#\n]+)",
            re.MULTILINE,
        ),
    ),
    (
        "credential_url",
        re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@[^\s]+", re.IGNORECASE),
    ),
)


def redact_text(text: str) -> str:
    """Replace every detected secret with a constant ``[REDACTED:<kind>]`` marker."""
    if not text:
        return text
    redacted = text
    for kind, pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(REDACTION_MARKER.format(kind=kind), redacted)
    return redacted


def contains_secret(text: str) -> bool:
    """True when ``text`` holds at least one detectable secret."""
    return any(pattern.search(text) for _kind, pattern in _SECRET_PATTERNS)


def redact_value(value: Any) -> Any:
    """Recursively redact strings inside a JSON-compatible value."""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, (list, tuple)):
        return [redact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_value(item) for key, item in value.items()}
    return value


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

_WHITESPACE_RE = re.compile(r"\s+")
# Sentence terminators: ASCII plus the CJK full stops (kept as escapes so the
# source stays unambiguous under RUF001).
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?\u3002\uff01\uff1f])\s+|\n+")
_WORD_RE = re.compile(r"[a-z0-9_]+(?:[./:-][a-z0-9_]+)*", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")
_PATH_RE = re.compile(
    r"[A-Za-z0-9_./\\-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|toml|ini|cfg|"
    r"ya?ml|go|rs|java|kt|kts|cs|cc|cpp|cxx|h|hpp|sh|bash|ps1|psm1|sql|css|scss|html|"
    r"vue|svelte|rb|php|swift|scala|lua|pl|txt|lock)",
    re.IGNORECASE,
)

_STOPWORDS: frozenset[str] = frozenset(
    (
        "a",
        "about",
        "all",
        "also",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "been",
        "being",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "done",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "him",
        "his",
        "how",
        "i",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "many",
        "may",
        "me",
        "might",
        "more",
        "most",
        "much",
        "my",
        "no",
        "not",
        "note",
        "noted",
        "of",
        "on",
        "or",
        "our",
        "please",
        "remember",
        "shall",
        "she",
        "should",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "to",
        "user",
        "users",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "yes",
        "you",
        "your",
    )
)


def collapse_whitespace(text: str) -> str:
    """Collapse runs of whitespace into single spaces."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def truncate_title(text: str, limit: int = MAX_TITLE_CHARS) -> str:
    """Collapse whitespace and cut to ``limit`` characters, adding an ellipsis."""
    title = collapse_whitespace(text)
    if len(title) <= limit:
        return title
    return title[: max(0, limit - 3)].rstrip() + "..."


def first_sentence(text: str) -> str:
    """Return the first sentence-like fragment of ``text``."""
    cleaned = collapse_whitespace(text)
    if not cleaned:
        return ""
    parts = _SENTENCE_SPLIT_RE.split(cleaned, maxsplit=1)
    return parts[0].strip() if parts else cleaned


def tokenize(text: str) -> list[str]:
    """Lowercase lexical tokens; CJK runs become character bigrams."""
    lowered = text.lower()
    tokens: list[str] = []
    for match in _WORD_RE.finditer(lowered):
        token = match.group(0)
        if len(token) < 2 or token in _STOPWORDS:
            continue
        tokens.append(token)
    for match in _CJK_RE.finditer(text):
        run = match.group(0)
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
    return tokens


def extract_paths(text: str) -> list[str]:
    """Extract file-path-like tokens from ``text`` (first occurrence order)."""
    seen: set[str] = set()
    paths: list[str] = []
    for match in _PATH_RE.finditer(text):
        path = match.group(0).replace("\\", "/").lstrip("./")
        if not path or path in seen:
            continue
        seen.add(path)
        paths.append(path)
    return paths


def stable_digest(*parts: str) -> str:
    """Deterministic short digest over the given parts."""
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()
    return digest[:16]


# ---------------------------------------------------------------------------
# Dataclasses: engine health and results
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EngineHealth:
    """Engine liveness/readiness, rendered as ``GET /v1/health``."""

    ok: bool
    engine: str
    engine_version: str
    degraded: bool
    reason: str | None = None
    queue_depth: int = 0
    embedding_dims: int = 0
    mode: str = "pro"

    def to_dict(self, *, uptime_seconds: float) -> dict[str, Any]:
        """Serialize with the contract field names."""
        return {
            "ok": self.ok,
            "engine": self.engine,
            "engineVersion": self.engine_version,
            "degraded": self.degraded,
            "reason": self.reason,
            "queueDepth": self.queue_depth,
            "embeddingDims": self.embedding_dims,
            "mode": self.mode,
            "uptimeSeconds": round(float(uptime_seconds), 3),
        }


@dataclass(frozen=True, slots=True)
class ClaimDraft:
    """A ``(subject, predicate, object)`` triple the Host may anchor."""

    subject: str
    predicate: str
    object: str

    def to_dict(self) -> dict[str, str]:
        return {
            "subject": self.subject,
            "predicate": self.predicate,
            "object": self.object,
        }


@dataclass(frozen=True, slots=True)
class Candidate:
    """One memory candidate extracted by an engine."""

    scene: str
    kind: str
    title: str
    text: str
    claims: tuple[ClaimDraft, ...]
    confidence: float
    engine_memory_id: str
    source: str

    def to_dict(self) -> dict[str, Any]:
        """Serialize with the contract field names."""
        return {
            "scene": self.scene,
            "kind": self.kind,
            "title": self.title,
            "text": self.text,
            "claims": [claim.to_dict() for claim in self.claims],
            "confidence": round(float(self.confidence), 3),
            "engineMemoryId": self.engine_memory_id,
            "source": self.source,
        }


@dataclass(frozen=True, slots=True)
class SearchHit:
    """One recall hit returned by an engine."""

    engine_memory_id: str
    governance_id: str | None
    text: str
    score: float
    scene: str
    kind: str
    chain_block: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize with the contract field names."""
        return {
            "engineMemoryId": self.engine_memory_id,
            "governanceId": self.governance_id,
            "text": self.text,
            "score": round(float(self.score), 6),
            "scene": self.scene,
            "kind": self.kind,
            "chainBlock": self.chain_block,
        }


@dataclass(frozen=True, slots=True)
class IngestResult:
    """Engine output for ``POST /v1/ingest``."""

    engine_memory_ids: tuple[str, ...] = ()
    candidates: tuple[Candidate, ...] = ()
    elapsed_ms: float = 0.0


@dataclass(frozen=True, slots=True)
class SearchResult:
    """Engine output for ``POST /v1/search``."""

    results: tuple[SearchHit, ...] = ()
    elapsed_ms: float = 0.0


# ---------------------------------------------------------------------------
# Dataclasses: request payloads
# ---------------------------------------------------------------------------


def _as_text(value: Any, *, field_name: str, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    raise ValidationError(f"{field_name} must be a string", details={"field": field_name})


def _optional_text(value: Any, *, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(
            f"{field_name} must be a string or null", details={"field": field_name}
        )
    stripped = value.strip()
    return stripped or None


def _as_dict(value: Any, *, field_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{field_name} must be an object", details={"field": field_name})
    return value


def _as_list(value: Any, *, field_name: str) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError(f"{field_name} must be an array", details={"field": field_name})
    return value


@dataclass(frozen=True, slots=True)
class ToolCall:
    """An ``assistant.tool_calls[]`` entry (``[OI]`` wire shape)."""

    id: str
    name: str
    arguments: str = ""

    @classmethod
    def from_dict(cls, payload: Any) -> ToolCall:
        """Parse one tool call, accepting both ``[OI]`` and flat shapes."""
        if not isinstance(payload, dict):
            raise ValidationError("toolCalls entries must be objects")
        function = payload.get("function")
        if isinstance(function, dict):
            name = _as_text(function.get("name"), field_name="toolCalls[].function.name")
            arguments = function.get("arguments")
        else:
            name = _as_text(payload.get("name"), field_name="toolCalls[].name")
            arguments = payload.get("arguments")
        if isinstance(arguments, (dict, list)):
            arguments = json.dumps(arguments, ensure_ascii=False)
        elif arguments is None:
            arguments = ""
        else:
            arguments = _as_text(arguments, field_name="toolCalls[].arguments")
        return cls(
            id=_as_text(payload.get("id"), field_name="toolCalls[].id"),
            name=name,
            arguments=arguments,
        )

    def argument_path(self) -> str | None:
        """Best-effort ``path`` value from the JSON argument string."""
        if not self.arguments:
            return None
        try:
            parsed = json.loads(self.arguments)
        except (TypeError, ValueError):
            return None
        if not isinstance(parsed, dict):
            return None
        for key in ("path", "file", "file_path", "filepath", "target"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None


@dataclass(frozen=True, slots=True)
class Message:
    """One conversation message in the worker's request vocabulary."""

    role: str
    content: str
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()

    @classmethod
    def from_dict(cls, payload: Any, *, index: int = 0) -> Message:
        """Validate and parse one message object."""
        body = _as_dict(payload, field_name=f"messages[{index}]")
        role = _as_text(body.get("role"), field_name=f"messages[{index}].role")
        if role not in ROLES:
            raise ValidationError(
                f"messages[{index}].role must be one of {list(ROLES)}",
                details={"field": f"messages[{index}].role", "value": role},
            )
        content = _as_text(body.get("content"), field_name=f"messages[{index}].content")
        calls = tuple(
            ToolCall.from_dict(item)
            for item in _as_list(body.get("toolCalls"), field_name=f"messages[{index}].toolCalls")
        )
        return cls(
            role=role,
            content=content,
            tool_call_id=_optional_text(
                body.get("toolCallId"), field_name=f"messages[{index}].toolCallId"
            ),
            tool_name=_optional_text(
                body.get("toolName"), field_name=f"messages[{index}].toolName"
            ),
            tool_calls=calls,
        )

    def to_sdk(self) -> dict[str, Any]:
        """Render as a ``hy_memory`` ``add()`` message dict."""
        message: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_call_id:
            message["tool_call_id"] = self.tool_call_id
        if self.role == "tool" and self.tool_name:
            message["name"] = self.tool_name
        if self.tool_calls:
            message["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                for call in self.tool_calls
            ]
        return message

    def has_tool_signal(self) -> bool:
        """True when this message carries a tool call or a tool result."""
        return self.role == "tool" or bool(self.tool_calls)


@dataclass(frozen=True, slots=True)
class ToolOutcome:
    """Host-reported tool outcome for one tool call."""

    call_id: str
    name: str
    exit_code: int
    success: bool

    @classmethod
    def from_dict(cls, payload: Any, *, index: int = 0) -> ToolOutcome:
        """Validate and parse one outcome object."""
        body = _as_dict(payload, field_name=f"toolOutcomes[{index}]")
        exit_code_raw = body.get("exitCode", 0)
        try:
            exit_code = int(exit_code_raw)
        except (TypeError, ValueError) as exc:
            raise ValidationError(
                f"toolOutcomes[{index}].exitCode must be an integer",
                details={"field": f"toolOutcomes[{index}].exitCode"},
            ) from exc
        success_raw = body.get("success")
        success = bool(success_raw) if success_raw is not None else exit_code == 0
        return cls(
            call_id=_as_text(body.get("callId"), field_name=f"toolOutcomes[{index}].callId"),
            name=_as_text(body.get("name"), field_name=f"toolOutcomes[{index}].name"),
            exit_code=exit_code,
            success=success,
        )


@dataclass(frozen=True, slots=True)
class IngestInput:
    """Validated ``POST /v1/ingest`` payload."""

    job_id: str
    namespace: str
    scene: str
    messages: tuple[Message, ...] = ()
    workspace_id: str | None = None
    branch: str | None = None
    tool_outcomes: tuple[ToolOutcome, ...] = ()
    observed_at: str | None = None

    @classmethod
    def from_dict(cls, payload: Any) -> IngestInput:
        """Validate and parse the ingest body."""
        body = _as_dict(payload, field_name="body")
        namespace = _as_text(body.get("namespace"), field_name="namespace").strip()
        if not namespace:
            raise ValidationError("namespace is required", details={"field": "namespace"})
        scene = _as_text(body.get("scene"), field_name="scene", default="chat").strip()
        if scene not in SCENES:
            raise ValidationError(
                f"scene must be one of {list(SCENES)}",
                details={"field": "scene", "value": scene},
            )
        messages = tuple(
            Message.from_dict(item, index=index)
            for index, item in enumerate(_as_list(body.get("messages"), field_name="messages"))
        )
        if not messages:
            raise ValidationError(
                "messages must contain at least one message",
                details={"field": "messages"},
            )
        tool_outcomes = tuple(
            ToolOutcome.from_dict(item, index=index)
            for index, item in enumerate(
                _as_list(body.get("toolOutcomes"), field_name="toolOutcomes")
            )
        )
        return cls(
            job_id=_as_text(body.get("jobId"), field_name="jobId").strip(),
            namespace=namespace,
            scene=scene,
            messages=messages,
            workspace_id=_optional_text(body.get("workspaceId"), field_name="workspaceId"),
            branch=_optional_text(body.get("branch"), field_name="branch"),
            tool_outcomes=tool_outcomes,
            observed_at=_optional_text(body.get("observedAt"), field_name="observedAt"),
        )

    def has_tool_message(self) -> bool:
        """True when the trace carries a tool call or tool result."""
        return any(message.has_tool_signal() for message in self.messages)

    def last_user_content(self) -> str:
        """Content of the last user message (used as a fallback search query)."""
        for message in reversed(self.messages):
            if message.role == "user" and message.content.strip():
                return message.content.strip()
        return ""


@dataclass(frozen=True, slots=True)
class SearchInput:
    """Validated ``POST /v1/search`` payload."""

    namespace: str
    query: str
    scene: str | None = None
    workspace_id: str | None = None
    branch: str | None = None
    limit: int = 20
    allow_ids: tuple[str, ...] | None = None

    @classmethod
    def from_dict(cls, payload: Any) -> SearchInput:
        """Validate and parse the search body."""
        body = _as_dict(payload, field_name="body")
        namespace = _as_text(body.get("namespace"), field_name="namespace").strip()
        if not namespace:
            raise ValidationError("namespace is required", details={"field": "namespace"})
        query = _as_text(body.get("query"), field_name="query").strip()
        if not query:
            raise ValidationError("query is required", details={"field": "query"})
        scene = _optional_text(body.get("scene"), field_name="scene")
        if scene is not None:
            scene = scene.lower()
            if scene not in SCENES:
                raise ValidationError(
                    f"scene must be one of {list(SCENES)} or null",
                    details={"field": "scene", "value": scene},
                )
        limit_raw = body.get("limit", 20)
        try:
            limit = int(limit_raw)
        except (TypeError, ValueError) as exc:
            raise ValidationError("limit must be an integer", details={"field": "limit"}) from exc
        limit = max(1, min(100, limit))
        allow_raw = body.get("allowIds")
        allow_ids: tuple[str, ...] | None = None
        if allow_raw is not None:
            if not isinstance(allow_raw, list):
                raise ValidationError("allowIds must be an array", details={"field": "allowIds"})
            allow_ids = tuple(item for item in allow_raw if isinstance(item, str) and item)
        return cls(
            namespace=namespace,
            query=query,
            scene=scene,
            workspace_id=_optional_text(body.get("workspaceId"), field_name="workspaceId"),
            branch=_optional_text(body.get("branch"), field_name="branch"),
            limit=limit,
            allow_ids=allow_ids,
        )


# ---------------------------------------------------------------------------
# Engine protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class MemoryEngine(Protocol):
    """The engine surface the HTTP server depends on.

    Both :class:`hymem_worker.mock_engine.MockEngine` and
    :class:`hymem_worker.hy_engine.HyMemoryEngine` implement it. All methods are
    synchronous; the HTTP layer is thread-per-request.
    """

    name: str

    def health(self) -> EngineHealth:
        """Return current health, including the degraded reason."""

    def ingest(self, request: IngestInput) -> IngestResult:
        """Extract memory candidates from a capture envelope."""

    def search(self, request: SearchInput) -> SearchResult:
        """Return recall hits for an ACL-prefiltered id set."""

    def get(self, engine_memory_id: str) -> dict[str, Any] | None:
        """Return ``{"text", "metadata"}`` for one engine id, or ``None``."""

    def delete(self, engine_memory_id: str) -> bool:
        """Delete one engine id; ``True`` when something was removed."""

    def feedback(self, engine_memory_id: str, kind: str) -> None:
        """Record a usefulness/incorrect/stale signal."""

    def metrics(self) -> dict[str, Any]:
        """Return engine-side call/token counters (zeroes when unknown)."""

    def close(self) -> None:
        """Release engine resources."""


@dataclass(slots=True)
class EmptyMetrics:
    """Default counter block shared by engines that cannot report usage."""

    chat_completions: int = 0
    embeddings: int = 0
    tokens: int = 0
    errors: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "calls": {
                "chatCompletions": self.chat_completions,
                "embeddings": self.embeddings,
            },
            "tokens": self.tokens,
            "errors": self.errors,
        }


__all__ = [
    "FEEDBACK_KINDS",
    "KINDS",
    "MAX_TITLE_CHARS",
    "ROLES",
    "SCENES",
    "SOURCE_ID",
    "Candidate",
    "ClaimDraft",
    "EmptyMetrics",
    "EngineError",
    "EngineHealth",
    "IngestInput",
    "IngestResult",
    "MemoryEngine",
    "MemoryKind",
    "Message",
    "Scene",
    "SearchHit",
    "SearchInput",
    "SearchResult",
    "ToolCall",
    "ToolOutcome",
    "ValidationError",
    "collapse_whitespace",
    "contains_secret",
    "extract_paths",
    "first_sentence",
    "redact_text",
    "redact_value",
    "stable_digest",
    "tokenize",
    "truncate_title",
]
