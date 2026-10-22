"""Deterministic, offline mock engine.

The mock exists so the Host plugin, the Studio UI and the test suite can run
end-to-end without a model endpoint. It performs **no** network I/O and never
imports the ``hy_memory`` SDK.

Extraction rules (intentionally small and explainable):

* user statements containing ``remember`` / ``prefer`` / ``decided`` /
  ``we use`` / ``请记住`` / ``偏好`` / ``决定`` become **chat** candidates:
  ``preference`` for the preference words, ``decision`` for the decision words
  (the contract's ``KindSchema`` has a dedicated ``decision`` member) and
  ``fact`` for a plain "remember this" statement;
* tool results (with an exit code and/or diff text) become ``coding`` /
  ``working`` candidates carrying the touched file paths and a pass/fail status;
* assistant self-claims become ``hypothesis`` candidates with confidence ``0.3``
  and ``source='model_generated'`` — the Host must never treat them as evidence.

Chat candidates are still emitted for a ``coding`` ingest when the user turn
carries a durable preference ("remember we use ruff"): that is a chat-scoped
memory, not a code fact.

Recall is deterministic lexical scoring (token overlap + substring match +
exact path/symbol boost). ``allowIds`` is enforced as defence in depth: a hit is
only returned when its governance id (or, for the mock, its engine id, which is
the same value) is in the allowed set.

The mock has no governance database, so it uses the engine id as the governance
id. That keeps ``allowIds`` filtering honest while still being self-consistent.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from .engine import (
    Candidate,
    ClaimDraft,
    EmptyMetrics,
    EngineHealth,
    IngestInput,
    IngestResult,
    Message,
    SearchHit,
    SearchInput,
    SearchResult,
    ToolOutcome,
    collapse_whitespace,
    extract_paths,
    first_sentence,
    redact_text,
    stable_digest,
    tokenize,
    truncate_title,
)

ENGINE_NAME = "mock"
ENGINE_VERSION = "0.1.0"
DEFAULT_DEGRADED_REASON = "no model endpoint configured"

MAX_TEXT_CHARS = 4000
MAX_DIFF_CHARS = 800

# ``(kind, pattern, predicate, confidence)`` in priority order: preference wins
# over decision, decision over a plain "remember" statement.
_USER_RULES: tuple[tuple[str, re.Pattern[str], str, float], ...] = (
    ("preference", re.compile(r"\bprefer(?:s|red|ence|ences)?\b", re.I), "prefers", 0.75),
    ("preference", re.compile(r"偏好"), "偏好", 0.75),
    (
        "decision",
        re.compile(r"\b(?:decided|decide|decision)\b", re.I),
        "decided",
        0.7,
    ),
    ("decision", re.compile(r"\bwe\s+use\b", re.I), "uses", 0.7),
    ("decision", re.compile(r"决定"), "决定", 0.7),
    ("fact", re.compile(r"\bremember(?:ed|s)?\b", re.I), "stated", 0.65),
    ("fact", re.compile(r"请记住|记住"), "陈述", 0.65),
)

_EXIT_CODE_RE = re.compile(
    r"(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exitCode|status(?:\s+code)?)"
    r"\s*[:=]?\s*(-?\d+)",
    re.IGNORECASE,
)
_FAILURE_HINT_RE = re.compile(
    r"\b(?:error|errors|failed|failure|traceback|exception|fatal|panic)\b|"
    r"(?:错误|失败|异常)",
    re.IGNORECASE,
)
_DIFF_HEADER_RE = re.compile(r"^diff --git a/(\S+) b/(\S+)", re.MULTILINE)
_DIFF_NEW_RE = re.compile(r"^\+\+\+ b/(\S+)", re.MULTILINE)
_DIFF_OLD_RE = re.compile(r"^--- a/(\S+)", re.MULTILINE)
_SYMBOL_RE = re.compile(
    r"[A-Za-z0-9_]+(?:[./:_][A-Za-z0-9_]+)+|_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*"
)
_LEADING_FILLER_RE = re.compile(
    r"^(?:please\s+|that\s+|to\s+|about\s+|:+\s*|,+\s*|-+\s*)+", re.IGNORECASE
)


def _strip_diff_prefix(path: str) -> str:
    """Drop git's ``a/``/``b/`` diff prefix, keeping a repo-relative path.

    Only used for paths taken from diff headers, where the prefix is guaranteed
    by git's format. Generic path matches are never rewritten this way, so a
    genuine repo path that happens to start with ``b/`` survives untouched.
    """
    cleaned = path.lstrip("./")
    for prefix in ("a/", "b/"):
        if cleaned.startswith(prefix) and len(cleaned) > len(prefix):
            return cleaned[len(prefix) :]
    return cleaned


@dataclass(slots=True)
class _StoredMemory:
    """One memory held in the mock's in-process store."""

    engine_memory_id: str
    governance_id: str
    namespace: str
    scene: str
    kind: str
    title: str
    text: str
    claims: tuple[ClaimDraft, ...]
    confidence: float
    source: str
    metadata: dict[str, Any]
    created_at: float = field(default_factory=time.time)


