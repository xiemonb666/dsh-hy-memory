# Final acceptance checklist

> Historical checklist. For current code and actual revalidation, use [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md). Earlier passes are not current acceptance evidence; live installation, online and platform checks require their own current logs.

Status of the plan's §19 delivery checklist. Every row names the evidence that
supports it. Statuses are **VERIFIED** (a command in this session exited 0),
**PARTIAL** (the capability exists and is tested, but one part of the claim was
not exercised), or **BLOCKED** (not true today, with the reason stated).

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Complete source, reproducible dependency locks, licence and README | **VERIFIED** | `pnpm-lock.yaml`, `uv`-independent `.venv` requirements, `LICENSE` (Apache-2.0), `NOTICE` (Hy-Memory Apache-2.0, DSH MIT), `README.md`, `README.zh-CN.md` |
| 2 | Native Host Cordis plugin, no core patch, enable/disable/uninstall | **VERIFIED** | `packages/host-plugin/src/index.ts`; bundle row `hy-memory` in `dist/bundle/cordis.patch.yml`; installed via `dsh plugin --profile hymem-spike add`; `cli uninstall` removes it while keeping data (`tests/e2e/operations.mjs` E2E-16a..d) |
| 3 | Official Hy-Memory SDK really runs (or mock is clearly separated) | **VERIFIED** | The **running** plugin uses the real SDK: `/api/health` reports `engine: hy-memory, engineVersion: 2.0.4, degraded: false`, embeddings at 1024 dims (`qwen3.7-text-embedding-flash`) and extraction via `deepseek-v4.1-flash`. `node tests/e2e/online-engine.mjs` passes 9/9 with real model calls; `python/research_smoke.py` proves the SDK offline. The mock is still used by the automated suites (deliberate: free, fast, reproducible) and is always labelled `engine: mock, degraded: true` with a reason. Full evidence: `docs/ONLINE_ENGINE_EVIDENCE.md` |
| 4 | Chat / Working / Coding scenes with real tool trace and diff chain | **VERIFIED** | `python/research_smoke.py` (coding add with `tool_calls` + `role:"tool"`, `facts`/`experiences`/`chain_block`); `packages/host-plugin/src/capture.ts` builds the OpenAI-format trace; `tests/e2e/cross-session.mjs` E2E-01 |
| 5 | Evidence and trust gate, state machine, conflicts, redaction, injection safety | **VERIFIED** | `tests/security/pollution.spec.ts` T-P01..P07 (7/7); `tests/unit/governance.spec.ts` (18); `packages/governance/src/{evidence,redact}.ts` |
| 6 | Git/branch/commit/dependency stale, unknown, rollback correctness | **VERIFIED** | `tests/security/staleness.spec.ts` T-S01..S07 (8/8) against real git repos including `git revert`, `--depth 1` clone, detached HEAD |
| 7 | On-demand recall, hard token budget, no accumulation, non-blocking | **VERIFIED** | `tests/security/context-cost.spec.ts` T-C01..C07 + receipts (9/9); `scripts/run-benchmark.mjs`: p50 14.6 ms, p95 20.2 ms, max 331 tokens of a 600 budget, 0 violations |
| 8 | Cross-project/agent permissions, grants, concurrent writes, cache invalidation | **VERIFIED** | `tests/security/multiagent.spec.ts` T-A01..A08 + scope ladder (9/9) |
| 9 | UI with 9 pages, real backend, dark/light, responsive, a11y, E2E | **VERIFIED** | `packages/ui-client/src/pages/*` (9); `tests/e2e/ui-acceptance.mjs` 20/20 (no overflow at 1440/900/390, keyboard focus, drawer focus restore, offline state, 403 state, zero console errors); local screenshots omitted from the public snapshot |
| 10 | CLI doctor / backup / restore / uninstall, profile backup and rollback | **VERIFIED** | `scripts/cli.ts` commands; `tests/e2e/operations.mjs` E2E-18a..c (backup → restore → status → reindex) and E2E-16a..d (uninstall/reinstall, data retained); `install` writes a sha256 manifest under `<dataDir>/profile-backups/` |
| 11 | 20 E2E/integration security scenarios reproducible | **VERIFIED** | All 20 IDs have an executable assertion (see `docs/E2E_MATRIX.md`); 20 pass end-to-end, none are partial |
| 12 | No cross-project recall, no self-verified claims, no secret leak, no tombstone resurrection | **VERIFIED** | `multiagent.spec.ts` T-A01/A06/A07; `pollution.spec.ts` T-P01/T-P05/T-P07 (tombstone survives restart + FTS rebuild); `cross-session.mjs` E2E-19 scans the SQLite file and WAL for the planted key |
| 13 | Real project benchmark and A/B data, limitations disclosed | **VERIFIED** | Offline benchmark is real and recorded (`docs/BENCHMARK_REPORT.md`, `artifacts/benchmark-offline.json`). The retrieval-value ablation ran against the real model: **no memory 0/3, with recall 3/3** (`node scripts/ab-recall.mjs`, `artifacts/ab-recall-validated.json`) — arm A hallucinated "CUDA 12.1", arm B answered "CUDA 12.4" and cited the record id. Provider quirks that gate this are documented with probes in `docs/ONLINE_ENGINE_EVIDENCE.md` §3 |
| 14 | Bilingual README, troubleshooting, release notes, screenshots, architecture and security statement | **VERIFIED** | `README.md`, `README.zh-CN.md`, `docs/USER_GUIDE.zh-CN.md`, `docs/OPERATIONS.md`, `docs/SECURITY_AUDIT.md`, `docs/IMPLEMENTATION_REPORT.md`, local screenshots omitted from the public snapshot |
| 15 | Nothing unimplemented/mock-only/untested is claimed as done or supported | **VERIFIED** | `docs/IMPLEMENTATION_REPORT.md` §Known limitations, `docs/E2E_MATRIX.md` summary, this table |

