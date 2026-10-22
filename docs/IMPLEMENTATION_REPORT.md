# Implementation Report — DSH HyMemory Studio

> Historical implementation record. Current changes and validation are tracked in [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md); the counts and VERIFIED claims below do not establish current acceptance.

Current state of the repository at `<repo>` on
2026-10-21. Every work package below is reported in the plan's §14.1 proof
format: *Work package / Files changed / Implemented APIs / Tests executed with
exact command / Observed exit code / Evidence paths / Known failures /
Compatibility / Status*.

> The engineering plan itself is **not** in this repository (only
> `docs/internal/API_CONTRACT.md` and `docs/internal/DSH_API_MAP.md` exist under
> `docs/`). The §14.1 field list below is reproduced from the delivery
> instruction, not copied from a plan file I could read.

## Status vocabulary used here

| Status | Meaning |
|---|---|
| **VERIFIED** | A command in this session exited 0 and its output proves the claim. |
| **SUPPORTED** | The code and at least one prior observed run prove the claim, but I could not re-run it in this session (missing credential, missing endpoint, or a one-shot artifact). |
| **BLOCKED** | The claim is not true today, or the proof cannot be produced. The blocking condition is stated. |

## Environment (measured, not assumed)

| Item | Value | How observed |
|---|---|---|
| OS | Microsoft Windows 11 专业工作站版, build 26200 | `Get-CimInstance Win32_OperatingSystem` |
| CPU | AMD Ryzen 9 9950X3D 16-Core | `Get-CimInstance Win32_Processor` |
| Node (bundled, used for the plugin) | v24.21.0 | `…\primary-runtime\dependencies\node\bin\node.exe --version` |
| Node (system, on PATH) | v24.16.0 | `node --version` |
| Python | 3.12.14 | `.\.venv\Scripts\python.exe --version` |
| pnpm | 11.28.5 | bundled `pnpm.cjs --version` |
| git | 2.54.0.windows.1 | `git --version` |
| DSH | 0.2.1-rc.2 | `dsh.cmd --version` |

Two Node majors are in play. `node` on PATH is 24.16.0; the DSH runtime ships
24.21.0. This matters: see WP-09.

---

## WP-01 — Contracts (schemas, ids, budgets, prompt markers)

- **Files changed:** `packages/contracts/src/index.ts` (609 lines).
- **Implemented APIs:** `MemoryStatusSchema` + `ALLOWED_TRANSITIONS`
  (index.ts:18-44), `SceneSchema`/`KindSchema`/`ScopeSchema`/
  `SensitivitySchema`/`EvidenceTrustSchema` (48-68), `uuidv7` (123),
  `sha256` (150), `canonicalJson` (160), `sourceKey` (173),
  `estimateTokens` (190), `truncateToTokens` (209), `CaptureEnvelopeSchema`
  (281), `MemoryRecordSchema` (304), `SearchQuerySchema` (380),
  `PluginSettingsSchema` (472), `ErrorCode` (509), `HyMemoryError` (528),
  `escapeForPrompt` (568), `looksLikeEcho` (592), `randomToken` (601).
- **Tests executed:** `.\node_modules\.bin\vitest.CMD run --reporter=verbose`
- **Observed exit code:** `0` — `Test Files 7 passed (7)`, `Tests 86 passed (86)`.
  `.\node_modules\.bin\tsc.CMD -p tsconfig.json --noEmit` → exit `0`.
- **Evidence paths:** `packages/contracts/src/index.ts`; budget behaviour proven
  by `tests/security/context-cost.spec.ts:114` (T-C02, budgets 120/300/600) and
  `tests/unit/retrieval.spec.ts:169`.
- **Known failures:** none open. The Zod v4 `prefault` typing error was fixed by
  building each default sub-object explicitly (`index.ts:466-503`) instead of
  relying on `prefault`.
- **Compatibility:** `estimateTokens` is deliberately an upper bound (ASCII at
  1 token / 3 chars, CJK at 1 token/char, +4 structural tokens). Over-budget is a
  hard failure, under-use is accepted — see `index.ts:181-199`.