@dataclass(slots=True)
class _ToolObservation:
    """Normalized view of one tool result message."""

    tool_name: str
    exit_code: int
    success: bool
    paths: tuple[str, ...]
    diff_text: str


class MockEngine:
    """Rule-based :class:`~hymem_worker.engine.MemoryEngine` implementation."""

    name = ENGINE_NAME

    def __init__(self, *, degraded_reason: str | None = None) -> None:
        self._reason = degraded_reason or DEFAULT_DEGRADED_REASON
        self._memories: dict[str, _StoredMemory] = {}
        self._feedback: list[dict[str, Any]] = []
        self._metrics = EmptyMetrics()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Engine protocol
    # ------------------------------------------------------------------

    def health(self) -> EngineHealth:
        """The mock is always up, but always degraded (no model endpoint)."""
        return EngineHealth(
            ok=True,
            engine=ENGINE_NAME,
            engine_version=ENGINE_VERSION,
            degraded=True,
            reason=self._reason,
            queue_depth=0,
            embedding_dims=0,
            mode="mock",
        )

    def ingest(self, request: IngestInput) -> IngestResult:
        """Extract candidates from the capture envelope and store them."""
        started = time.perf_counter()
        candidates = self._extract(request)
        stored_ids: list[str] = []
        built: list[Candidate] = []
        now = time.time()

        with self._lock:
            for index, draft in enumerate(candidates):
                engine_id = "mock-" + stable_digest(
                    request.namespace,
                    request.job_id,
                    str(index),
                    draft.kind,
                    draft.text,
                )
                memory = _StoredMemory(
                    engine_memory_id=engine_id,
                    governance_id=engine_id,
                    namespace=request.namespace,
                    scene=draft.scene,
                    kind=draft.kind,
                    title=draft.title,
                    text=draft.text,
                    claims=draft.claims,
                    confidence=draft.confidence,
                    source=draft.source,
                    metadata={
                        "engineMemoryId": engine_id,
                        "governanceId": engine_id,
                        "namespace": request.namespace,
                        "workspaceId": request.workspace_id,
                        "branch": request.branch,
                        "scene": draft.scene,
                        "kind": draft.kind,
                        "source": draft.source,
                        "confidence": round(float(draft.confidence), 3),
                        "claims": [claim.to_dict() for claim in draft.claims],
                        "jobId": request.job_id,
                        "observedAt": request.observed_at,
                        "engine": ENGINE_NAME,
                    },
                    created_at=now,
                )
                self._memories[engine_id] = memory
                stored_ids.append(engine_id)
                built.append(
                    Candidate(
                        scene=draft.scene,
                        kind=draft.kind,
                        title=draft.title,
                        text=draft.text,
                        claims=draft.claims,
                        confidence=draft.confidence,
                        engine_memory_id=engine_id,
                        source=draft.source,
                    )
                )

        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        return IngestResult(
            engine_memory_ids=tuple(stored_ids),
            candidates=tuple(built),
            elapsed_ms=elapsed_ms,
        )

    def search(self, request: SearchInput) -> SearchResult:
        """Deterministic lexical search over this engine's in-memory store."""
        started = time.perf_counter()
        query_lower = request.query.lower()
        query_tokens = tokenize(request.query)
        query_token_set = set(query_tokens)
        query_paths = [path.lower() for path in extract_paths(request.query)]
        query_symbols = {symbol.lower() for symbol in _SYMBOL_RE.findall(request.query)}
        allowed = None if request.allow_ids is None else set(request.allow_ids)

        hits: list[SearchHit] = []
        with self._lock:
            memories = list(self._memories.values())
        for memory in memories:
            if memory.namespace != request.namespace:
                continue
            if request.scene is not None and memory.scene != request.scene:
                continue
            if allowed is not None and not self._is_allowed(memory, allowed):
                continue
            score = self._score(
                query_lower=query_lower,
                query_token_set=query_token_set,
                query_paths=query_paths,
                query_symbols=query_symbols,
                memory=memory,
            )
            if score <= 0.0:
                continue
            hits.append(
                SearchHit(
                    engine_memory_id=memory.engine_memory_id,
                    governance_id=memory.governance_id,
                    text=memory.text,
                    score=score,
                    scene=memory.scene,
                    kind=memory.kind,
                    chain_block=None,
                )
            )
        hits.sort(key=lambda hit: (-hit.score, hit.engine_memory_id))
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        return SearchResult(results=tuple(hits[: request.limit]), elapsed_ms=elapsed_ms)

    def get(self, engine_memory_id: str) -> dict[str, Any] | None:
        """Return the stored text and metadata for one engine id."""
        with self._lock:
            memory = self._memories.get(engine_memory_id)
        if memory is None:
            return None
        metadata = dict(memory.metadata)
        metadata["createdAt"] = memory.created_at
        return {"text": memory.text, "metadata": metadata}

    def delete(self, engine_memory_id: str) -> bool:
        """Delete one memory; ``False`` when the id was unknown."""
        with self._lock:
            removed = self._memories.pop(engine_memory_id, None)
        return removed is not None

    def feedback(self, engine_memory_id: str, kind: str) -> None:
        """Record a feedback signal (the mock keeps it in memory only)."""
        with self._lock:
            self._feedback.append(
                {
                    "engineMemoryId": engine_memory_id,
                    "kind": kind,
                    "at": time.time(),
                }
            )

    def metrics(self) -> dict[str, Any]:
        """The mock makes no model calls, so every counter stays zero."""
        return self._metrics.to_dict()

    def close(self) -> None:
        """Drop all in-memory state."""
        with self._lock:
            self._memories.clear()
            self._feedback.clear()

    # ------------------------------------------------------------------
    # Extraction
    # ------------------------------------------------------------------

    def _extract(self, request: IngestInput) -> list[Candidate]:
        call_paths = self._tool_call_paths(request.messages)
        drafts: list[Candidate] = []
        seen: set[tuple[str, str]] = set()
        has_tool_signal = request.has_tool_message()

        for message in request.messages:
            produced: list[Candidate] = []
            if message.role == "user":
                produced.extend(self._user_candidates(message))
            elif message.role == "tool":
                produced.extend(self._tool_candidates(message, request, call_paths))
            elif message.role == "assistant":
                produced.extend(self._assistant_candidates(message))
            for candidate in produced:
                key = (candidate.kind, collapse_whitespace(candidate.text).lower()[:200])
                if key in seen:
                    continue
                seen.add(key)
                drafts.append(candidate)

        if not has_tool_signal:
            # A tool-only claim without any tool trace is not a coding memory.
            drafts = [
                candidate for candidate in drafts if candidate.scene not in ("coding", "working")
            ]
        return drafts

    @staticmethod
    def _tool_call_paths(messages: tuple[Message, ...]) -> dict[str, str]:
        """Map tool-call id -> path argument, for tool results that omit the path."""
        paths: dict[str, str] = {}
        for message in messages:
            for call in message.tool_calls:
                path = call.argument_path()
                if path and call.id:
                    paths[call.id] = path
        return paths

    def _user_candidates(self, message: Message) -> list[Candidate]:
        content = redact_text(message.content).strip()
        if not content:
            return []
        kind, predicate, confidence, matched = self._classify_user_statement(content)
        if matched is None:
            return []
        statement = self._statement_object(content, matched)
        title = truncate_title(first_sentence(statement) or content)
        text = truncate_title(statement or content, MAX_TEXT_CHARS)
        claims = (
            ClaimDraft(
                subject="user",
                predicate=predicate,
                object=truncate_title(statement or content, 400),
            ),
        )
        return [
            Candidate(
                scene="chat",
                kind=kind,
                title=title,
                text=text,
                claims=claims,
                confidence=confidence,
                engine_memory_id="",
                source="mock",
            )
        ]

    @staticmethod
    def _classify_user_statement(
        content: str,
    ) -> tuple[str, str, float, re.Pattern[str] | None]:
        for kind, pattern, predicate, confidence in _USER_RULES:
            if pattern.search(content):
                return kind, predicate, confidence, pattern
        return "fact", "stated", 0.0, None

    @staticmethod
    def _statement_object(content: str, pattern: re.Pattern[str]) -> str:
        match = pattern.search(content)
        if match is None:
            return collapse_whitespace(content)
        remainder = content[match.end() :]
        remainder = _LEADING_FILLER_RE.sub("", remainder)
        remainder = collapse_whitespace(remainder).strip(" .!?;,\u3002\uff01\uff1f\uff1b\uff0c")
        return remainder or collapse_whitespace(content)

    def _tool_candidates(
        self,
        message: Message,
        request: IngestInput,
        call_paths: dict[str, str],
    ) -> list[Candidate]:
        observation = self._observe_tool_result(message, request.tool_outcomes, call_paths)
        if observation is None:
            return []
        scene = "coding" if request.scene == "coding" else "working"
        status = "passed" if observation.success else "failed"
        kind = "experience" if observation.success else "failure"
        primary_path = observation.paths[0] if observation.paths else None
        title = truncate_title(
            f"{observation.tool_name} {status}" + (f" on {primary_path}" if primary_path else "")
        )
        parts = [f"{observation.tool_name} {status} with exit code {observation.exit_code}"]
        if observation.paths:
            parts.append("files: " + ", ".join(observation.paths))
        if observation.diff_text:
            parts.append("diff:\n" + observation.diff_text)
        text = truncate_title("\n".join(parts), MAX_TEXT_CHARS)
        subject = primary_path or observation.tool_name
        claims = (
            ClaimDraft(
                subject=subject,
                predicate="exit_code",
                object=f"{observation.exit_code} ({status})",
            ),
            ClaimDraft(
                subject=observation.tool_name,
                predicate="result",
                object=status,
            ),
        )
        confidence = 0.9 if observation.success else 0.8
        return [
            Candidate(
                scene=scene,
                kind=kind,
                title=title,
                text=text,
                claims=claims,
                confidence=confidence,
                engine_memory_id="",
                source="mock",
            )
        ]

    def _observe_tool_result(
        self,
        message: Message,
        outcomes: tuple[ToolOutcome, ...],
        call_paths: dict[str, str],
    ) -> _ToolObservation | None:
        content = redact_text(message.content)
        outcome = self._match_outcome(message, outcomes)
        tool_name = (
            (outcome.name if outcome and outcome.name else None) or message.tool_name or "tool"
        )
        exit_code = self._detect_exit_code(content, outcome)
        success = outcome.success if outcome is not None else exit_code == 0
        paths = self._detect_paths(content, message, call_paths)
        diff_text = self._detect_diff(content)
        if not content.strip() and not paths and not diff_text:
            return None
        return _ToolObservation(
            tool_name=tool_name,
            exit_code=exit_code,
            success=success,
            paths=tuple(paths),
            diff_text=diff_text,
        )

    @staticmethod
    def _match_outcome(message: Message, outcomes: tuple[ToolOutcome, ...]) -> ToolOutcome | None:
        for outcome in outcomes:
            if message.tool_call_id and outcome.call_id == message.tool_call_id:
                return outcome
        for outcome in outcomes:
            if message.tool_name and outcome.name == message.tool_name:
                return outcome
        return None

    @staticmethod
    def _detect_exit_code(content: str, outcome: ToolOutcome | None) -> int:
        if outcome is not None:
            return outcome.exit_code
        match = _EXIT_CODE_RE.search(content)
        if match:
            try:
                return int(match.group(1))
            except ValueError:  # pragma: no cover - regex guarantees digits
                return 1
        return 1 if _FAILURE_HINT_RE.search(content) else 0

    @staticmethod
    def _detect_paths(
        content: str,
        message: Message,
        call_paths: dict[str, str],
    ) -> list[str]:
        """Collect touched file paths, normalized to repo-relative form.

        Git renders the same file three times (``diff --git a/X b/X``,
        ``--- a/X``, ``+++ b/X``); the leading ``a/``/``b/`` prefix is stripped
        and duplicates are dropped so the candidate lists each file once.
        """
        raw: list[str] = []
        if message.tool_call_id:
            call_path = call_paths.get(message.tool_call_id)
            if call_path:
                raw.append(call_path.replace("\\", "/"))
        # Diff headers are the authoritative source: git guarantees the a//b/
        # prefixes, so these are normalized and seeded first.
        for regex in (_DIFF_HEADER_RE, _DIFF_NEW_RE, _DIFF_OLD_RE):
            raw.extend(
                _strip_diff_prefix(match.group(1).replace("\\", "/"))
                for match in regex.finditer(content)
            )
        paths: list[str] = []
        for path in raw:
            if path and path not in paths:
                paths.append(path)
        # Generic matches only fill gaps; drop the a//b/-prefixed duplicates.
        for path in extract_paths(content):
            if path not in paths and _strip_diff_prefix(path) not in paths:
                paths.append(path)
        return paths

    @staticmethod
    def _detect_diff(content: str) -> str:
        marker = content.find("diff --git")
        if marker >= 0:
            return content[marker : marker + MAX_DIFF_CHARS]
        if "--- " in content and "+++ " in content:
            start = content.find("--- ")
            return content[start : start + MAX_DIFF_CHARS]
        return ""

    def _assistant_candidates(self, message: Message) -> list[Candidate]:
        content = redact_text(message.content).strip()
        if not content:
            return []
        text = truncate_title(content, MAX_TEXT_CHARS)
        return [
            Candidate(
                scene="chat",
                kind="hypothesis",
                title=truncate_title(first_sentence(content) or content),
                text=text,
                claims=(
                    ClaimDraft(
                        subject="assistant",
                        predicate="claims",
                        object=truncate_title(first_sentence(content) or content, 400),
                    ),
                ),
                confidence=0.3,
                engine_memory_id="",
                source="model_generated",
            )
        ]

    # ------------------------------------------------------------------
    # Search scoring
    # ------------------------------------------------------------------

    @staticmethod
    def _is_allowed(memory: _StoredMemory, allowed: set[str]) -> bool:
        return memory.governance_id in allowed or memory.engine_memory_id in allowed

    @staticmethod
    def _score(
        *,
        query_lower: str,
        query_token_set: set[str],
        query_paths: list[str],
        query_symbols: set[str],
        memory: _StoredMemory,
    ) -> float:
        haystack = f"{memory.title} {memory.text}".lower()
        if not haystack.strip():
            return 0.0
        memory_tokens = set(tokenize(haystack))
        overlap = (
            len(query_token_set & memory_tokens) / len(query_token_set) if query_token_set else 0.0
        )
        substring = 1.0 if query_lower and query_lower in haystack else 0.0
        path_boost = 1.0 if any(path and path in haystack for path in query_paths) else 0.0
        symbol_boost = 1.0 if any(symbol in memory_tokens for symbol in query_symbols) else 0.0
        score = 0.55 * overlap + 0.25 * substring + 0.20 * max(path_boost, symbol_boost)
        return round(min(1.0, max(0.0, score)), 6)


__all__ = [
    "DEFAULT_DEGRADED_REASON",
    "ENGINE_NAME",
    "ENGINE_VERSION",
    "MockEngine",
]
