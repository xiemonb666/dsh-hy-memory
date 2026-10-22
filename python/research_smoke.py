#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Offline end-to-end smoke test for the real hy-memory SDK (2.0.4).

What it proves
--------------
* ``HyMemoryClient`` is constructed from environment variables only.
* Every LLM/embedding HTTP call is served by a *local, stdlib-only* mock
  OpenAI-compatible server on 127.0.0.1 (no network, no API key).
* A normal chat memory is written (``add`` -> LLM extraction -> reconcile)
  and read back through ``search``.
* A coding memory is written from a real OpenAI-style tool-call trace
  (user turn + assistant ``tool_calls`` + ``role="tool"`` result) with
  ``scene="coding"``, and read back through ``search(scene="coding")``,
  including the ``chain_block`` / ``chain_used`` keys.
* All state lives under a throw-away temp ``MEMORY_DATA_DIR``.

Run from the repository root:

    python python/research_smoke.py

Exit code 0 == every assertion passed. Any failure prints the raw responses
and exits non-zero.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List

# --------------------------------------------------------------------------
# Constants used by the mock "model"
# --------------------------------------------------------------------------

EMBED_DIMS = 64

CHAT_MEMORY_TEXT = (
    "The user's favorite hiking trail is the Eagle Ridge loop near Boulder, "
    "and they usually hike it on Saturday mornings."
)

CODING_TASK = "guard divide by zero in src/calc.py"
CODING_SOLUTION = (
    "In src/calc.py, function divide(a, b): raise ValueError('b must not be zero') "
    "when b == 0 instead of returning None. Verified by git diff only, tests not run."
)
CODING_FACT_STATEMENT = (
    "Fix divide-by-zero in src/calc.py divide() on branch fix/divzero: settled on "
    "raising ValueError('b must not be zero') when b == 0, replacing the interim "
    "`return None`; confirmed by git diff only, tests not run."
)

CODING_EXTRACT_JSON = {
    "experiences": [
        {
            "task": CODING_TASK,
            "search_keys": ["divide by zero", "zero division guard", "calc.py divide"],
            "solution": CODING_SOLUTION,
            "boundary_envs": "python: 3.12",
            "confidence": 0.9,
        }
    ],
    "fact": {
        "statement": CODING_FACT_STATEMENT,
        "files": ["demo/src/calc.py"],
    },
}

CHAT_EXTRACT_JSON = {
    "memory": [
        {"content": CHAT_MEMORY_TEXT, "owner": "user", "tags": ["profile"]}
    ],
    "basic_info": {},
    "intentions": [],
}

# Unity diff carried inside a tool result. chain_store._get_patch() looks for
# the literal "diff --git" marker in the rendered conversation text.
TOOL_DIFF = """diff --git a/demo/src/calc.py b/demo/src/calc.py
--- a/src/calc.py
+++ b/src/calc.py
@@ -10,3 +10,4 @@ def divide(a, b):
     if b == 0:
-        return None
+        raise ValueError("b must not be zero")
     return a / b
"""

# --------------------------------------------------------------------------
# Mock OpenAI-compatible server (stdlib only)
# --------------------------------------------------------------------------


def _embed_vector(text: str) -> List[float]:
    """Deterministic, dependency-free embedding.

    A large constant component guarantees that any two texts share a positive
    cosine similarity (so retrieval thresholds are satisfied offline), while a
    small hashed bag-of-words component keeps the vector text-dependent.
    """
    vec = [0.0] * EMBED_DIMS
    for token in re.findall(r"[a-z0-9_./:-]+", text.lower()):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % EMBED_DIMS
        sign = 1.0 if digest[4] % 2 else -1.0
        vec[idx] += sign
    base = 1.0 / math.sqrt(EMBED_DIMS)
    vec = [0.85 * base + 0.15 * value for value in vec]
    norm = math.sqrt(sum(value * value for value in vec)) or 1.0
    return [round(value / norm, 8) for value in vec]