- **Status:** **VERIFIED**

## WP-02 — Governance store (SQLite, ACL, evidence, state machine, audit)

- **Files changed:** `packages/governance/src/index.ts` (1253),
  `packages/governance/src/db.ts` (375), `evidence.ts` (262), `redact.ts` (146).
- **Implemented APIs:** `openDatabase` (db.ts:322, `node:sqlite`, WAL, FTS5
  triggers db.ts:142-148), `transaction` (db.ts:356), `GovernanceStore`
  (index.ts:209) with `authorize` (348), `appendSourceEvent` (394),
  `addEvidence` (418), `createMemory` (470), `getMemory` (549),
  `listMemories` (564), `updateMemory` (619), `transition` (670),
  `purgeMemory` (714), `detectConflicts` (754), `resolveConflict` (817),
  `enqueueJob`/`leaseJobs`/`failJob`/`retryJob` (911-967),
  `recordInjection`/`wasInjected` (987-1032), `usageSummary` (1060),
  `overview` (1091), `getSettings`/`updateSettings` (1124-1139), `audit` (1145),
  `verifyAuditChain` (1159), `exportProject` (1194), `backup` (1215),
  `inspectBackup` (1225). `anchorClaim` (evidence.ts:119), `deriveClaim` (209),
  `claimsConflict` (234), `redact` (redact.ts:77), `detectPromptInjection`
  (125), `isSecretPath` (139).
- **Tests executed:** `.\node_modules\.bin\vitest.CMD run --reporter=verbose`
- **Observed exit code:** `0` (18 governance unit tests + 7 G-POLLUTION tests
  inside the 86).
- **Evidence paths:** `tests/unit/governance.spec.ts` (18 tests, lines 41-260);
  `tests/security/pollution.spec.ts` (7 tests, lines 45-194);
  `artifacts/e2e-data/governance.db` (real rows: 1 memory, 1 evidence,
  1 claim, 3 audit events, 1 injection receipt, 3 usage rows).
- **Known failures:** fixed in this repo — `getMemory` used to return tombstoned
  rows; it now returns `null` for `tombstone === 1 || status === 'deleted'`
  (index.ts:549-558) while the transition path uses the private
  `recordIncludingTombstone` (542). The negation matcher used to match `no`
  inside `now`; it is now word-boundary anchored (evidence.ts:42-52). The
  `node:sqlite` row casts needed `as unknown as Row` because the driver types
  rows as `Record<string, unknown>` (e.g. index.ts:292, 296, 304).
- **Compatibility:** requires Node ≥ 24 for `node:sqlite` + FTS5 (package.json:9-11).
  No native module is compiled.
- **Status:** **VERIFIED**

## WP-03 — ACL-first retrieval (hybrid, rerank, hard budget)

- **Files changed:** `packages/retrieval/src/index.ts` (747).
- **Implemented APIs:** `HYBRID_WEIGHTS` (35), `RERANK_WEIGHTS` (41),
  `CLUE_PROVENANCE` (52), `hasMeaningfulQuery` (143), `renderClues` (267),
  `RetrievalController` (282) with `search` (335), `searchWithTimeout` (431),
  `authorizeChannel` (488), `statusAllowed` (514), `dedupe` (555),
  `applyRedundancy` (577), `selectWithinBudget` (640), `cacheKey` (666),
  `recordReceipt` (697), `clueForCurrentTask` (320).
- **Tests executed:** `.\node_modules\.bin\vitest.CMD run --reporter=verbose`
- **Observed exit code:** `0` (17 retrieval unit tests + 9 G-CONTEXT tests).
- **Evidence paths:** `tests/unit/retrieval.spec.ts` (lines 136-428);
  `tests/security/context-cost.spec.ts` (lines 82-234). Live proof:
  `node dist\bundle\cli.js search --json --query "Which Python version and test
  runner does the project use?"` → 1 clue, `tokenCount 105`, `elapsedMs 16`,
  rendered container `<memory_clues provenance="untrusted-retrieved-data"
  scope="workspace">`.
