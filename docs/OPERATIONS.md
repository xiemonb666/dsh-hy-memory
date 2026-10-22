# Operations — install, upgrade, backup, restore, rollback

> This is the earlier operations guide. For the current transactional installer, per-instance worker files, implemented CLI restore/reindex/migrate and test boundaries, see [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md). Real profile installation was not rerun in the current session.

Everything here was executed on this machine or read from the code cited. Where a
command does not behave as its help text suggests, that is stated. Paths assume
the defaults; `HYMEM_DATA_DIR` moves the whole data directory
(`packages/host-plugin/src/config.ts:103-112`, `scripts/cli.ts:53-60`) and
`HYMEM_PYTHON` selects the worker interpreter (`config.ts:143`, `cli.ts:47-51`).

---

## 1. Data paths

Default data directory: `%LOCALAPPDATA%\dsh-hy-memory`
(Windows) / `$XDG_DATA_HOME/dsh-hy-memory` (elsewhere).

| Path | Contents | Notes |
|---|---|---|
| `governance.db` | the authoritative store: memories, evidence, claims, versions, conflicts, bindings, validations, grants, principals, sessions, jobs, injection receipts, usage, audit events, settings, tombstones, `project_state` | SQLite WAL; `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000` (`packages/governance/src/db.ts:325-329`) |
| `governance.db-wal`, `governance.db-shm` | WAL sidecars | a copy without them may lose recent commits — always use `backup`, not `copy` |
| `ui-token` | Studio token, 0600, ≥ 24 chars | created on first Studio start (`studio.ts:812-823`) |
| `worker-token-<UUID>` | per-instance worker Bearer token, 0600 | removed only after that owned child closes |
| `worker-port-<UUID>` | the port of the same owned worker instance | separate instances never overwrite each other |
| `logs/plugin.log` | activation failures (timestamp + stack) | appended only when activation throws (`host-plugin/src/index.ts:230-235`) |
| `backups/hymem-<epoch>.db` | default destination of `backup` | `studio.ts:752`, `cli.ts:349` |
| `profile-backups/<ISO>/` | `package.json`, `cordis.patch.yml`, `manifest.json` | written by `install` (`cli.ts:304-313`) |

Profile location: `%USERPROFILE%\.dsh\profiles\<name>\` with `package.json`,
`cordis.patch.yml`, `cordis.yml`, `pnpm-lock.yaml`, `.plugin-manager/`.

Repository-side artefacts: `dist/bundle/` (installable bundle),
`packages/ui-client/dist/` (Studio SPA), `artifacts/` (benchmark + E2E data,
git-ignored). Per-repository state written by the plugin:
`<git-dir>/dsh-hy-memory-workspace-id` (only when there is no `origin` remote;
`coding-trace/src/index.ts:385-403`).

---

## 2. Health checks

| Check | Command | Expected |
|---|---|---|
| Full pre-flight | `node dist\bundle\cli.js doctor --json` | `ok: true`; `hyMemorySdk` may be false |
| Store + queue + audit | `node dist\bundle\cli.js status --json` | `audit.valid: true` |
| Worker + plugin | `GET /api/health` (with session cookie) | `ok: true`; `worker.ok`; `db.ok`; `degraded` reflects reality |
| Worker directly | `GET http://127.0.0.1:<worker-port>/v1/health` with `Authorization: Bearer <worker-token>` | `{ ok, engine, engineVersion, degraded, reason, mode, uptimeSeconds }` |
| Worker counters | `GET /v1/metrics` | `calls.chatCompletions`, `calls.embeddings`, `tokens`, `errors`, `requests` |
| Audit chain | `GET /api/diagnostics` → `audit.ok` | `true`, `brokenAt: null` |
| Dependencies | `GET /api/diagnostics` → `dependencies[]` | `sqlite (node:sqlite)` ok, `audit chain` ok, `python worker` informational |

`doctor` check ids: `node`, `python`, `dataDir`, `hyMemorySdk`, `dshProfiles`,
`studioAssets`, `auditChain`. Only `hyMemorySdk` may fail without failing the
command (`cli.ts:151`). Live example (`HYMEM_DATA_DIR=artifacts\e2e-data`):

```
$ node dist\bundle\cli.js status --json
{ "ok": true, "counts": { "total": 1, "supported": 1, ... },
  "audit": { "valid": true }, "dataDir": "...\\artifacts\\e2e-data" }
```

---

## 3. Install