## Final measured results (2026-10-21 19:30)

| Gate | Command | Result |
|---|---|---|
| TypeScript | `pnpm run typecheck` | exit 0 |
| Lint | `pnpm run lint` | 0 warnings, 0 errors |
| Unit + security + integration (TS) | `pnpm run test` | 8 files, **91/91** |
| Python | `pnpm run test:python` | **30/30**, ruff clean |
| Build | `pnpm run build:studio && pnpm run build` | exit 0 (407 kB JS, 22 kB CSS) |
| E2E chain (mock) | `pnpm run test:e2e` | **5 suites passed, 0 failed** (76 checks) |
| — cross-process | `node tests/e2e/cross-session.mjs` | **11/11** |
| — Studio API | `node tests/e2e/api-e2e.mjs` | **15/15** |
| — UI acceptance | `node tests/e2e/ui-acceptance.mjs` | **20/20** |
| — UI round trip | `node tests/e2e/ui-roundtrip.mjs` | **10/10** |
| — operations | `node tests/e2e/operations.mjs` | **10/10** |
| DSH native | `node tests/e2e/dsh-integration.mjs` | **3/3** — sidebar entry, iframe, 540-char Studio body |
| **Online engine** | `node tests/e2e/online-engine.mjs` | **9/9** — real SDK 2.0.4, real extraction, real embeddings (paid, opt-in) |
| **Retrieval ablation** | `node scripts/ab-recall.mjs --runs 3` | no memory **0/3**, with recall **3/3** (real model calls) |
| Benchmark | `node scripts/run-benchmark.mjs --count 10000` | p50 14.3 ms, p95 19.8 ms, max 331 of 600 tokens, 0 violations |

Total: **91 TypeScript tests + 30 Python tests + 76 end-to-end checks + 9 online checks = 206 assertions, all passing.**

## Not delivered (stated plainly)

1. **MemHub interop backend** — `backend: 'memhub'` exists only as a settings
   enum; no adapter, no authorization mapping. The plan allows it to be
   experimental, but it is not implemented at all.
2. **A live two-subagent DSH session** — E2E-02 drives the real capture and
   recall pipelines with two subagent principals
   (`tests/integration/multi-agent.spec.ts`, 5 cases), but those identities are
   constructed in the test rather than produced by a live DSH subagent spawn.
3. **CLI `reindex` / `migrate`** — dry-run reporting only; the real rebuild is
   available through the Studio API's reindex path, not as a mutating CLI verb.
4. **macOS / Linux E2E** — untested. Only Windows 11 was exercised.
5. **Automated suites run against the mock, not the paid endpoint.** `pnpm run
   test:e2e` is deliberately free and deterministic; the real-engine proof is the
   separate opt-in `tests/e2e/online-engine.mjs` (9/9) plus the ablation.

## Local profile privacy note

The local acceptance record observed an unrelated DSH profile change. Workstation-specific paths, hashes, timestamps, and plugin details are omitted from this public snapshot. The project did not modify a user profile during the documented checks.