def _content_of(body: Dict[str, Any]) -> str:
    """Flatten an OpenAI chat request into one searchable string."""
    parts: List[str] = []
    for message in body.get("messages") or []:
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
    return "\n".join(parts)


def _completion(content: Any) -> Dict[str, Any]:
    """Build an OpenAI ChatCompletion response with JSON string content."""
    text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "mock-chat",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": max(1, len(text) // 4),
            "completion_tokens": max(1, len(text) // 4),
            "total_tokens": max(2, len(text) // 2),
        },
    }


class MockOpenAIHandler(BaseHTTPRequestHandler):
    server_version = "MockOpenAI/1.0"
    protocol_version = "HTTP/1.1"

    # Recorded traffic, exposed through the server object for the summary.
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send(400, {"error": {"message": "invalid json"}})
            return

        path = self.path.split("?")[0]
        self.server.calls.append(path)  # type: ignore[attr-defined]

        if path.endswith("/embeddings"):
            inputs = body.get("input")
            texts = [inputs] if isinstance(inputs, str) else list(inputs or [])
            data = [
                {"object": "embedding", "index": i, "embedding": _embed_vector(t)}
                for i, t in enumerate(texts)
            ]
            self._send(
                200,
                {
                    "object": "list",
                    "data": data,
                    "model": body.get("model") or "mock-embed",
                    "usage": {"prompt_tokens": len(texts), "total_tokens": len(texts)},
                },
            )
            return

        if path.endswith("/chat/completions"):
            text = _content_of(body)
            self.server.prompts.append(text[:400])  # type: ignore[attr-defined]

            if "You decide how to merge new coding memory drafts" in text:
                payload = {"ops": [{"draft_idx": 0, "action": "ADD"}]}
            elif "You maintain session-level WORKING FACTS" in text:
                payload = {"ops": [{"draft_idx": 0, "supersedes": []}]}
            elif "You are a memory management system" in text:
                payload = [
                    {"op": "ADD", "content": CHAT_MEMORY_TEXT, "owner": "user", "tags": ["profile"]}
                ]
            elif "HARD CONSTRAINT" in text or "You extract durable WORKING memories" in text:
                payload = CODING_EXTRACT_JSON
            elif "# ROLE" in text or "EXTRACT" in text.upper():
                payload = CHAT_EXTRACT_JSON
            else:
                # Unknown prompt (e.g. optional post-processing): keep it harmless.
                payload = {"memory": [], "intentions": []}
            self._send(200, _completion(payload))
            return

        self._send(404, {"error": {"message": f"unknown path {path}"}})

    def do_GET(self) -> None:  # noqa: N802
        self._send(200, {"status": "ok"})


def start_mock_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAIHandler)
    server.daemon_threads = True
    server.calls = []  # type: ignore[attr-defined]
    server.prompts = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}/v1"


# --------------------------------------------------------------------------
# Environment / client
# --------------------------------------------------------------------------


def configure_environment(base_url: str, data_dir: str) -> None:
    """Set every knob before importing/constructing the SDK."""
    env = {
        "MEMORY_DATA_DIR": data_dir,
        "MEMORY_MODE": "pro",
        "MEMORY_ENABLE_GRAPH": "0",
        "MEMORY_HISTORY_ENABLE": "0",
        "MEMORY_METRICS": "0",
        "MEMORY_COLLECTION_NAME": "smoke_memories",
        # LLM (chat completions)
        "MEMORY_LLM_BASE_URL": base_url,
        "MEMORY_LLM_API_KEY": "mock-key",
        "MEMORY_LLM_MODEL": "mock-chat",
        "MEMORY_LLM_TIMEOUT": "30",
        "MEMORY_LLM_MAX_RETRIES": "2",
        "MEMORY_LLM_RETRY_DELAY": "0.1",
        "MEMORY_LLM_TEMPERATURE": "0",
        # Embeddings
        "MEMORY_EMBEDDER_BASE_URL": base_url,
        "MEMORY_EMBEDDER_API_KEY": "mock-key",
        "MEMORY_EMBEDDER_MODEL": "mock-embed",
        "MEMORY_EMBEDDER_TIMEOUT": "15",
        "MEMORY_EMBEDDER_MAX_RETRIES": "0",
        "MEMORY_EMBEDDER_RETRY_DELAY": "0.0",
        "MEMORY_EMBEDDING_DIMS": str(EMBED_DIMS),
        # Keep optional subsystems out of the way.
        "MEMORY_ENABLE_SEARCH_QUERY": "0",
        "MEMORY_ENABLE_QUERY_REWRITE": "0",
        "MEMORY_AUTO_ROUTING": "0",
        "MEMORY_PIPELINE_TRACE_ENABLED": "0",
    }
    os.environ.update(env)
    # A stray OpenAI key would be picked up as a fallback; remove ambiguity.
    for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "LLM_BASE_URL"):
        os.environ.pop(key, None)


