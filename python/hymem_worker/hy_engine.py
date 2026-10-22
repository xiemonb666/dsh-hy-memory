"""Adapter over the real ``hy_memory`` SDK (pinned to 2.0.4).

The SDK is imported **lazily**: constructing :class:`HyMemoryEngine` never
raises, so a missing package or a broken model configuration only downgrades
:meth:`HyMemoryEngine.health` and makes ``ingest``/``search`` raise a structured
:class:`~hymem_worker.engine.EngineError` (the HTTP layer maps that to 503).

Namespace mapping
-----------------
The Host speaks ``namespace = "project:<uuid>"``; the SDK speaks
``user_id``/``workspace_id``/``branch``. We keep the namespace as the SDK
``user_id`` verbatim (it is already a stable, project-scoped key) and pass the
Host's workspace/branch through untouched. Every write is tagged with
``source='dsh-hy-memory'`` so the Studio can filter worker-originated rows.

Environment knobs honoured here (all read before the SDK is imported):

* ``MEMORY_DATA_DIR``          — where the SDK keeps vectors/SQLite.
* ``MEMORY_LLM_BASE_URL``      — [OI]-compatible chat endpoint.
* ``MEMORY_EMBEDDER_BASE_URL`` — [OI]-compatible embedding endpoint.
* ``MEMORY_MODE``              — ``lite``/``pro``/``ultra``; defaults to ``pro``.
* ``MEMORY_ENABLE_GRAPH``      — forced to ``0`` (the graph store is out of scope).
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
import time
from dataclasses import replace
from datetime import datetime
from typing import Any

from .engine import (
    SOURCE_ID,
    Candidate,
    ClaimDraft,
    EmptyMetrics,
    EngineError,
    EngineHealth,
    IngestInput,
    IngestResult,
    SearchHit,
    SearchInput,
    SearchResult,
    first_sentence,
    redact_text,
    tokenize,
    truncate_title,
)

ENGINE_NAME = "hy-memory"

# A namespace that cannot contain user data: the warmup search must never read a real memory.
WARMUP_NAMESPACE = "__hymem_warmup__"

logger = logging.getLogger(__name__)
FALLBACK_VERSION = "2.0.4"
DEFAULT_MODE = "pro"
#: How long after ``add()`` a chat row still counts as "written by this call".
FRESH_WINDOW_SECONDS = 300.0
#: Fields copied from a chat ``search()`` item into the hit kind heuristics.
_KIND_BY_LAYER: dict[str, str] = {
    "l2_fact": "fact",
    "l4_identity": "fact",
    "l5_knowledge": "fact",
    "l3_summary": "experience",
    "l6_schema": "experience",
    "l7_intention": "todo",
}

_PREFERENCE_RE_HINTS = ("prefer", "偏好")
_DECISION_RE_HINTS = ("decided", "decision", "we use", "决定")


def configure_environment(*, data_dir: str | None = None, mode: str | None = None) -> None:
    """Set the SDK's environment knobs without overriding what the caller set.

    Called before the lazy import so ``MemoryConfig.from_env()`` sees the values.
    """
    resolved_mode = (mode or os.environ.get("MEMORY_MODE") or DEFAULT_MODE).strip()
    env = {
        "MEMORY_MODE": resolved_mode,
        "MEMORY_ENABLE_GRAPH": "0",
    }
    if data_dir:
        env["MEMORY_DATA_DIR"] = data_dir
    for key, value in env.items():
        os.environ.setdefault(key, value)
    # ``MEMORY_ENABLE_GRAPH`` must win over a stray ``1`` in the shell: the graph
    # store is out of scope for this worker and would otherwise be constructed.
    os.environ["MEMORY_ENABLE_GRAPH"] = "0"
    os.environ["MEMORY_MODE"] = resolved_mode


def sdk_available() -> bool:
    """True when ``hy_memory`` can be imported in this interpreter."""
    try:
        import hy_memory  # noqa: F401
    except Exception:
        return False
    return True


def sdk_version() -> str:
    """Installed ``hy_memory`` version, or the pinned fallback."""
    try:
        import hy_memory
    except Exception:
        return FALLBACK_VERSION
    version = getattr(hy_memory, "__version__", None)
    return str(version) if version else FALLBACK_VERSION


class HyMemoryEngine:
    """Engine backed by :class:`hy_memory.HyMemoryClient`."""

    name = ENGINE_NAME

    def __init__(
        self,
        *,
        data_dir: str | None = None,
        mode: str | None = None,
    ) -> None:
        configure_environment(data_dir=data_dir, mode=mode)
        self._mode = (mode or os.environ.get("MEMORY_MODE") or DEFAULT_MODE).strip()
        self._data_dir = data_dir or os.environ.get("MEMORY_DATA_DIR")
        self._client: Any | None = None
        self._init_error: str | None = None
        self._version = FALLBACK_VERSION
        self._embedding_dims = 0
        self._metrics = EmptyMetrics()
        self._feedback: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._closed = False
        self._connect()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def _connect(self) -> None:
        """Import and construct the SDK client, recording any failure reason."""
        try:
            from hy_memory import HyMemoryClient
        except Exception as exc:
            self._init_error = f"hy_memory import failed: {type(exc).__name__}: {exc}"
            return
        self._version = sdk_version()
        try:
            client = HyMemoryClient(mode=self._mode)
        except Exception as exc:
            self._init_error = f"hy_memory client init failed: {type(exc).__name__}: {exc}"
            return
        self._client = client
        self._embedding_dims = self._read_embedding_dims(client)
        self._init_error = None

    def _read_embedding_dims(self, client: Any) -> int:
        """Best-effort embedding width from the client's resolved config."""
        candidates = (
            ("_config", "vector_store", "embedding_dims"),
            ("_config", "embedder", "embedding_dims"),
        )
        for path in candidates:
            value: Any = client
            for attribute in path:
                value = getattr(value, attribute, None)
                if value is None:
                    break
            if isinstance(value, int) and value > 0:
                return value
        return 0

    def _ensure_client(self) -> Any:
        """Return the client or raise a 503-shaped :class:`EngineError`."""
        if self._closed:
            raise EngineError(
                "E_BACKEND_UNAVAILABLE",
                "hy-memory engine is closed",
                details={"engine": ENGINE_NAME},
            )
        if self._client is None:
            raise EngineError(
                "E_BACKEND_UNAVAILABLE",
                self._init_error or "hy-memory engine is unavailable",
                details={"engine": ENGINE_NAME, "mode": self._mode},
            )
        return self._client

    # ------------------------------------------------------------------
    # Engine protocol
    # ------------------------------------------------------------------

    def health(self) -> EngineHealth:
        """Report SDK readiness; ``degraded`` carries the exact failure reason."""
        return EngineHealth(
            ok=self._client is not None,
            engine=ENGINE_NAME,
            engine_version=self._version,
            degraded=self._client is None,
            reason=self._init_error,
            queue_depth=0,
            embedding_dims=self._embedding_dims,
            mode=self._mode,
        )

    def warmup(self) -> None:
        """Force the first embedding round trip so recall is not taxed later.

        The SDK builds its OpenAI client lazily: the first embedding call pays
        ~650 ms of client construction on top of the request itself, which is
        most of a 900 ms recall budget. One read-only search against a namespace
        that cannot contain data pays that cost once, at startup, instead of on
        the first user question. Failure is non-fatal and never marks the engine
        degraded — health already reports readiness.
        """
        if self._client is None:
            return
        started = time.perf_counter()
        try:
            self._client.search(query="warmup", user_ids=[WARMUP_NAMESPACE], limit=1)
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.info("[warmup] embedding round trip ready in %.0f ms", elapsed_ms)
        except Exception as exc:  # warmup must never break startup
            logger.warning("[warmup] skipped: %s", exc)

    def ingest(self, request: IngestInput) -> IngestResult:
        """Write the trace through ``client.add`` and read the records back."""
        started = time.perf_counter()
        client = self._ensure_client()
        scene = request.scene
        if scene == "coding" and not request.has_tool_message():
            # A coding scene without a tool trace has nothing to learn from.
            self._bump_embedding_calls()
            return IngestResult(elapsed_ms=round((time.perf_counter() - started) * 1000, 3))

        messages = [message.to_sdk() for message in request.messages]
        meta = {
            "source": SOURCE_ID,
            "namespace": request.namespace,
            "scene": scene,
            "jobId": request.job_id,
            "observedAt": request.observed_at,
        }
        try:
            response = client.add(
                messages,
                scene=scene,
                user_id=request.namespace,
                workspace_id=request.workspace_id,
                branch=request.branch,
                source=SOURCE_ID,
                meta=meta,
            )
        except Exception as exc:
            self._metrics.errors += 1
            raise self._wrap_failure("ingest", exc) from exc

        if isinstance(response, dict) and response.get("success") is False:
            self._metrics.errors += 1
            raise EngineError(
                "E_BACKEND_UNAVAILABLE",
                "hy-memory ingest was rejected by the SDK",
                details={"engine": ENGINE_NAME, "operation": "ingest"},
            )

        engine_ids, candidates = self._resolve_written_records(client, request, response)
        self._metrics.chat_completions += 1
        self._bump_embedding_calls()
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        return IngestResult(
            engine_memory_ids=tuple(engine_ids),
            candidates=tuple(candidates),
            elapsed_ms=elapsed_ms,
        )

    def search(self, request: SearchInput) -> SearchResult:
        """Query the SDK and normalize chat/coding envelopes into hits."""
        started = time.perf_counter()
        client = self._ensure_client()
        try:
            response = client.search(
                request.query,
                scene=request.scene,
                user_ids=[request.namespace],
                workspace_id=request.workspace_id,
                branch=request.branch,
                limit=request.limit,
            )
        except Exception as exc:
            self._metrics.errors += 1
            raise self._wrap_failure("search", exc) from exc
        self._metrics.embeddings += 1
        hits = self._hits_from_search(response, request)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        return SearchResult(results=tuple(hits), elapsed_ms=elapsed_ms)

    def get(self, engine_memory_id: str) -> dict[str, Any] | None:
        """Read one memory by id.

        Only chat-path memories are addressable: 2.0.4 keeps coding facts and
        experiences in a separate SQLite/vector pair that ``client.get`` does not
        consult, and it hides ``L1_RAW`` rows on purpose. Coding ids therefore
        return ``None`` (HTTP 404) — the Host keeps the canonical text in its own
        governance record, so this is a diagnostic path, not a recall path.
        """
        client = self._ensure_client()
        try:
            record = client.get(engine_memory_id)
        except Exception as exc:
            self._metrics.errors += 1
            raise self._wrap_failure("get", exc) from exc
        if not isinstance(record, dict):
            return None
        text = str(record.get("content") or "")
        metadata = {
            "engineMemoryId": engine_memory_id,
            "governanceId": self._governance_id(record),
            "layer": record.get("layer"),
            "status": record.get("status"),
            "tags": record.get("tags") or [],
            "user_id": record.get("user_id"),
            "agent_id": record.get("agent_id"),
            "memory_at": record.get("memory_at"),
            "gmt_created": record.get("gmt_created"),
            "confidence": record.get("confidence"),
            "source": record.get("source"),
            "engine": ENGINE_NAME,
        }
        return {"text": redact_text(text), "metadata": metadata}

    def delete(self, engine_memory_id: str) -> bool:
        """Delete one chat-path memory by id."""
        client = self._ensure_client()
        try:
            response = client.delete(engine_memory_id)
        except Exception as exc:
            self._metrics.errors += 1
            raise self._wrap_failure("delete", exc) from exc
        if not isinstance(response, dict):
            return False
        return bool(response.get("success")) and int(response.get("deleted_count") or 0) > 0

    def feedback(self, engine_memory_id: str, kind: str) -> None:
        """Record a feedback signal.

        ``hy_memory`` 2.0.4 exposes no feedback API; the signal is kept in the
        worker so ``GET /v1/metrics`` can surface the volume. Governance status
        changes stay on the Host side.
        """
        with self._lock:
            self._feedback.append(
                {"engineMemoryId": engine_memory_id, "kind": kind, "at": time.time()}
            )

    def metrics(self) -> dict[str, Any]:
        """Worker-side call counters.

        The SDK does not expose per-call token usage in 2.0.4, so ``tokens`` stays
        zero; ``errors`` counts every normalized engine failure.
        """
        return self._metrics.to_dict()

    def close(self) -> None:
        """Close the SDK client (idempotent)."""
        if self._closed:
            return
        self._closed = True
        client, self._client = self._client, None
        if client is not None:
            # A failing close() must not mask a successful shutdown.
            with contextlib.suppress(Exception):
                client.close()

    # ------------------------------------------------------------------
    # ingest helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _engine_ids_from_add(response: Any, scene: str) -> list[str]:
        """Collect engine ids from an ``add()`` response."""
        if not isinstance(response, dict):
            return []
        ids: list[str] = []
        if scene in ("coding", "working"):
            for key in ("experience_ids", "fact_ids"):
                for value in response.get(key) or []:
                    if isinstance(value, str) and value and value not in ids:
                        ids.append(value)
        else:
            memory_id = response.get("memory_id")
            if isinstance(memory_id, str) and memory_id:
                ids.append(memory_id)
        return ids

    def _resolve_written_records(
        self, client: Any, request: IngestInput, response: Any
    ) -> tuple[list[str], list[Candidate]]:
        """Return the ids and candidates for one completed ``add()``.

        Chat and coding need different read-back strategies because the SDK
        stores them in different places (see the two helpers below).
        """
        if request.scene in ("coding", "working"):
            engine_ids = self._engine_ids_from_add(response, request.scene)
            if not engine_ids:
                return [], []
            return engine_ids, self._coding_candidates(client, request, engine_ids)
        return self._resolve_chat_records(client, request, response)

    def _resolve_chat_records(
        self, client: Any, request: IngestInput, response: Any
    ) -> tuple[list[str], list[Candidate]]:
        """Resolve readable chat ids and candidates for one ``add()``.

        ``add()`` returns the id of the ``L1_RAW`` node, and 2.0.4's ``get()``
        hides ``L1_RAW`` on purpose (it behaves exactly like "not found"). A raw
        id is therefore useless for later recall: it never appears in
        ``search()`` results, so it could never survive an ``allowIds`` filter.

        Read-back order:

        1. ``client.get(memory_id)`` — works when the SDK returns a readable id.
        2. ``client.search(<last user turn>)`` restricted to rows created by this
           call, ranked by token overlap with the input. These are the ids the
           Host can actually recall later.
        3. Nothing readable: keep the raw id and describe the *input* instead, at
           reduced confidence, so the Host still receives a candidate to anchor.
        """
        raw_id = ""
        if isinstance(response, dict):
            candidate_id = response.get("memory_id")
            if isinstance(candidate_id, str):
                raw_id = candidate_id

        records: list[dict[str, Any]] = []
        if raw_id:
            record = self._safe_get(client, raw_id)
            if isinstance(record, dict) and str(record.get("content") or "").strip():
                records.append(record)
        if not records:
            records = self._fresh_chat_records(client, request)

        engine_ids: list[str] = []
        candidates: list[Candidate] = []
        for record in records:
            engine_id = str(record.get("memory_id") or "")
            text = redact_text(str(record.get("content") or "")).strip()
            if not engine_id or not text:
                continue
            if engine_id in engine_ids:
                continue
            engine_ids.append(engine_id)
            kind, predicate = self._infer_kind(text)
            candidates.append(
                Candidate(
                    scene="chat",
                    kind=kind,
                    title=truncate_title(first_sentence(text) or text),
                    text=text,
                    claims=(ClaimDraft(subject="user", predicate=predicate, object=text[:400]),),
                    confidence=0.75,
                    engine_memory_id=engine_id,
                    source=ENGINE_NAME,
                )
            )
        if candidates:
            return engine_ids, candidates

        # Last resort: nothing readable. Describe the captured user turn so the
        # Host still gets an anchorable candidate, flagged as low confidence.
        fallback_text = redact_text(request.last_user_content()).strip()
        if not fallback_text:
            return ([raw_id] if raw_id else []), []
        kind, predicate = self._infer_kind(fallback_text)
        return (
            [raw_id] if raw_id else [],
            [
                Candidate(
                    scene="chat",
                    kind=kind,
                    title=truncate_title(first_sentence(fallback_text) or fallback_text),
                    text=fallback_text,
                    claims=(
                        ClaimDraft(subject="user", predicate=predicate, object=fallback_text[:400]),
                    ),
                    confidence=0.4,
                    engine_memory_id=raw_id,
                    source=ENGINE_NAME,
                )
            ],
        )

    def _fresh_chat_records(self, client: Any, request: IngestInput) -> list[dict[str, Any]]:
        """Find chat memories written by this call, ranked by input overlap.

        Only rows created inside :data:`FRESH_WINDOW_SECONDS` are considered, so
        a re-query cannot resurface an older memory from the same namespace.
        """
        query = request.last_user_content()
        if not query:
            return []
        try:
            response = client.search(
                query,
                scene="chat",
                user_ids=[request.namespace],
                limit=10,
                min_score=0.0,
            )
        except Exception:
            return []
        items = [
            item
            for item in self._chat_memories(response)
            if isinstance(item, dict) and item.get("memory_id")
        ]
        cutoff = time.time() - FRESH_WINDOW_SECONDS
        fresh = [item for item in items if self._epoch(item.get("gmt_created")) >= cutoff]
        pool = fresh or items
        if not pool:
            return []
        query_tokens = set(tokenize(query))
        scored: list[tuple[float, dict[str, Any]]] = []
        for item in pool:
            content = str(item.get("content") or "")
            tokens = set(tokenize(content))
            overlap = len(query_tokens & tokens) / len(query_tokens) if query_tokens else 0.0
            scored.append((overlap, item))
        scored.sort(key=lambda pair: -pair[0])
        best_overlap = scored[0][0] if scored else 0.0
        chosen = [
            item for overlap, item in scored if best_overlap > 0 and overlap >= best_overlap * 0.5
        ]
        return chosen[:2] if chosen else [scored[0][1]]

    @staticmethod
    def _epoch(value: Any) -> float:
        """Coerce an SDK timestamp (epoch int or ISO string) to epoch seconds."""
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str) and value:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return 0.0
        return 0.0

    def _coding_candidates(
        self, client: Any, request: IngestInput, engine_ids: list[str]
    ) -> list[Candidate]:
        """Fetch coding facts/experiences back through ``search``.

        ``client.get`` only serves the chat vector store in 2.0.4, so coding
        records are recovered by re-querying the task text and indexing the
        returned ``facts``/``experiences`` by id.
        """
        query = request.last_user_content()
        if not query:
            return []
        records: dict[str, dict[str, Any]] = {}
        try:
            response = client.search(
                query,
                scene="coding" if request.scene == "coding" else "working",
                user_ids=[request.namespace],
                workspace_id=request.workspace_id,
                branch=request.branch,
                limit=max(len(engine_ids) * 2, 10),
                working_fact_min_score=0.0,
                working_experience_min_score=0.0,
            )
        except Exception:
            response = {}
        if isinstance(response, dict):
            for fact in response.get("facts") or []:
                if isinstance(fact, dict) and fact.get("fact_id"):
                    records[str(fact["fact_id"])] = {"type": "fact", **fact}
            for experience in response.get("experiences") or []:
                if isinstance(experience, dict) and experience.get("experience_id"):
                    records[str(experience["experience_id"])] = {
                        "type": "experience",
                        **experience,
                    }
        scene = "coding" if request.scene == "coding" else "working"
        candidates: list[Candidate] = []
        for engine_id in engine_ids:
            record = records.get(engine_id)
            if record is None:
                continue
            if record["type"] == "fact":
                text = str(record.get("statement") or "")
                kind = "fact"
                confidence = 0.8
                paths = record.get("files") or []
                subject = str(record.get("subject") or (paths[0] if paths else "workspace"))
                predicate = "states"
            else:
                task = str(record.get("task") or "")
                solution = str(record.get("solution") or "")
                text = f"{task}\n{solution}".strip()
                kind = "experience"
                confidence = float(record.get("confidence") or 0.75)
                paths = record.get("files") or []
                subject = str(paths[0]) if paths else task[:120]
                predicate = "solved_by"
            text = redact_text(text)
            if not text.strip():
                continue
            candidates.append(
                Candidate(
                    scene=scene,
                    kind=kind,
                    title=truncate_title(first_sentence(text) or text),
                    text=text,
                    claims=(ClaimDraft(subject=subject, predicate=predicate, object=text[:400]),),
                    confidence=max(0.0, min(1.0, confidence)),
                    engine_memory_id=engine_id,
                    source=ENGINE_NAME,
                )
            )
        return candidates

    @staticmethod
    def _safe_get(client: Any, engine_id: str) -> Any:
        try:
            return client.get(engine_id)
        except Exception:
            return None

    @staticmethod
    def _infer_kind(text: str) -> tuple[str, str]:
        lowered = text.lower()
        if any(hint in lowered for hint in _PREFERENCE_RE_HINTS):
            return "preference", "prefers"
        if any(hint in lowered for hint in _DECISION_RE_HINTS):
            return "decision", "decided"
        return "fact", "states"

    # ------------------------------------------------------------------
    # search helpers
    # ------------------------------------------------------------------

    def _hits_from_search(self, response: Any, request: SearchInput) -> list[SearchHit]:
        """Normalize a ``search()`` response into contract hits."""
        if not isinstance(response, dict):
            return []
        chain_block = response.get("chain_block")
        chain_text = str(chain_block) if chain_block else None
        hits: list[SearchHit] = []

        for item in self._chat_memories(response):
            if not isinstance(item, dict):
                continue
            engine_id = str(item.get("memory_id") or "")
            if not engine_id:
                continue
            text = redact_text(str(item.get("content") or ""))
            if not text:
                continue
            hits.append(
                SearchHit(
                    engine_memory_id=engine_id,
                    governance_id=self._governance_id(item),
                    text=text,
                    score=float(item.get("score") or 0.0),
                    scene="chat",
                    kind=self._kind_for_memory(item),
                    chain_block=None,
                )
            )

        fact_hits: list[SearchHit] = []
        for fact in response.get("facts") or []:
            if not isinstance(fact, dict):
                continue
            engine_id = str(fact.get("fact_id") or "")
            if not engine_id:
                continue
            text = redact_text(str(fact.get("statement") or ""))
            if not text:
                continue
            fact_hits.append(
                SearchHit(
                    engine_memory_id=engine_id,
                    governance_id=self._governance_id(fact),
                    text=text,
                    score=float(fact.get("score") or 0.0),
                    scene="coding",
                    kind="fact",
                    chain_block=None,
                )
            )
        for experience in response.get("experiences") or []:
            if not isinstance(experience, dict):
                continue
            engine_id = str(experience.get("experience_id") or "")
            if not engine_id:
                continue
            task = str(experience.get("task") or "")
            solution = str(experience.get("solution") or "")
            text = redact_text(f"{task}\n{solution}".strip())
            if not text:
                continue
            score = experience.get("score")
            hits.append(
                SearchHit(
                    engine_memory_id=engine_id,
                    governance_id=self._governance_id(experience),
                    text=text,
                    score=float(score) if score is not None else 0.0,
                    scene="coding",
                    kind="experience",
                    chain_block=None,
                )
            )
        hits.extend(fact_hits)

        hits = self._apply_allow_ids(hits, request.allow_ids)
        hits.sort(key=lambda hit: (-hit.score, hit.engine_memory_id))
        hits = hits[: request.limit]

        if chain_text:
            # ``chain_block`` is one rendered block for the whole coding answer.
            # Attach it to the highest-ranked coding hit (after sorting and
            # truncation) so it is rendered exactly once and never dropped by the
            # limit; fall back to the top hit for a chat-only response.
            for index, hit in enumerate(hits):
                if hit.scene == "coding":
                    hits[index] = replace(hit, chain_block=chain_text)
                    break
            else:
                if hits:
                    hits[0] = replace(hits[0], chain_block=chain_text)
        return hits

    @staticmethod
    def _chat_memories(response: dict[str, Any]) -> list[Any]:
        """Flatten ``memories`` (list or schema/proactive/normal channels)."""
        memories = response.get("memories")
        if isinstance(memories, list):
            return list(memories)
        if isinstance(memories, dict):
            items: list[Any] = []
            for channel in ("schema", "proactive", "normal"):
                items.extend(memories.get(channel) or [])
            return items
        return []

    @staticmethod
    def _kind_for_memory(item: dict[str, Any]) -> str:
        tags = item.get("tags") or []
        lowered_tags = {str(tag).lower() for tag in tags if isinstance(tag, str)}
        for kind in ("preference", "decision", "todo", "hypothesis"):
            if kind in lowered_tags:
                return kind
        layer = str(item.get("layer") or "").lower()
        return _KIND_BY_LAYER.get(layer, "fact")

    @staticmethod
    def _governance_id(record: dict[str, Any]) -> str | None:
        """Read the Host governance id from ``governance_id`` metadata."""
        direct = record.get("governance_id") or record.get("governanceId")
        if isinstance(direct, str) and direct:
            return direct
        custom = record.get("custom")
        if isinstance(custom, dict):
            value = custom.get("governance_id") or custom.get("governanceId")
            if isinstance(value, str) and value:
                return value
        meta = record.get("meta")
        entries = meta if isinstance(meta, list) else [meta]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            value = entry.get("governance_id") or entry.get("governanceId")
            if isinstance(value, str) and value:
                return value
        return None

    @staticmethod
    def _apply_allow_ids(
        hits: list[SearchHit], allow_ids: tuple[str, ...] | None
    ) -> list[SearchHit]:
        """Defence in depth: never return an id outside ``allowIds``.

        Membership is checked against both the governance id and the engine id.
        When ``allowIds`` is supplied and a hit carries neither form, the hit is
        dropped: the worker cannot prove the Host authorized it.
        """
        if allow_ids is None:
            return hits
        allowed = set(allow_ids)
        return [
            hit for hit in hits if hit.governance_id in allowed or hit.engine_memory_id in allowed
        ]

    # ------------------------------------------------------------------
    # Misc
    # ------------------------------------------------------------------

    def _bump_embedding_calls(self) -> None:
        self._metrics.embeddings += 1

    @staticmethod
    def _wrap_failure(operation: str, exc: Exception) -> EngineError:
        """Normalize an SDK exception into a 503/504-shaped engine error."""
        message = redact_text(f"{type(exc).__name__}: {exc}")
        timeout_names = ("Timeout", "TimeoutError", "ReadTimeout", "ConnectTimeout")
        code = (
            "E_BACKEND_TIMEOUT"
            if any(name in type(exc).__name__ for name in timeout_names)
            else "E_BACKEND_UNAVAILABLE"
        )
        return EngineError(
            code,
            f"hy-memory {operation} failed: {message}",
            details={"engine": ENGINE_NAME, "operation": operation},
        )


__all__ = [
    "DEFAULT_MODE",
    "ENGINE_NAME",
    "FALLBACK_VERSION",
    "HyMemoryEngine",
    "configure_environment",
    "sdk_available",
    "sdk_version",
]