```powershell
# 0) prerequisites
node dist\bundle\cli.js doctor --json

# 1) Studio SPA first — scripts/build.mjs aborts without it
& $node $pnpm --filter @dsh-hy-memory/ui-client build

# 2) bundle
node scripts\build.mjs

# 3) profile (skip if it exists)
& cmd /d /s /c "`"$dsh`" --profile hymem-spike --from-default-profile web --dump-config"

# 4) dry run, then install
node dist\bundle\cli.js install --profile hymem-spike --dry-run --json
node dist\bundle\cli.js install --profile hymem-spike --json
```

`install` flags: `--profile <name>` (required), `--dry-run`, `--ui-port <n>`
(default 48731), `--data-dir <path>`, `--json`.

Underlying DSH call (`cli.ts:318`):

```powershell
& cmd /d /s /c "`"$dsh`" plugin --profile hymem-spike add <repo>\dist\bundle"
```

`dsh plugin` forwards its remaining arguments verbatim to pnpm inside the profile
directory, so `add`, `remove`, `why`, `update` all work
(`dsh plugin --help`).

### Profile backup manifest

Before touching anything, `install` copies the profile's `package.json` and
`cordis.patch.yml` to `%LOCALAPPDATA%\dsh-hy-memory\profile-backups\<ISO>/` and
writes `manifest.json`:

```json
{
  "profile": "hymem-spike",
  "createdAt": "2026-10-20T13:35:05.819Z",
  "files": [
    { "path": "<DSH-home>\\profiles\\hymem-spike\\package.json",
      "sha256": "8a07ceb9ef0d39281e4dd18bf7cc678325d0b70fb26cc896d2cb83886d7f62f5" },
    { "path": "<DSH-home>\\profiles\\hymem-spike\\cordis.patch.yml",
      "sha256": "ef189a8c27db6d63930aa3046a3040482e952eafcb7487c644d508e8d461f027" }
  ]
}
```

The `sha256` is computed from the **live** profile file at copy time
(`cli.ts:306-312`), so it doubles as the pre-change fingerprint. Note it records
the *source* path, not the copy's path — verify the copy yourself before
restoring (§6).

---

## 3.1 Connecting a real model endpoint

By default the worker runs the deterministic mock. To use the real Hy-Memory SDK,
write one file — `<dataDir>/memory-engine.env` — and restart the plugin. The host
passes it as `--env-file`, so nothing goes into argv, the bundle patch, or git.

```ini
MEMORY_LLM_PROVIDER=openai
MEMORY_LLM_BASE_URL=https://<your-endpoint>/compatible-mode/v1
MEMORY_LLM_MODEL=<chat model>
MEMORY_LLM_API_KEY=<key>
MEMORY_LLM_TEMPERATURE=0.1
# Required for reasoning models that spend the whole budget on thinking and
# return empty content (finish_reason=length):
MEMORY_LLM_EXTRA_BODY={"enable_thinking": false}

MEMORY_EMBEDDER_PROVIDER=openai
MEMORY_EMBEDDER_BASE_URL=https://<your-endpoint>/compatible-mode/v1
MEMORY_EMBEDDER_MODEL=<embedding model>
MEMORY_EMBEDDER_API_KEY=<key>
MEMORY_EMBEDDING_DIMS=1024
MEMORY_EMBEDDER_TIMEOUT=30

MEMORY_MODE=pro
MEMORY_ENABLE_GRAPH=0
```

Rules that matter:

1. **`MEMORY_EMBEDDING_DIMS` must equal the model's real dimension and must never
   change afterwards.** Changing it invalidates every stored vector, so old
   memories stop being retrievable. Verify the dimension with one probe call
   before committing to a value.
2. **Raise `recall.searchTimeoutMs` to 2500.** Real embeddings take 1132–1268 ms;
   the 900 ms default from older databases yields `degraded: "timeout"` and zero
   clues (§8).
3. **Restrict the file to the account that runs the plugin** (POSIX `chmod 600`;
   on Windows remove inherited ACEs so only that account can read it). It holds
   live credentials.
4. **Restart the plugin** after editing: the worker reads the file at startup.
5. Verify with `GET /api/health`: `engine: "hy-memory"`, `degraded: false`.

Two provider traps are documented with probes in
[ONLINE_ENGINE_EVIDENCE.md](ONLINE_ENGINE_EVIDENCE.md) §3: some gateways silently
drop `system` messages, and some "flash" chat models are reasoning models that
return empty content unless thinking is disabled.

---

## 4. Upgrade