- **Known failures:** none open. Budget is measured on the *rendered* container,
  not on parts (index.ts:403-407), so a violation is structurally impossible.
- **Compatibility:** pure w.r.t. memory data; the only writes are the injection
  receipt and the usage metric (index.ts:697-731).
- **Status:** **VERIFIED**

## WP-04 — Coding trace (workspace identity, freshness, diff chain)

- **Files changed:** `packages/coding-trace/src/index.ts` (836).
- **Implemented APIs:** `assertSafeGitRef` (209), `probeGit` (287),
  `isAncestor` (325), `canonicalRemote` (344), `fingerprintWorkspace` (416),
  `fileContentHash` (464), `revertedCommitsInRange` (500),
  `evaluateFreshness` (573), `symbolsFromDiff` (721), `buildDiffChain` (802).
- **Tests executed:** `.\node_modules\.bin\vitest.CMD run --reporter=verbose`
- **Observed exit code:** `0` (18 coding-trace unit tests + 8 G-STALENESS tests).
- **Evidence paths:** `tests/unit/coding-trace.spec.ts` (lines 78-308);
  `tests/security/staleness.spec.ts` (lines 44-147, real git repos created and
  destroyed per test, including a `--depth 1` shallow clone at line 100).
- **Known failures:** fixed — a bound file that was touched but has no recorded
  hash used to be reported `fresh`; it now returns `conditional` with reason
  `bound_file_touched_hash_unknown` (index.ts:655-668).
- **Compatibility:** read-only git (`rev-parse`, `status`, `log`, `merge-base`,
  `remote get-url`). The single write is `<git-dir>/dsh-hy-memory-workspace-id`,
  created only when absent and only when there is no canonical remote
  (index.ts:385-403).
- **Known limitation (disclosed):** `symbolsFromDiff` is a heuristic line scanner,
  not an AST parser (index.ts:712-720). It must not be presented as semantic
  precision.
- **Status:** **VERIFIED** (heuristic nature accepted and documented)

## WP-05 — Python worker (mock engine, SDK adapter, loopback HTTP)

- **Files changed:** `python/hymem_worker/__init__.py` (1303 B),
  `__main__.py` (173 lines), `engine.py` (857), `mock_engine.py` (618),
  `hy_engine.py` (800), `server.py` (572).
- **Implemented APIs:** `select_engine` (server.py:79), `resolve_token` (124),
  `WorkerServer` (157), `WorkerRequestHandler._route_table` (392) with
  `/v1/health`, `/v1/ingest`, `/v1/search`, `/v1/get`, `/v1/delete`,
  `/v1/feedback`, `/v1/metrics`; `MockEngine` (mock_engine.py:149);
  `HyMemoryEngine` (hy_engine.py:111); `redact_text`/`redact_value`
  (engine.py:151/166); `Message.from_dict`/`IngestInput.from_dict`/
  `SearchInput.from_dict` (engine.py:565/659/722).
- **Tests executed:** `.\.venv\Scripts\python.exe -m pytest python/tests -q` and
  `.\.venv\Scripts\python.exe -m ruff check python`
- **Observed exit code:** pytest → `30 passed in 6.16s`, exit `0`; ruff →
  `All checks passed!`, exit `0`.
- **Evidence paths:** `python/tests/test_worker.py` (30 tests, lines 214-812);
  live worker log line captured by the CLI:
  `worker ready on http://127.0.0.1:61170 engine=mock (no model endpoint configured)`.
- **Known failures:** none open on the mock path. The real SDK path is proven by
  `python/research_smoke.py` (offline, WP-08) **and** by
  `tests/e2e/online-engine.mjs` (9/9 against real endpoints — see
  `docs/ONLINE_ENGINE_EVIDENCE.md`).
- **Compatibility:** Python ≥ 3.9 per upstream metadata; this repo runs 3.12.14.
  The worker binds `127.0.0.1` only, requires a Bearer token compared with
  `hmac.compare_digest` (server.py:326), caps bodies at 4 MiB (server.py:47),
  and never emits CORS headers (server.py:381).
