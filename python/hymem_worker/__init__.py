"""DSH HyMemory Python worker.

Public surface:

* :class:`~hymem_worker.engine.MemoryEngine` — the engine protocol and its
  request/response dataclasses (:class:`EngineHealth`, :class:`Candidate`,
  :class:`SearchHit`, :class:`IngestInput`, ...).
* :class:`~hymem_worker.mock_engine.MockEngine` — deterministic offline engine.
* :class:`~hymem_worker.hy_engine.HyMemoryEngine` — adapter over ``hy_memory``
  2.0.4, imported lazily so the worker starts without the SDK.
* :mod:`hymem_worker.server` — loopback HTTP transport (stdlib only).

Run it with ``python -m hymem_worker --port 0 --engine mock --token-file <path>``.
"""

from __future__ import annotations

from .engine import (
    SOURCE_ID,
    Candidate,
    ClaimDraft,
    EngineError,
    EngineHealth,
    IngestInput,
    IngestResult,
    MemoryEngine,
    SearchHit,
    SearchInput,
    SearchResult,
    ValidationError,
)
from .hy_engine import HyMemoryEngine
from .mock_engine import MockEngine

__version__ = "0.1.0"

__all__ = [
    "SOURCE_ID",
    "Candidate",
    "ClaimDraft",
    "EngineError",
    "EngineHealth",
    "HyMemoryEngine",
    "IngestInput",
    "IngestResult",
    "MemoryEngine",
    "MockEngine",
    "SearchHit",
    "SearchInput",
    "SearchResult",
    "ValidationError",
    "__version__",
]
