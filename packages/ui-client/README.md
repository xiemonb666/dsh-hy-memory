# @dsh-hy-memory/ui-client

The **HyMemory Studio** single-page UI. It is served by the Host plugin at
`/studio/` (see `docs/internal/API_CONTRACT.md` §2) and framed by the DSH web UI
through the client plugin; it can also run standalone during development.

- React 19 + TypeScript (strict) + Vite 7
- No UI framework, no CSS framework, no chart library — plain CSS with DSH theme
  token fallbacks and hand-written SVG sparklines
- Every value on screen comes from the Host Studio API. When a field is missing
  the UI prints `unknown` / `Unverifiable`; it never invents numbers.

## Scripts

Run from the repository root with the bundled toolchain:

```bash
# dev server (proxies /api to http://127.0.0.1:48731 by default)
pnpm --filter @dsh-hy-memory/ui-client dev

# production build (base /studio/, output packages/ui-client/dist)
pnpm --filter @dsh-hy-memory/ui-client build

# typecheck only
pnpm --filter @dsh-hy-memory/ui-client exec tsc --noEmit -p tsconfig.json
```

On this machine the bundled runtime is used explicitly:

```bash
node "<DSH-install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" \
     "<DSH-install>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" \
     --filter @dsh-hy-memory/ui-client build
```

## Configuration

| Source | Purpose |
|---|---|
| `window.__HYMEM_CONFIG__.apiBase` | API origin injected by the Host when framing the SPA. |
| `window.__HYMEM_CONFIG__.csrf` | CSRF token for `POST`/`PUT`/`DELETE` (`X-HyMemory-CSRF`). |
| `VITE_API_BASE` | Build-time / dev-server override for the API origin. |
| `?token=` on the URL | Legacy bootstrap input; captured once and stripped from the address bar when present. |
| `VITE_USE_FIXTURES=1` | **Fixture mode** (see below). Never enabled by default. |

Auth: the Host validates the one-time `?token=` login query, sets an
HMAC-SHA256-derived `hymem_session` cookie with `HttpOnly; SameSite=None;
Secure; Partitioned`, and redirects to `/studio/` without the token. Every API
request sends `credentials: 'include'`; the Host requires that session cookie
for all `/api/*` routes and additionally requires `X-HyMemory-CSRF` on every
method except `GET` and `HEAD`.

If a write starts without a CSRF value from the Host config, query input, or
`sessionStorage`, the client makes one same-origin `GET /api/session` request
with credentials and `cache: 'no-store'`. Concurrent writes share that
single-flight request. The Host returns `{ "csrf": "<ui-token>" }` only after
the normal session-cookie check; the client then sends the value in
`X-HyMemory-CSRF`. This endpoint does not make writes exempt from CSRF checks.

Base-URL resolution order is `window.__HYMEM_CONFIG__.apiBase` →
`import.meta.env.VITE_API_BASE` → same-origin.

## Fixture mode (screenshots before the backend exists)

```bash
# Windows PowerShell
$env:VITE_USE_FIXTURES='1'; pnpm --filter @dsh-hy-memory/ui-client build
# or for the dev server
$env:VITE_USE_FIXTURES='1'; pnpm --filter @dsh-hy-memory/ui-client dev
```

`src/dev-mock.ts` then answers the same paths as the Host API with synthetic
sample data, and the shell shows a permanent **“Fixture mode”** banner.

Guarantees:

- The flag is compiled by `vite.config.ts` into the literal `'0'` for every build
  that does not set `VITE_USE_FIXTURES=1`, so `api.ts`'s dynamic import of
  `dev-mock.ts` is dead code and Rollup emits no fixture chunk at all.
- No production code path imports `dev-mock.ts`; it is reached only from
  `api.ts` behind `FIXTURE_MODE`.
- Verified: a normal build contains none of the fixture strings and no
  `dev-mock` chunk.

## Layout