```powershell
# 1) rebuild both halves
& $node $pnpm --filter @dsh-hy-memory/ui-client build
node scripts\build.mjs

# 2) reinstall (this re-runs the profile backup and re-substitutes the UI token)
node dist\bundle\cli.js install --profile hymem-spike --json

# 3) verify
node dist\bundle\cli.js status --json
node dist\bundle\cli.js doctor --json
```

Notes:

- The bundle is installed as a **linked directory** (`link:…/dist/bundle`), so a
  rebuild is picked up by restarting DSH — no reinstall is strictly required,
  but reinstalling refreshes the token/port substitution in `client.js`.
- Schema changes: `openDatabase` applies `MIGRATION_V1` idempotently on every
  open and records the version in `schema_migrations`
  (`packages/governance/src/db.ts:322-348`). Current `SCHEMA_VERSION = 1`.
  There is no downgrade path in code; rolling back a plugin version means
  restoring the profile files (§6) and, if the schema changed, the database.

---

## 5. Backup

### Database

```powershell
node dist\bundle\cli.js backup --json
# → { "ok": true, "command": "backup", "path": "...\\backups\\hymem-<epoch>.db",
#     "sha256": "<64 hex>", "bytes": 290816 }

node dist\bundle\cli.js backup --destination D:\hymem\2026-10-21.db --json
```

`backup` runs `PRAGMA wal_checkpoint(TRUNCATE)` then copies the file, and returns
the sha256 of the copy (`governance/src/index.ts:1215-1222`). In-memory databases
are rejected. Over HTTP: `POST /api/backup {"destination"?: "..."}`.

### Export (portable, human-readable)

```powershell
node dist\bundle\cli.js export --json --out artifacts\export-2026-10-21.json
node dist\bundle\cli.js export --json --project project_29830c11bd7b80780902109c
```

`export` writes memories, evidence, versions, claims, bindings and conflicts for
one project, **redacted by default** (`cli.ts:361`). There is no CLI flag to turn
redaction off; the HTTP endpoint accepts `GET /api/export?redacted=0` if you
really need the unredacted form (it still passes through `redact()` on the way
out, so secrets stay masked).

### Profile

Copy `%USERPROFILE%\.dsh\profiles\<name>\{package.json,cordis.patch.yml}` — or
just keep the `profile-backups/` directory the installer already wrote.

### What a backup does **not** contain

- `ui-token` / `worker-token` (regenerate rather than restore), and the Studio
  SPA and bundle (rebuild them);
- the upstream Hy-Memory SDK's own state under `MEMORY_DATA_DIR`
  (`cache.db`, `coding_memory_*.db`, `vector_db/`, `hy_code_chain/`) — only
  reachable when a real model endpoint is configured; with the mock engine there
  is no such state;
- anything outside `governance.db`.

---

## 6. Restore

```powershell
# Use the CLI from the current isolated build; target must be new or empty.
node C:\path\to\bundle\cli.js restore --source D:\hymem\backup.db --data-dir D:\hymem\restored --json
node C:\path\to\bundle\cli.js status --data-dir D:\hymem\restored --json
node C:\path\to\bundle\cli.js reindex --data-dir D:\hymem\restored --json
```

The current CLI validates integrity, schema, foreign keys, the audit chain and
the exact tombstone IDs before publishing a checked copy. It refuses an existing
database, a nonempty target, symlinks and an uncheckpointed source WAL. Its E2E
uses a new temporary target and checks that deleted records stay deleted. A
governance backup excludes SDK vectors/history, credentials and profile files.
Changing an existing profile to use the validated target is a separate operator
action; restore does not overwrite or switch the live profile.

---

## 7. Migrate and reindex

```powershell
node dist\bundle\cli.js migrate --json
node dist\bundle\cli.js reindex --json
```

Current builds execute both commands by default. Add `--dry-run` for a read-only
preview. `migrate` initializes a missing database and applies the supported
schema; `reindex` rebuilds the keyword index from live governance records and
excludes tombstones. Both reject a database newer than the supported schema.
Use `--data-dir <path>` to choose the intended store explicitly.

---

## 8. Degraded modes

