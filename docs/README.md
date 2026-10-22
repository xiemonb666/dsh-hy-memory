# Documentation

Current entrypoint: [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md). The earlier acceptance, implementation, online and benchmark reports retain historical evidence; their pass counts are not current revalidation. The former “single source of truth” statement below applies to the historical coverage map only.

Six delivery documents, the canonical E2E matrix, and the two internal references
this repository already had. English except the Chinese user guide and the
Chinese README.

| Document | Audience | Answers |
|---|---|---|
| [../README.md](../README.md) | anyone landing on the repo | what it is, architecture, what works, what does not, license |
| [../README.zh-CN.md](../README.zh-CN.md) | 中文读者 | 同上 |
| [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) | reviewer / lead | per work package: files, APIs, exact command, exit code, evidence path, known failures, status |
| [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | reviewer / security | threat model, mechanisms, the test that proves each mitigation, residual risk |
| [BENCHMARK_REPORT.md](BENCHMARK_REPORT.md) | reviewer / performance | measured offline numbers, dataset shapes, what was **not** measured |
| [OPERATIONS.md](OPERATIONS.md) | operator | install, upgrade, backup, restore, migrate, reindex, paths, logs, degraded modes, rollback |
| [USER_GUIDE.zh-CN.md](USER_GUIDE.zh-CN.md) | 使用者 | 安装、启用、首次采集、浏览、证据、冲突、权限、队列、设置、诊断、排障、卸载 |
| [E2E_MATRIX.md](E2E_MATRIX.md) | reviewer / QA | all 20 acceptance IDs → the test that proves each, with its command; 20 pass, 0 partial |
| [ONLINE_ENGINE_EVIDENCE.md](ONLINE_ENGINE_EVIDENCE.md) | reviewer / operator | the real SDK against real endpoints: measured numbers, the no-memory vs with-recall ablation, and the provider quirks (dropped `system` role, reasoning-model empty content, no embedding model) that gate it |
| [internal/API_CONTRACT.md](internal/API_CONTRACT.md) | implementer | the frozen HTTP contract for the worker and the Studio API |
| [internal/DSH_API_MAP.md](internal/DSH_API_MAP.md) | implementer | the DSH extension points used here, with source citations |

`E2E_MATRIX.md` is the **single source of truth** for acceptance coverage. Any
count of passing scenarios in the other documents defers to it.

## Reading order

1. `README.md` — decide whether the current state is usable for you.
2. `OPERATIONS.md` — get it running, and know where its data and logs are.
3. `USER_GUIDE.zh-CN.md` — day-to-day use.
4. `IMPLEMENTATION_REPORT.md` — what is proven and what is not.
5. `SECURITY_AUDIT.md` — what the guarantees actually are, and where they stop.
6. `BENCHMARK_REPORT.md` — the numbers, and the ones that do not exist.

## Rules every document here follows

These are the constraints the documents were written under, so a reader can
audit the writing as well as the code.

1. **No invented numbers.** Every figure is either produced by a command quoted
   next to it, or read from a named file/line. Where a number in an earlier brief
   disagreed with what I measured, the measured value is reported and the
   disagreement is stated (see `BENCHMARK_REPORT.md` §6: 404 kB vs 406.81 kB).
2. **Every claimed pass names its command and its file.** A row that says
   "verified" is backed by a command in this session with a recorded exit code,
   or by a test whose `file:line` is cited.
3. **Three status words, used strictly.**
   - **VERIFIED** — a command in this session exited 0 and its output proves it.
   - **SUPPORTED** — code plus an observed run prove it, but the run needs a
     credential or an endpoint that is not always present.
   - **BLOCKED** — not true today, or unprovable. The blocking condition is named.
4. **Gaps are listed, not softened.** If something is unimplemented, the document
   says so in the same table where the working features are listed.
5. **No marketing language.** No "seamless", "blazing", "enterprise-grade", no
   performance adjectives without a number.
6. **Present tense, current state.** What the code does now, not what it is
   planned to do.

## Known documentation limits

- The engineering plan referenced by the delivery brief (its §6.5, §7.5, §8.5,
  §13.3, §14.1 and the 20-item E2E matrix) is **not in this repository**. The
  documents reconstruct the proof format from the brief. For acceptance
  coverage, `E2E_MATRIX.md` is authoritative and states, per ID, which test
  proves it.
- The upstream DSH license could not be verified on this machine: DSH ships
  inside `resources/app.asar`, which is not readable as files here. `NOTICE` and
  both READMEs record MIT as the upstream *declaration* and say it was not
  verified locally.
- The DSH panel E2E (`dsh-integration.mjs`) needs `DSH_WEB_TOKEN` from the
  `dsh web:` boot line. It has been run successfully (3/3) but is not part of the
  credential-free reproduction path, so treat it as conditionally reproducible
  rather than always-on.

## Quick evidence index

| Claim | Where to look |
|---|---|
| 86 TS tests pass | `IMPLEMENTATION_REPORT.md` WP-09 table; log `artifacts/docs-dev-vitest.log` |
| 30 Python tests pass | same table; `artifacts/docs-dev-pytest.log` |
| Capture works | `artifacts/docs-dev-capture.log` |
| Recall costs 105 tokens | `artifacts/docs-dev-search.log`; `injection_receipts` in `artifacts/e2e-data/governance.db` |
| 15/15 API E2E | `artifacts/docs-dev-api-e2e-bundled.log` |
| 11/11 cross-process E2E | `artifacts/docs-dev-cross-session.log` |
| 10/10 operational E2E | `artifacts/docs-dev-operations.log` |
| 20/20 UI acceptance | `artifacts/docs-dev-ui-acceptance.log` |
| Real SDK round-trip | `artifacts/docs-dev-smoke.log` |
| Offline benchmark | `artifacts/benchmark-offline.json` |
| Acceptance coverage per plan ID | `E2E_MATRIX.md` — 20 of 20 have an assertion: 20 pass, 0 partial |
| The earlier activation failure (fixed) | `%LOCALAPPDATA%\dsh-hy-memory\logs\plugin.log` (timestamp `2026-10-20T14:11:21Z`) |