def chat_memories(search: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Flatten the chat search envelope.

    ``search()`` on the chat path returns
    ``{"memories": {"schema": [...], "proactive": [...], "normal": [...]}}``.
    A naive ``len()`` on that dict is 3 and would pass vacuously, so the
    channels are flattened explicitly.
    """
    memories = search.get("memories")
    if isinstance(memories, list):
        return list(memories)
    if isinstance(memories, dict):
        items: List[Dict[str, Any]] = []
        for channel in ("schema", "proactive", "normal"):
            items.extend(memories.get(channel) or [])
        return items
    return []


def list_state_files(root: str) -> List[str]:
    found: List[str] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            found.append(os.path.relpath(full, root).replace("\\", "/"))
    return sorted(found)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="hy_memory_smoke_")
    server = None
    client = None
    summary: Dict[str, Any] = {"ok": False, "data_dir": data_dir}
    try:
        server, base_url = start_mock_server()
        configure_environment(base_url, data_dir)
        summary["mock_base_url"] = base_url

        # Import only after the env is in place.
        from hy_memory import HyMemoryClient

        client = HyMemoryClient(mode="pro")
        summary["client_mode"] = client.mode

        # ---------------- 1. chat memory ----------------
        chat_add = client.add(
            CHAT_MEMORY_TEXT,
            user_id="smoke_user",
            agent_id="smoke_agent",
            session_id="chat_session",
            source="research_smoke",
            meta={"kind": "chat"},
        )
        chat_search = client.search(
            "Which hiking trail does the user like near Boulder?",
            user_ids=["smoke_user"],
            limit=5,
            min_score=0.3,
        )

        # ---------------- 2. coding memory (real tool-call trace) ----------------
        messages = [
            {
                "role": "user",
                "content": "Fix the divide-by-zero crash in src/calc.py on branch fix/divzero.",
            },
            {
                "role": "assistant",
                "content": "I will patch the guard in divide().",
                "tool_calls": [
                    {
                        "id": "call_patch_1",
                        "type": "function",
                        "function": {
                            "name": "apply_patch",
                            "arguments": json.dumps(
                                {"path": "src/calc.py", "branch": "fix/divzero"}
                            ),
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_patch_1",
                "name": "apply_patch",
                "content": TOOL_DIFF,
            },
        ]
        coding_add = client.add(
            messages,
            scene="coding",
            user_id="smoke_user",
            agent_id="smoke_agent",
            session_id="coding_session",
            workspace_id="demo",
            branch="fix/divzero",
            source="research_smoke",
            meta={"kind": "coding"},
        )
        coding_search = client.search(
            "How is divide by zero handled in src/calc.py?",
            scene="coding",
            user_ids=["smoke_user"],
            workspace_id="demo",
            branch="fix/divzero",
            limit=5,
        )

        # ---------------- 3. assertions ----------------
        chat_items = chat_memories(chat_search)
        chat_channels = chat_search.get("memories") if isinstance(chat_search.get("memories"), dict) else {}
        coding_facts = coding_search.get("facts") or []
        coding_experiences = coding_search.get("experiences") or []

        checks = {
            "chat_add_success": chat_add.get("success") is True,
            "chat_add_scene_chat": chat_add.get("scene") == "chat",
            "chat_add_memory_id": bool(chat_add.get("memory_id")),
            "chat_search_has_memory": len(chat_items) >= 1,
            "coding_add_success": coding_add.get("success") is True,
            "coding_add_scene_productivity": coding_add.get("scene") == "productivity",
            "coding_add_experience_ids": bool(coding_add.get("experience_ids")),
            "coding_add_fact_ids": bool(coding_add.get("fact_ids")),
            "coding_search_scene_productivity": coding_search.get("scene") == "productivity",
            "coding_search_has_fact": len(coding_facts) >= 1,
            "coding_search_has_experience": len(coding_experiences) >= 1,
            "coding_search_has_chain_block_key": "chain_block" in coding_search,
            "coding_search_has_chain_used_key": "chain_used" in coding_search,
            "coding_search_chain_block_nonempty": bool(coding_search.get("chain_block")),
            "coding_search_chain_used_nonempty": bool(coding_search.get("chain_used")),
        }
        failed = [name for name, ok in checks.items() if not ok]

        summary.update(
            {
                "ok": not failed,
                "checks": checks,
                "http_calls": {
                    "chat_completions": sum(
                        1 for c in server.calls if c.endswith("/chat/completions")
                    ),
                    "embeddings": sum(1 for c in server.calls if c.endswith("/embeddings")),
                },
                "chat_add_keys": sorted(chat_add.keys()),
                "chat_add": {
                    "success": chat_add.get("success"),
                    "scene": chat_add.get("scene"),
                    "memory_id": chat_add.get("memory_id"),
                    "request_id": chat_add.get("request_id"),
                },
                "chat_search_keys": sorted(chat_search.keys()),
                "chat_search": {
                    "channel_counts": {
                        key: len(value) for key, value in chat_channels.items()
                    },
                    "returned": len(chat_items),
                    "top": chat_items[0] if chat_items else None,
                },
                "coding_add_keys": sorted(coding_add.keys()),
                "coding_add": {
                    "success": coding_add.get("success"),
                    "scene": coding_add.get("scene"),
                    "experience_ids": coding_add.get("experience_ids"),
                    "fact_ids": coding_add.get("fact_ids"),
                    "ops_summary": coding_add.get("ops_summary"),
                    "fact_ops_summary": coding_add.get("fact_ops_summary"),
                    "chain_rounds": coding_add.get("chain_rounds"),
                    "memory_id": coding_add.get("memory_id"),
                },
                "coding_search_keys": sorted(coding_search.keys()),
                "coding_search": {
                    "facts": len(coding_search.get("facts") or []),
                    "experiences": len(coding_search.get("experiences") or []),
                    "chain_block_len": len(coding_search.get("chain_block") or ""),
                    "chain_block_preview": (coding_search.get("chain_block") or "")[:400],
                    "chain_used": coding_search.get("chain_used"),
                    "top_fact": (coding_search.get("facts") or [{}])[0],
                    "top_experience": (coding_search.get("experiences") or [{}])[0],
                },
                "state_files": list_state_files(data_dir),
            }
        )

        if failed:
            summary["failed_checks"] = failed
            summary["raw"] = {
                "chat_add": chat_add,
                "chat_search": chat_search,
                "coding_add": coding_add,
                "coding_search": coding_search,
            }
    except Exception as exc:  # pragma: no cover - diagnostic path
        summary["error"] = f"{type(exc).__name__}: {exc}"
        import traceback

        summary["traceback"] = traceback.format_exc()
    finally:
        if client is not None:
            try:
                client.close()
            except Exception as exc:  # noqa: BLE001
                summary.setdefault("close_error", f"{type(exc).__name__}: {exc}")
        if server is not None:
            server.shutdown()
            server.server_close()

    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))
    if summary.get("ok"):
        shutil.rmtree(data_dir, ignore_errors=True)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
