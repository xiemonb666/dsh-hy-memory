# Online engine evidence

> Historical model results. Use [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md) for the current opt-in run and its limits. Earlier A/B figures do not prove the current Host semantic path or current service availability.

Measured on 2026-10-21 with the real Hy-Memory SDK 2.0.4 against real model
endpoints. This file records the exact configuration, the observed numbers, and
the provider quirks that decide whether the memory pipeline actually works.

Everything below was produced by a command in this repository. Nothing is
estimated from documentation.

## 1. Configuration in use

`<dataDir>/memory-engine.env`, loaded by `hymem_worker --env-file` (0600, never
committed; `artifacts/` is gitignored):

| Variable | Value | Why |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | `https://llm-o095xpj3z2paaqlo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | Aliyun Bailian compatible mode |
| `MEMORY_LLM_MODEL` | `deepseek-v4.1-flash` | extraction + reconciliation |
| `MEMORY_LLM_EXTRA_BODY` | `{"enable_thinking": false}` | **required**, see §3 |
| `MEMORY_EMBEDDER_BASE_URL` | same endpoint | one provider for both |
| `MEMORY_EMBEDDER_MODEL` | `qwen3.7-text-embedding-flash` | 1024 dimensions, verified by probe |
| `MEMORY_EMBEDDING_DIMS` | `1024` | must match the model, and must never change later |
| `MEMORY_MODE` | `pro` | embedding + LLM extraction; no graph |

The worker inherits nothing from argv; `packages/host-plugin/src/worker.ts` passes
`--env-file` when the file exists, so a deployment switches engines by writing one
file without touching code or the bundle patch.

### 1.1 One settings change is required for real embeddings

`recall.searchTimeoutMs` defaults to **2500 ms**, which is what the online
measurements need (1132–1268 ms of engine time plus worker round trip). A database
created before this default was raised keeps its persisted value — an install that
still has the old **900 ms** will recall nothing and report
`degraded: "timeout"` against a real endpoint. Raise it once:

```powershell
# Studio API, with the ui-token from <dataDir>/ui-token
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest "http://127.0.0.1:48731/studio/?token=$token" -WebSession $s -MaximumRedirection 0 | Out-Null
$cur = (Invoke-WebRequest "http://127.0.0.1:48731/api/settings" -WebSession $s).Content | ConvertFrom-Json
Invoke-WebRequest -Method Put "http://127.0.0.1:48731/api/settings" -WebSession $s -ContentType application/json `
  -Headers @{ 'x-hymemory-csrf' = $token } `
  -Body (@{ patch = @{ recall = @{ searchTimeoutMs = 2500 } }; expectedRevision = $cur.revision } | ConvertTo-Json -Depth 6)