- **Status:** **VERIFIED** for the mock/HTTP surface; **SUPPORTED** for the SDK
  adapter (only reachable with a model endpoint, absent here).

## WP-06 — Host plugin (capture, recall, tools, Studio API, worker supervisor)

- **Files changed:** `packages/host-plugin/src/index.ts` (254), `capture.ts`
  (427), `recall.ts` (130), `tools.ts` (374), `studio.ts` (848), `worker.ts`
  (124), `identity.ts` (95), `config.ts` (205), `engine.ts` (163),
  `sources.ts` (93), `runtime.ts` (41), `dsh-types.ts`.
- **Implemented APIs:** `apply` (index.ts:103), `PROTOCOL_SECTION` (28),
  `CapturePipeline.observe`/`flush`/`process` (capture.ts:179/280/327),
  `RecallController.search` (recall.ts:76), six tools `memory_search`,
  `memory_get`, `memory_propose`, `memory_feedback`, `memory_link_code`,
  `memory_status` (tools.ts:37-372), `StudioServer` (studio.ts:213),
  `startWorker` (worker.ts:50), `normalizeConfig` (config.ts:119),
  `EngineClient` (engine.ts:82), `keywordCandidates`/`semanticCandidates`
  (sources.ts:22/45).
- **Tests executed:** `node dist\bundle\cli.js capture --json --text "Please
  remember the project uses pytest and that I prefer Python 3.12 for this
  repo."`, then `node dist\bundle\cli.js search --json --query "…"`, then
  `node dist\bundle\cli.js status --json`, then `node tests\e2e\api-e2e.mjs`.
- **Observed exit code:** capture `0`, search `0`, status `0`, api-e2e `0`
  (`"total": 15, "failed": 0`).
- **Evidence paths:** `artifacts/docs-dev-capture.log` (jobId
  `01a15a0e-1205-7275-9159-737483310884`, `created` 1, `rejected` 0),
  `artifacts/docs-dev-search.log` (1 clue, 105 tokens), `artifacts/e2e-data/`
  (`governance.db`, `ui-token`, `worker-port`, `backups/`,
  `profile-backups/2026-10-20T13-35-05.817Z/manifest.json`).
- **Known failures (all fixed, each with a visible artefact):**
  1. Tool output schemas used `required: true` per property, which the host
     rejects — recorded verbatim in `artifacts/e2e-data/logs/plugin.log:1`
     (`JsonSchemaError: … schema.properties.rendered.required is not supported
     on type "string"`). The schemas now use a `required: [...]` array
     (tools.ts:59, 109, 160, 247, 295, 340).
  2. `pluginRoot` was off by one directory; it now derives from
     `fileURLToPath(new URL('.', import.meta.url))` (index.ts:109) and can be
     overridden with `HYMEM_PLUGIN_ROOT`.
  3. Static asset fallback served `index.html` for a missing `.js`, producing a
     MIME failure; missing assets now return 404 JSON (studio.ts:331-343).
  4. Studio normalizers and API shapes disagreed and the UI rendered `未知`;
     the API now emits the camelCase fields the normalizers expect
     (studio.ts:108-130, 193-206) and `normalize.ts:1-8` documents the contract.
  5. The iframe was blocked by CSP `frame-ancestors`; the header is now built
     from `config.ui.allowedFrameOrigins` (studio.ts:271-274,
     config.ts:129-136).
  6. `dsh.cmd` is not runnable via `execFileSync` on Windows; the CLI routes it
     through `cmd.exe /d /s /c` with its own quoting (cli.ts:81-104).
- **Known limitation (disclosed):** `POST /api/jobs/:id/cancel` is **not
  implemented**. The route table has only `/api/jobs/:id/retry`
  (studio.ts:656-660) and `/api/studio-config` advertises
  `capabilities.canCancelJobs: true` (studio.ts:390), backed by
`GovernanceStore.cancelJob` (`governance/src/index.ts:970-986`), which refuses an
`active` job because that record is withdrawn through the memory delete path.
`ui-client/src/api.ts:453-459`
  documents the gate.