| Trigger | Detection | Behaviour | Recovery |
|---|---|---|---|
| No engine configured (`memory-engine.env` absent) | `/v1/health` → `engine: "mock"`, `degraded: true`, `reason: "no model endpoint configured"` | extraction is the deterministic mock; capture/recall/governance all work | write `<dataDir>/memory-engine.env` (`docs/ONLINE_ENGINE_EVIDENCE.md` §1) then restart |
| Python worker dead | `/api/health` → `worker.ok: false`, top-level `degraded: true` | Studio keeps serving reads/writes from SQLite; semantic channel returns `[]`; recall degrades to keyword only (`sources.ts:80-83`) | restart the plugin |
| Recall timeout against a real endpoint | `outcome.degraded: "timeout"`, 0 clues at ~900 ms | empty clues, no blocking, agent continues (`retrieval/src/index.ts:431-460`) | raise `recall.searchTimeoutMs` to 2500 — real embeddings need 1132–1268 ms (`docs/ONLINE_ENGINE_EVIDENCE.md` §1.1) |
| Semantic source error | `outcome.degraded: "source-error"` | keyword results still returned; result is **not** cached | check the worker |
| Capture backend error | job → `retryable` with `error_code` | exponential backoff `min(60s, 1s·2^attempt)·(0.7…1.3)`, max 5 attempts, then `quarantined` (`governance/src/index.ts:946-960`) | `POST /api/jobs/:id/retry` |
| Audit chain broken | `/api/diagnostics` → `audit.ok: false`, `brokenAt` set | `degraded: true`; the UI flags it | investigate before trusting history |
| Studio assets missing | static 404 JSON `Studio assets are not built; run pnpm build:studio` | API still works | rebuild the SPA |
| Worker crashed | `logs` shows `worker exited with code N`; `/api/health` degrades | the host restarts it after a 3 s backoff (`index.ts:143-176`) | none needed; check the log if it loops |

Recall status policy in degraded conditions: `deleted`/`rejected`/`superseded`
never return; `conflicted` is excluded by default; `stale` stays visible as
clue-only unless `staleGuidance: 'hide'` (`retrieval/src/index.ts:514-522`).

---

## 9. Log locations

| Log | Location | Content |
|---|---|---|
| Plugin activation failures | `%LOCALAPPDATA%\dsh-hy-memory\logs\plugin.log` | ISO timestamp + stack, appended on throw |
| Host logger | DSH's own process output | `hymem: Studio on …`, `hymem: queued capture job …`, `hymem worker: …` |
| Worker stdout/stderr | captured into the host logger, prefixed `hymem worker:` | readiness line, per-request `METHOD path -> status Xms` (redacted) |
| Worker audit (SDK only) | `$MEMORY_DATA_DIR/logs/hy_memory.log`, `logs/pipeline/<subdir>/<date>.log` | upstream SDK's own logs |
| Audit trail (structured) | `governance.db` → `audit_events`, or `GET /api/events?limit=` | hash-chained, redacted |
| Installer output | `install`/`uninstall` JSON `output` field (last 4000 chars of the dsh call) | pnpm output |
| Profile manager | `%USERPROFILE%\.dsh\profiles\<name>\.plugin-manager\logs\operation-*\pnpm.log` | pnpm runs from `dsh plugin` |

There is no log rotation. `plugin.log` grows only on activation failure.

---

## 10. Rollback

### 10.1 Roll back the plugin

```powershell
# remove the bundle from the profile
node dist\bundle\cli.js uninstall --profile hymem-spike --json
#   → calls: dsh plugin --profile hymem-spike remove dsh-hy-memory
#   → memory data retained

# restore the pre-install profile files
$backup = Get-ChildItem "$env:LOCALAPPDATA\dsh-hy-memory\profile-backups" | Sort-Object Name -Descending | Select-Object -First 1
Copy-Item "$($backup.FullName)\package.json"      "$env:USERPROFILE\.dsh\profiles\hymem-spike\package.json" -Force
Copy-Item "$($backup.FullName)\cordis.patch.yml"  "$env:USERPROFILE\.dsh\profiles\hymem-spike\cordis.patch.yml" -Force
```

Then restart DSH. Because the bundle is a `link:` dependency, removing the row
from `package.json` is what actually disables it. Full teardown = uninstall, then
`Remove-Item "$env:LOCALAPPDATA\dsh-hy-memory" -Recurse -Force` (deletes all
memory), optionally deleting `<repo>\.git\dsh-hy-memory-workspace-id` — that file
is the workspace identity for repos with no `origin`, so removing it hides (does
not delete) previously captured memories from that workspace.

### 10.2 Roll back the data

```powershell
# stop DSH first
Copy-Item "$env:LOCALAPPDATA\dsh-hy-memory\governance.db.pre-restore" "$env:LOCALAPPDATA\dsh-hy-memory\governance.db" -Force
Remove-Item "$env:LOCALAPPDATA\dsh-hy-memory\governance.db-wal" -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\dsh-hy-memory\governance.db-shm" -ErrorAction SilentlyContinue
node dist\bundle\cli.js status --json
```

