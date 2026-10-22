# E2E acceptance matrix

> Historical coverage map. Current executed suites and narrower proof boundaries are listed in [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md). The older “all 20 pass” statement is not a current full-product acceptance claim.

Mapping from the engineering plan's 20 acceptance scenarios to the test that
actually proves each one, with the exact command. A row marked **covered** has
an executable assertion in this repository; **partial** means the behaviour is
proven by a narrower unit or security test rather than by the end-to-end flow
the plan describes.

Commands use the bundled Node binary:

```sh
NODE="<DSH-install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
PY=".\.venv\Scripts\python.exe"
```

| ID | Scenario | Covered by | Command | Result |
|---|---|---|---|---|
| E2E-01 | New session captures; the next session recalls correctly | `tests/e2e/cross-session.mjs` E2E-01a..d — two separate processes, one data dir | `$NODE tests/e2e/cross-session.mjs` | **pass** (11/11 checks) |
| E2E-02 | Main agent plus two subagents share an authorized fact without duplicate writes | `tests/integration/multi-agent.spec.ts` (5 cases) drives the real `CapturePipeline` + `RecallController` with one main agent and two subagents: principal binding, exactly-one capture, replay idempotency, default-deny then explicit workspace grant, and private-record isolation. `tests/security/multiagent.spec.ts` T-A02/T-A04 add grant revocation and CAS 409. | `vitest run tests/integration/multi-agent.spec.ts` | **pass** (agent identities are constructed and passed to the real pipeline, not produced by a live DSH subagent spawn) |
| E2E-03 | A subagent's cross-project read is refused with zero leakage | `tests/security/multiagent.spec.ts` T-A01/T-A06/T-A07; `cross-session.mjs` E2E-03a/b | `vitest run tests/security/multiagent.spec.ts` | **pass** |
| E2E-04 | Message replay / process restart yields exactly one logical job | `cross-session.mjs` E2E-04a/b (replay in a new process); `multiagent.spec.ts` T-A03 (5 consumers) | `$NODE tests/e2e/cross-session.mjs` | **pass** |
| E2E-05 | A negative test result contradicting an agent claim never becomes VERIFIED | `tests/security/pollution.spec.ts` T-P01 | `vitest run tests/security/pollution.spec.ts` | **pass** |
| E2E-06 | Refactor, branch switch, revert produce correct stale/conditional | `tests/security/staleness.spec.ts` T-S01..S07 (real git repos) | `vitest run tests/security/staleness.spec.ts` | **pass** |
| E2E-07 | Top-K plus max tokens: every injection stays inside the budget | `tests/security/context-cost.spec.ts` T-C02/T-C03; `scripts/benchmark.mjs` (max 331 of 600) | `vitest run tests/security/context-cost.spec.ts` | **pass** |
| E2E-08 | Python worker exits; the Harness still codes normally | `tests/e2e/operations.mjs` E2E-08a/b — the test kills the worker and asserts degraded + readable | `$NODE tests/e2e/operations.mjs` | **pass** |
| E2E-09 | Prompt injection inside memory is not executed | `pollution.spec.ts` T-P05; `context-cost.spec.ts` T-C07 (container escaping) | `vitest run tests/security` | **pass** |
| E2E-10 | Revoking a grant invalidates a cached recall on the next call | `context-cost.spec.ts` T-C06; `multiagent.spec.ts` T-A02 | `vitest run tests/security/context-cost.spec.ts` | **pass** |
| E2E-11 | UI search, detail, revision, refresh with real persistence | `tests/e2e/ui-roundtrip.mjs` E2E-11a..f — a real browser opens the drawer, changes a record, reloads the page and reads the new state back; `api-e2e.mjs` E2E-11a..c; `ui-acceptance.mjs` | `$NODE tests/e2e/ui-roundtrip.mjs` | **pass** |
| E2E-12 | Conflict review with optimistic version check and audit | `api-e2e.mjs` E2E-12a; `tests/unit/governance.spec.ts` (conflict resolve + versions); `multiagent.spec.ts` T-A04 | `$NODE tests/e2e/api-e2e.mjs` | **pass** |
| E2E-13 | Filtering by project never leaks another project's ids or counts | `api-e2e.mjs` E2E-13; `multiagent.spec.ts` T-A01/T-A06; `context-cost.spec.ts` T-C01 | `$NODE tests/e2e/api-e2e.mjs` | **pass** |
| E2E-14 | Permission denial, offline, empty and slow states are explicit and recoverable | `ui-acceptance.mjs` E2E-14a..f (drawer focus, unknown route, aborted API, 403) | `$NODE tests/e2e/ui-acceptance.mjs` | **pass** (20/20) |
| E2E-15 | Dark/light at three widths without overflow, keyboard operable | `ui-acceptance.mjs` E2E-15a..d; `tests/e2e/screenshots.mjs` (58 PNGs) | `$NODE tests/e2e/ui-acceptance.mjs` | **pass** |
| E2E-16 | Uninstall plus reinstall keeps memory and does not damage the old config | `operations.mjs` E2E-16a..d against profile `hymem-spike` | `HYMEM_PROFILE=hymem-spike $NODE tests/e2e/operations.mjs` | **pass** |
| E2E-17 | The engine state is always labelled honestly: real+healthy, or mock/unavailable with a stated reason | `operations.mjs` E2E-17; `/api/health` reports `engine: mock, degraded: true, reason: "no model endpoint configured"` | `$NODE tests/e2e/operations.mjs` | **pass** |
| E2E-18 | Backup, restore and migration keep metadata, index, evidence and tombstones consistent | `operations.mjs` E2E-18a..c (backup → restore → status → reindex); `pollution.spec.ts` T-P07 (tombstone across restart) | `$NODE tests/e2e/operations.mjs` | **pass** |
| E2E-19 | A secret or PII in a tool result never reaches memory, logs or cloud requests | `cross-session.mjs` E2E-19 (scans the SQLite file and WAL for the key); `pollution.spec.ts` T-P05 | `$NODE tests/e2e/cross-session.mjs` | **pass** |
| E2E-20 | 10k memories paginate and retrieve with recorded p50/p95 and memory | `scripts/run-benchmark.mjs --count 10000`; `context-cost.spec.ts` T-C01 | `$NODE scripts/run-benchmark.mjs --count 10000` | **pass** (p50 14.6 ms, p95 20.2 ms, 0 budget violations) |