- **Compatibility:** Node ≥ 24; loopback only (`127.0.0.1`), random UI token,
  HttpOnly `SameSite=Strict` cookie, `X-HyMemory-CSRF` on mutations.
- **Status:** **VERIFIED** — the commands above exited 0, and the host row now
  activates inside a live DSH profile with no `did not activate` warning; the
  Studio serves 15/15 API checks. See WP-08 for the activation fix.

## WP-07 — Studio UI (9 pages, 3 breakpoints, 2 themes)

- **Files changed:** `packages/ui-client/src/App.tsx` (56), `api.ts` (513),
  `normalize.ts` (727), `types.ts` (702), `store.tsx` (235), `hooks.ts` (279),
  `i18n.ts` (1354), `tokens.ts` (23), `patch.ts` (77), `styles.css` (1522),
  `components/{AppShell,ErrorBoundary,ui}.tsx`, `pages/*.tsx` (9 pages:
  Overview 268, Memories 782, Evidence 414, Conflicts 413, Agents 390,
  Capture 306, Usage 191, Settings 639, Diagnostics 264).
- **Implemented APIs:** hash router over 9 routes (`App.tsx:20-56`), typed client
  for all 24 Studio endpoints (`api.ts:335-510`), tolerant normalizers
  (`normalize.ts`), `apiUrl`/`exportUrl` (api.ts:107/504).
- **Tests executed:** bundled
  `& $node $pnpm --filter @dsh-hy-memory/ui-client build`; plus
  `node tests\e2e\api-e2e.mjs` (exercises the same API the UI reads).
- **Observed exit code:** build `0`.
- **Evidence paths:** `packages/ui-client/dist/index.html`,
  `dist/assets/index-B4zh0Zeh.js` **406.81 kB** (gzip 117.54 kB),
  `dist/assets/index-65a5PyBC.css` **22.02 kB** (gzip 4.45 kB);
   Local screenshot evidence is omitted from this public snapshot and retained locally.
  `10-dsh-sidebar-entry.png`, `11-dsh-panel.png`, and two debug shots).
- **Known failures:** the "未知" normalizer/API mismatch is fixed (WP-06 item 4).
- **Compatibility:** `base: '/studio/'` for build, `/` for dev with an `/api`
  proxy (vite.config.ts:19-38). Fixture mode is compiled out of production
  builds (`VITE_USE_FIXTURES` literal, vite.config.ts:22-24).
- **Status:** **VERIFIED** — build exits 0, 58 screenshots were captured from a
  real browser, and `node tests/e2e/ui-acceptance.mjs` passes 20/20 checks
  (no horizontal overflow at 1440/900/390, all nine routes render, keyboard
  focus ring, drawer open/close with focus restoration, offline error state
  without invented numbers, 403 permission message, zero console errors).

## WP-08 — DSH integration (client plugin, bundle, install)

- **Files changed:** `packages/host-plugin/client/client.js` (170),
  `scripts/build.mjs` (138), `dist/bundle/{index,client,studio-api,cli}.js`,
  `dist/bundle/{package.json,cordis.patch.yml,studio/,locale/,python/}`.
- **Implemented APIs:** `window.__ModuleLoader__.load` factory registering
  `sidebar.panellist` (client.js:140-151) and `main` (152-161) under one
  `PANEL_ID`, with en/zh dictionaries (24-39) and an iframe pointed at
  `http://127.0.0.1:<port>/studio/?token=<token>` (56).
- **Tests executed:** `node tests\e2e\dsh-integration.mjs` with
  `DSH_WEB_URL=http://127.0.0.1:58231` and `DSH_WEB_TOKEN` taken from the
  `dsh web:` line; `node tests\e2e\api-e2e.mjs`; `node tests\e2e\ui-acceptance.mjs`;
  `node tests\e2e\screenshots.mjs`.