### 10.3 Roll back the Studio UI only

```powershell
& $node $pnpm --filter @dsh-hy-memory/ui-client build   # rebuild from the current tree
node scripts\build.mjs
```

---

## 11. Command reference

### `scripts/cli.ts` (run as `node dist\bundle\cli.js <cmd>`)

| Command | Flags | Does |
|---|---|---|
| `doctor` | `--json` | 7 environment checks; exit 1 if a non-optional check fails |
| `status` | `--json`, `--data-dir` | workspace identity, counts, jobs, settings, audit validity |
| `serve` | `--json`, `--ui-port`, `--engine mock\|hy\|auto`, `--no-capture`, `--data-dir` | worker + Studio, headless |
| `install` | `--profile` (required), `--dry-run`, `--ui-port`, `--data-dir`, `--json` | profile backup + `dsh plugin add` |
| `uninstall` | `--profile` (required), `--json` | `dsh plugin remove`; keeps data |
| `backup` | `--destination`, `--data-dir`, `--json` | checkpoint + copy + sha256 |
| `export` | `--project`, `--out`, `--redacted`, `--data-dir`, `--json` | redacted JSON export |
| `capture` | `--text` (required), `--session`, `--tool-output`, `--tool-exit`, `--engine`, `--json` | one synthetic capture through the real pipeline |
| `search` | `--query` (required), `--engine`, `--data-dir`, `--json` | one recall pass, prints the clue container |
| `restore` | `--source`, `--data-dir`, `--json` | validate and restore into a new/empty target (§6) |
| `reindex` | `--dry-run`, `--data-dir`, `--json` | execute keyword rebuild; optional read-only preview (§7) |
| `migrate` | `--dry-run`, `--data-dir`, `--json` | execute/preview supported migrations (§7) |

Global: `--json`, `--data-dir <path>`, `--engine mock|hy|auto`, `--ui-port <n>`,
`--dry-run`, `-h/--help`.

### `dsh plugin`

```powershell
& cmd /d /s /c "`"$dsh`" plugin --profile hymem-spike add    <repo>\dist\bundle"
& cmd /d /s /c "`"$dsh`" plugin --profile hymem-spike remove dsh-hy-memory"
& cmd /d /s /c "`"$dsh`" plugin --profile hymem-spike why    dsh-hy-memory"
```

`--profile <name>` selects the profile; every remaining argument is forwarded
verbatim to pnpm in that directory. The worker is spawned by the host, never by
hand:

```
python -m hymem_worker --port <0..65535> --port-file <path> --token-file <path>
                       --engine auto|mock|hy --data-dir <path>
                       [--request-timeout 30.0] [--log-level DEBUG|INFO|WARNING|ERROR]
```

---

## 12. Operational limits to plan around

1. **Use the current build** for executable `restore`, `reindex` and `migrate` (§6–7).
2. **Cancel is not implemented** — jobs can be retried, not cancelled.
3. **No rate limiting** on either loopback server.
4. **The Studio token is `owner`.** Anyone who can read the token file has full
   control. It is also substituted into `client.js` by `install`.
5. **No log rotation, no scheduled backup.** `backup` is manual; automate it with
   Task Scheduler if the data matters.
6. **Two Node versions matter.** Under system Node 24.16.0 `api-e2e.mjs` passes
   all checks then aborts in libuv at exit; under the bundled 24.21.0 it exits 0.
   Run operational scripts with the bundled Node.
7. **Acceptance coverage is not uniform.** [E2E_MATRIX.md](E2E_MATRIX.md) is the
   canonical mapping: all 20 plan scenarios have an executable assertion — all 20
   pass. E2E-02 drives the real capture/recall pipelines with two subagent
   principals constructed in the test (no live DSH subagent spawn is possible
   without a model endpoint); E2E-11 is a full browser edit→refresh round trip.
   The operational scripts that back this section are
   `tests/e2e/operations.mjs` (10/10: backup/restore, worker kill,
   uninstall/reinstall) and `tests/e2e/cross-session.mjs` (11/11: capture in one
   process, recall in another).

### Reproducing the operational checks

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$env:HYMEM_PROFILE = 'hymem-spike'
& $node tests\e2e\operations.mjs     # 10/10 — needs a running Studio
& $node tests\e2e\cross-session.mjs  # 11/11 — self-contained, uses a temp data dir
```
