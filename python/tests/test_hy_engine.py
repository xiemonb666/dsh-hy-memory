from __future__ import annotations

from typing import Any

import pytest

from hymem_worker.engine import EmptyMetrics, EngineError, IngestInput
from hymem_worker.hy_engine import HyMemoryEngine


class FailedAddClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def add(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        self.calls.append("add")
        return {
            "success": False,
            "memory_id": "not-a-written-memory",
            "error_message": "upstream failed with sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        }

    def get(self, _memory_id: str) -> None:
        self.calls.append("get")
        return None

    def search(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        self.calls.append("search")
        return {}


class SuccessfulAddClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def add(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        self.calls.append("add")
        return {"success": True, "memory_id": "raw-memory"}

    def get(self, _memory_id: str) -> dict[str, Any]:
        self.calls.append("get")
        return {"memory_id": "readable-memory", "content": "I prefer dark mode."}


def _engine_with_client(client: Any) -> HyMemoryEngine:
    engine = HyMemoryEngine.__new__(HyMemoryEngine)
    engine._client = client
    engine._closed = False
    engine._init_error = None
    engine._mode = "pro"
    engine._metrics = EmptyMetrics()
    return engine


def _chat_request() -> IngestInput:
    return IngestInput.from_dict(
        {
            "jobId": "offline-test",
            "namespace": "project:test",
            "scene": "chat",
            "messages": [{"role": "user", "content": "Please remember my synthetic preference."}],
        }
    )


def test_failed_sdk_add_is_backend_error_without_readback_or_sdk_text() -> None:
    client = FailedAddClient()
    engine = _engine_with_client(client)

    with pytest.raises(EngineError) as exc_info:
        engine.ingest(_chat_request())

    error = exc_info.value
    assert error.code == "E_BACKEND_UNAVAILABLE"
    assert error.status == 503
    assert error.details == {"engine": "hy-memory", "operation": "ingest"}
    assert "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" not in str(error)
    assert "upstream failed" not in str(error)
    assert "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" not in str(error.to_envelope())
    assert "upstream failed" not in str(error.to_envelope())
    assert client.calls == ["add"]
    assert engine.metrics()["errors"] == 1


def test_successful_sdk_add_still_reads_back_candidate() -> None:
    client = SuccessfulAddClient()
    engine = _engine_with_client(client)

    result = engine.ingest(_chat_request())

    assert result.engine_memory_ids == ("readable-memory",)
    assert len(result.candidates) == 1
    assert result.candidates[0].text == "I prefer dark mode."
    assert client.calls == ["add", "get"]