```

Observed before/after on the live profile: `degraded: "timeout"`, 0 clues, 900 ms
→ 2 clues, 319 tokens, `degraded: null`, 1268 ms.

## 2. End-to-end results

### 2.1 Engine health (live plugin in the DSH profile)

```
GET http://127.0.0.1:48731/api/health   (authenticated)
ok=true  degraded=false
engine=hy-memory  engineVersion=2.0.4  workerOk=true  reason=''
```

The Studio header renders "后端健康状态：正常" (green) in this state; a screenshot
is omitted from the public snapshot and retained locally.

### 2.2 Opt-in verification script

```
node tests/e2e/online-engine.mjs      # exit 0, 9/9 checks
```

| Check | Observed |
|---|---|
| `ONLINE-1` SDK importable | pass |
| `ONLINE-2` real extraction produces a governance record | pass |
| `ONLINE-3` cross-process recall returns a clue | 1 clue |
| `ONLINE-4` recall not degraded | `degraded=null` |
| `ONLINE-5` payload inside budget | 152 tokens of 600 |
| `ONLINE-6` latency inside 2500 ms | 1132–1192 ms (engine), 2359 ms wall including worker start |
| `ONLINE-7` anchored but not auto-verified | status `supported`, evidence 1 |
| `ONLINE-8` untrusted-data container | pass |
| `ONLINE-9` audit chain valid | pass |

Extraction wall time per capture: 4192 ms (one short statement). This runs in the
background capture queue, so it never blocks an agent turn.

### 2.3 Real extracted content

Chat scene, planted statement "this repository pins CUDA 12.4 and runs the kernel
tests with pytest", recalled from a **separate process**:

```text
<memory_clues provenance="untrusted-retrieved-data" scope="workspace">
Note: observations recorded from earlier sessions in this project workspace. ...
[01a15d49-...][SUPPORTED][applies_to: workspace:ws_...] evidence=1 |
Memory: 该仓库固定使用 Python 3.12 和 pytest 运行 kernel 测试，CUDA 版本固定为 12.4。 |
memory_get({ id: "01a15d49-..." })
</memory_clues>
```

Coding scene from a real `tool_calls` + `role:"tool"` diff trace; the model stored
a fact **and** an experience, and preserved the qualifier on its own:

> "Confirmed by the `git diff` output only — no test run after the edit (the
> earlier `pytest` 3 passed predates it)."

That is the anti-pollution behaviour the plan asks for, produced by the real
model rather than by our prompt engineering.

### 2.4 Retrieval-value ablation (plan §16.3, "no memory" vs "auto Recall only")

```
node scripts/ab-recall.mjs --runs 3        # exit 0
```

| Arm | Payload | Hit rate (answer contains both `12.4` and `pytest`) |
|---|---|---|
| A — no memory | the question alone | **0 / 3** |
| B — with recall | the question, then the plugin's real rendered clue container as a second user message | **3 / 3** |

Arm A answers were consistently **"CUDA 12.1; pytest"** — a confident
hallucination of a version the model cannot know. Arm B answers were
**"CUDA 12.4, with pytest as the kernel test runner (memory id 01a15e34-...)"** —
correct and citing the record id.

Metrics: clue container 230 tokens, retrieval 1132–1238 ms, 1 clue of budget 600.

**Method note:** an earlier run of this script reported 0/3 for both arms. That
run was invalid: a shell-editing mistake interpolated the clue variable away, so
arm B sent the question alone and both arms were identical. The result above is
from the corrected script; `artifacts/ab-recall-pixel-gateway.json` holds the
invalid run and `artifacts/ab-recall-validated.json` the valid one.

## 3. Provider quirks that decide whether this works

All three were established by probe scripts in `artifacts/probe-*.mjs`, not by
reading vendor documentation.

### 3.1 A reasoning model returns empty content unless thinking is disabled

`deepseek-v4.1-flash` on this endpoint is a reasoning model with unbounded
thinking. With `max_tokens` 1024/4096 it always finished with
`finish_reason=length`, **all** tokens spent on `reasoning_content`, and
`content` empty — which makes every Hy-Memory extraction parse an empty string.

```
temp=0   mt=1024: finish=length content_len=0 reasoning=1024 out=1024
temp=0.1 mt=4096: finish=length content_len=0 reasoning=4096 out=4096
```

Fixed by `MEMORY_LLM_EXTRA_BODY={"enable_thinking": false}`:

```
deepseek-v4.1-flash {"enable_thinking":false}: CONTENT len=2 finish=stop reasoning=0
```

`{"reasoning_effort": "none"}` also works. Without one of the two, extraction
silently produces nothing usable.

### 3.2 The Pixel gateway drops every `system` message

`https://api.ai-pixel.online/v1` never delivers `system` (or `developer`) role
content to the model. A one-token probe, same token in three placements:

| Placement | Result |
|---|---|
| `system` role | **DROPPED** (`NOTOKEN`) |
| `user` role | VISIBLE |
| `developer` role | **DROPPED** |

Consequences for this plugin on that gateway:

- the clue injection still works, because `agent/pre-step` appends the container
  as a **user** message;
- the `ctx.systemPrompt.section` protocol guidance never reaches the model, so
  the model gets no instruction to use the memory.

The Bailian endpoint honours `system` (VISIBLE), which is why the validated
ablation above succeeds with the same container.

### 3.3 The Pixel gateway serves no embedding model

`GET /v1/models` lists only `deepseek-v4.1-flash` and
`deepseek-v4.1-flash-1017`. Probing `/v1/embeddings`:

| Model tried | Result |
|---|---|
| `text-embedding-3-small` | 503 `no_eligible_routing_group` |
| `text-embedding-3-large`, `text-embedding-ada-002`, `embedding-3` | 503 |
| `bge-m3`, `Qwen3-Embedding-8B`, `qwen3-embedding` | 503 |

The SDK has exactly one embedder implementation (`_embed_openai`,
`embed_service.py:774`), so `MEMORY_EMBEDDER_BASE_URL` must point at a service
that really answers `/v1/embeddings`.

## 4. Cost actually incurred

Records of real usage observed in logs, not invoices: one embedding call ≈ 26
prompt tokens; one short extraction ≈ 71 in / 65 out; the nine-check online
verification plus the ablation stayed in the low thousands of tokens in total.
No figure is claimed for a full working day of captures.

## 5. Reproducing all of this

```sh
# 1) create <dataDir>/memory-engine.env as in §1 (0600, gitignored)
node tests/e2e/online-engine.mjs          # 9 checks, real model calls
node scripts/ab-recall.mjs --runs 3       # ablation, real model calls
node artifacts/probe-system-role.mjs      # gateway role handling
node artifacts/probe-chat-config.mjs      # reasoning-model configuration
```

Automated acceptance (`pnpm run test:e2e`) deliberately stays on the
deterministic mock engine: free, fast, reproducible, and independent of any
provider's current behaviour.