```
index.html
vite.config.ts
src/
  main.tsx            entry, mounts the SPA
  App.tsx             hash router + page switch
  api.ts              typed client for every Host Studio endpoint
  types.ts            DTO/view-model types (mirrors packages/contracts vocabulary)
  normalize.ts        tolerant payload normalizers (missing → undefined, never 0)
  store.tsx           locale, theme, project/workspace, health polling, announcer
  hooks.ts            hash routing, useResource, mutations, focus trap
  i18n.ts             en + zh-CN dictionaries, t(), date/number formatting
  tokens.ts           conservative injection-token estimate (mirrors contracts)
  patch.ts            unified-diff parser for the diff viewer
  dev-mock.ts         FIXTURE MODE ONLY (VITE_USE_FIXTURES=1)
  styles.css          design tokens, 8px grid, responsive, reduced motion
  components/
    AppShell.tsx      nav rail (icons at tablet, drawer at mobile) + header
    ui.tsx            cards, badges, states, tables, dialog/drawer, SVG charts
    ErrorBoundary.tsx
  pages/
    Overview.tsx      KPI cards, trend, health, recent, jobs
    Memories.tsx      explorer + detail drawer (claims, evidence, versions, cost)
    Evidence.tsx      commit timeline, diff viewer, tests, freshness
    Conflicts.tsx     side-by-side claims + resolution with mandatory reason
    Agents.tsx        agent tree, grant editor with preview, revoke-all
    Capture.tsx       toggles, historical-import warning, queue board
    Usage.tsx         usage, per-agent, quality, cost (`unknown` rate), benchmark
    Settings.tsx      7 sections, revisioned save, conflict dialog
    Diagnostics.tsx   versions, dependencies, paths, audit chain, matrix
```

## Routes

`#/overview` · `#/memories` · `#/evidence` · `#/conflicts` · `#/agents` ·
`#/capture` · `#/usage` · `#/settings` · `#/diagnostics`

Deep links carry query parameters, e.g. `#/memories?status=needs_review` (KPI
cards and the health panel use this) and `#/evidence?memoryId=<id>`.

## Request states

`api.ts` maps every failure to one explicit UI state:

| Condition | UI |
|---|---|
| in-flight | skeleton (`role="status"`, `aria-live`) |
| empty result | empty state with the active filters echoed |
| 401 `E_UNAUTHORIZED` | session-expired panel |
| 403 `E_FORBIDDEN` | permission-denied panel |
| 503 `E_BACKEND_UNAVAILABLE` | degraded-backend panel, retry offered |
| timeout (15 s, one retry for GET) | timeout panel, retry offered |
| network failure | host-unreachable panel, retry offered |
| 409 `E_REVISION_MISMATCH` | revision-conflict panel / settings conflict dialog |
| render crash | error boundary |

## Accessibility

- Semantic landmarks (`nav`, `main`, `header`), `aria-current="page"` on the
  active nav entry, skip link that moves focus without touching the hash.
- Drawers and dialogs trap Tab, close on `Escape`, and restore focus.
- `aria-live="polite"` announcer for async results (transitions, retries,
  saves, revocations).
- Every input has a label; errors use `aria-invalid` + `aria-describedby`.
- Status is always text + icon, never colour alone.
- `prefers-reduced-motion` disables transitions and the shimmer.
- Breakpoints: 1440 desktop, ≤1100 tablet (icon rail), ≤640 mobile (drawer nav,
  tables become label/value cards).

## Known gaps

- `POST /api/jobs/:id/cancel` is not in the frozen contract table; the Cancel
  button is enabled only when `/api/studio-config` advertises
  `capabilities.canCancelJobs`.
- The redaction report has no dedicated endpoint, so it reads
  `redaction: { secrets, events, skipped }` from `/api/diagnostics` when present
  and otherwise states that the Host did not report a summary.
- `Search mode` is sent as an additive `mode` query parameter on
  `/api/memories`; the Host may ignore it (the contract defines no mode filter).
- "Affected references" before a delete uses `evidenceIds.length` /
  `evidenceCount`; when the Host reports neither, the dialog says `unknown`.