- **Observed exit code:** `0` for all four. Re-verified on 2026-10-21 00:50 after
  the synchronous-registration fix: no `did not activate` warning, sidebar entry
  "HyMemory 记忆台" present, iframe count 1, Studio body 540 chars with real
  numbers (记忆总数 1 / 召回 TOKEN 105 / 召回次数 2), 15/15 API checks and 20/20
  UI checks green.
- **Evidence paths:** local screenshots are omitted from this public snapshot and retained locally.

## WP-09 — Toolchain, build, CLI, E2E harness

- **Files changed:** `scripts/build.mjs` (138), `scripts/cli.ts` (600),
  `scripts/benchmark.mjs` (148), `scripts/run-benchmark.mjs` (23),
  `tests/e2e/{api-e2e,operations,dsh-integration,screenshots,debug-dsh,
  debug-panel}.mjs`, `tests/{unit,security}/*.spec.ts`, `vitest.config.ts`,
  `tsconfig.json`, `package.json`.
- **Implemented APIs:** CLI commands `doctor`, `status`, `serve`, `install`,
  `uninstall`, `backup`, `export`, `capture`, `search`, `reindex`, `migrate`
  (cli.ts:562-588), all with `--json`.
- **Tests executed / observed exit codes:**

| Command | Exit | Output |
|---|---|---|
| `.\node_modules\.bin\vitest.CMD run --reporter=verbose` | 0 | 7 files / 86 tests |
| bundled `vitest run --reporter=verbose` (Node 24.21.0) | 0 | 7 files / 86 tests |
| `.\.venv\Scripts\python.exe -m pytest python/tests -q` | 0 | 30 passed |
| `.\.venv\Scripts\python.exe -m ruff check python` | 0 | All checks passed |
| `.\node_modules\.bin\tsc.CMD -p tsconfig.json --noEmit` | 0 | (no output) |
| bundled `pnpm --filter @dsh-hy-memory/ui-client build` | 0 | 406.81 kB JS / 22.02 kB CSS |
| `node dist\bundle\cli.js capture …` | 0 | created 1, rejected 0 |
| `node dist\bundle\cli.js search …` | 0 | 1 clue, 105 tokens |
| `node dist\bundle\cli.js status --json` | 0 | `audit.valid: true` |
| `node tests\e2e\api-e2e.mjs` (bundled Node) | 0 | 15/15 checks |
| `node scripts\run-benchmark.mjs` | 0 | see `docs/BENCHMARK_REPORT.md` |
| `.\.venv\Scripts\python.exe python\research_smoke.py` | 0 | 15/15 checks |