## Summary

| Status | Count |
|---|---:|
| pass (executable assertion) | 20 |
| partial | 0 |
| not implemented | 0 |
| **total IDs** | **20** |

Counted mechanically from the row table above:
`(Select-String -Path docs\E2E_MATRIX.md -Pattern '\*\*pass\*\*').Count` = 20.

**One caveat, stated rather than hidden:** E2E-02 exercises the real capture and
recall pipelines with two subagent principals, but those identities are
constructed in the test rather than produced by a live DSH subagent spawn, because
a live DSH subagent spawn needs a driven model session. Its grant, CAS and 409
behaviour is additionally asserted in `tests/security/multiagent.spec.ts`.

## Reproducing the whole suite

```sh
$NODE node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 0
$NODE node_modules/vitest/vitest.mjs run                          # 86 tests
$PY -m pytest python/tests -q                                     # 30 tests
$NODE tests/e2e/cross-session.mjs                                 # 11 checks
$NODE tests/e2e/api-e2e.mjs                                       # 15 checks
$NODE tests/e2e/operations.mjs                                    # 10 checks
$NODE tests/e2e/ui-acceptance.mjs                                 # 20 checks
$NODE tests/e2e/ui-roundtrip.mjs                                  # 10 checks
$NODE tests/e2e/dsh-integration.mjs                               # 3 checks (needs DSH_WEB_TOKEN)
$NODE scripts/run-benchmark.mjs --count 10000
```