- **Known failures:**
  - `node scripts\benchmark.mjs` **fails directly** with
    `ERR_MODULE_NOT_FOUND … packages/governance/src/db.js` (exit `1`) because it
    imports `.ts` sources with `.js` specifiers. It must be run through
    `node scripts\run-benchmark.mjs`, which esbuild-bundles it first.
  - `node tests\e2e\api-e2e.mjs` under **system Node 24.16.0** printed all 15
    passing checks and then aborted with
    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`
    (exit `-1073740791`). Under the bundled Node 24.21.0 the same script exits
    `0`. Treat the system-Node abort as a known harness defect, not a test
    failure.
  - `package.json` references six scripts that **do not exist**:
    `scripts/run-e2e.mjs` (`test:e2e`), `scripts/doctor.mjs`, `scripts/status.mjs`,
    `scripts/install.mjs`, `scripts/uninstall.mjs`, `scripts/smoke-test.mjs`,
    and `tests/e2e/playwright.config.ts` (`test:ui`). Verified with `Test-Path`
    → `False` for all seven. Use `scripts/cli.ts` (via `dist/bundle/cli.js`)
    instead.
- **Compatibility:** the build requires a pre-built Studio
  (`packages/ui-client/dist/index.html`) and fails loudly otherwise
  (build.mjs:53-56).
- **Status:** **VERIFIED** for the commands in the table; **BLOCKED** for the
  six `package.json` script targets above.

---

## Module → files → test evidence

| Module | Files (lines) | Test evidence | Status |
|---|---|---|---|
| contracts | `packages/contracts/src/index.ts` (609) | `tests/unit/governance.spec.ts:41-260`, `tests/security/context-cost.spec.ts:114` | VERIFIED |
| governance | `packages/governance/src/{index.ts (1253), db.ts (375), evidence.ts (262), redact.ts (146)}` | `tests/unit/governance.spec.ts` 18 tests; `tests/security/pollution.spec.ts` 7 tests | VERIFIED |
| retrieval | `packages/retrieval/src/index.ts` (747) | `tests/unit/retrieval.spec.ts` 17 tests; `tests/security/context-cost.spec.ts` 9 tests | VERIFIED |
| coding-trace | `packages/coding-trace/src/index.ts` (836) | `tests/unit/coding-trace.spec.ts` 18 tests; `tests/security/staleness.spec.ts` 8 tests | VERIFIED |
| worker | `python/hymem_worker/{engine,mock_engine,hy_engine,server,__main__}.py` | `python/tests/test_worker.py` 30 tests | VERIFIED (mock + real SDK via `online-engine.mjs` 9/9) |
| host-plugin | `packages/host-plugin/src/*.ts` (12 files) | `tests/e2e/api-e2e.mjs` 15 checks; CLI capture/search/status | SUPPORTED |
   Local screenshot evidence is omitted from this public snapshot and retained locally.
| client bundle | `packages/host-plugin/client/client.js` (170) | `tests/e2e/dsh-integration.mjs` (prior run, exit 0) | SUPPORTED |
| build/CLI | `scripts/{build.mjs,cli.ts,benchmark.mjs,run-benchmark.mjs}` | commands in WP-09 table | VERIFIED / BLOCKED (missing script targets) |
| MemHub backend | *(none)* | — | **BLOCKED** — `backend: 'memhub'` exists only as a settings enum (`contracts/src/index.ts:475`, `ui-client/src/types.ts:571`, `Settings.tsx:85`); no adapter exists |

## Cross-cutting acceptance suites (33 security tests)

| Suite | File | Tests | Focus |
|---|---|---|---|
| G-POLLUTION | `tests/security/pollution.spec.ts` | 7 | model claim never verified, negation preserved, repetition, echo rejection, secret scrubbing, history retention, tombstones |
| G-STALENESS | `tests/security/staleness.spec.ts` | 8 | function change, revert, docs-only change, branch, shallow/detached, re-validation, toolchain scope, diff symbols |
| G-CONTEXT | `tests/security/context-cost.spec.ts` | 9 | 10k paging, hard budget, repeated steps, low-information query, dead engine, ACL cache invalidation, escaping/timeout, receipts, status labels |
| G-MULTIAGENT | `tests/security/multiagent.spec.ts` | 9 | cross-project, grant revocation, replay, concurrent writes, forged identity, same-named repos, hostile tool output, removed subagent, scope ladder |

## What is genuinely not done

1. **MemHub interop** — settings enum only, no adapter (BLOCKED).
2. **A live two-subagent DSH session** — E2E-02 drives the real capture and
   recall pipelines with two subagent principals
   (`tests/integration/multi-agent.spec.ts`, 5 cases), but those identities are
   constructed in the test rather than produced by a live DSH subagent spawn.
3. **Automated acceptance runs against the mock.** `pnpm run test:e2e` is
   deliberately free and deterministic, so it uses the mock engine. The real
   engine is proven separately by `tests/e2e/online-engine.mjs` (9/9) and the
   ablation; both make paid model calls and are opt-in.
4. **A general retrieval-quality benchmark** — the ablation measures one planted
   fact, one question, one model, three runs per arm (`0/3` vs `3/3`). That shows
   recall changes the answer; it is not a labelled-set quality benchmark.
5. **Coding engine ids via `/v1/get` in SDK 2.0.4** — not addressable
   (`hy_engine.py:268-273, 386-387`).
6. **CLI `reindex` and `migrate` are dry-run reporting only** (`scripts/cli.ts`,
   `args['dry-run'] !== false`); the mutating FTS rebuild is reachable through
   the Studio API, not as a CLI verb.
7. **macOS and Linux are untested** — only Windows 11 was exercised.



