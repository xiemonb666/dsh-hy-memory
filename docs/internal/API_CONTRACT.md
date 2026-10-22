# Internal API contract (project-internal, not an upstream DSH API)

All runtime boundaries validate JSON. Errors use
`{ "error": { "code": "E_*", "message": string, "details"?: object } }` with the
codes in `packages/contracts/src/index.ts`.

## 1. Python worker (loopback HTTP, Bearer token)

Base URL: `http://127.0.0.1:<port>` (default 48732, `--port 0` allowed).
Every request must send `Authorization: Bearer <worker-token>`; the token is
generated at install time, stored `0600` in the data dir, and passed to the Host
plugin through its Cordis config (`worker.token`) or `HYMEM_WORKER_TOKEN`.
Only `127.0.0.1` binds. `Origin` is not trusted; CORS is never enabled.

### GET /v1/health
```json
{ "ok": true, "engine": "hy-memory" | "mock", "engineVersion": "2.0.4",
  "degraded": false, "reason": null, "queueDepth": 0,
  "embeddingDims": 1536, "mode": "pro", "uptimeSeconds": 12.5 }
```

### POST /v1/ingest
```json
{ "jobId": "uuid", "namespace": "project:<uuid>", "workspaceId": "uuid|null",
  "branch": "string|null", "scene": "chat|working|coding",
  "messages": [{ "role": "user|assistant|tool", "content": "...",
                 "toolCallId": "id|null", "toolName": "name|null",
                 "toolCalls": [{ "id": "id", "name": "name", "arguments": "json-string" }] }],
  "toolOutcomes": [{ "callId": "id", "name": "name", "exitCode": 0, "success": true }],
  "observedAt": "ISO" }
```
Response:
```json
{ "ok": true, "engine": "hy-memory", "engineMemoryIds": ["..."],
  "candidates": [ { "scene": "chat", "kind": "fact", "title": "<=120 chars",
                    "text": "claim text", "claims": [{ "subject": "...", "predicate": "...", "object": "..." }],
                    "confidence": 0.7, "engineMemoryId": "...",
                    "source": "hy-memory|mock" } ],
  "elapsedMs": 120 }
```
The worker never decides trust. It returns candidates; the Host anchors them to
evidence and owns status.

### POST /v1/search
```json
{ "namespace": "project:<uuid>", "workspaceId": "uuid|null", "branch": "string|null",
  "query": "text", "scene": "chat|working|coding|null", "limit": 20,
  "allowIds": ["governance-memory-id", "..."] }
```
`allowIds` is the ACL-prefiltered id set the Host already authorized. The worker
must not return ids outside it (defense in depth).
Response:
```json
{ "ok": true, "results": [ { "engineMemoryId": "...", "governanceId": "...|null",
  "text": "...", "score": 0.72, "scene": "coding", "kind": "fact",
  "chainBlock": "...|null" } ], "elapsedMs": 12 }
```

### POST /v1/get
`{ "engineMemoryId": "..." }` → `{ "ok": true, "text": "...", "metadata": {...} }`

### POST /v1/delete
`{ "engineMemoryId": "..." }` → `{ "ok": true, "deleted": true }`

### POST /v1/feedback
`{ "engineMemoryId": "...", "kind": "useful|incorrect|stale" }` → `{ "ok": true }`

### GET /v1/metrics
`{ "ok": true, "calls": { "chatCompletions": 0, "embeddings": 0 }, "tokens": 0, "errors": 0 }`

## 2. Host Studio API (loopback HTTP, cookie + CSRF)

Base URL: `http://127.0.0.1:<uiPort>` (default 48731). Serves the Studio SPA at
`/studio/` and `/studio/assets/*`.
Auth: `GET /studio/?token=<ui-token>` validates the one-time token, sets the
HMAC-SHA256-derived `hymem_session` cookie with `HttpOnly; SameSite=None;
Secure; Partitioned`, then redirects to `/studio/` without the token. The
session cookie is required for every `/api/*` route. Methods other than `GET`
and `HEAD` also require `X-HyMemory-CSRF: <ui-token>`.

`GET /api/session` is behind the same API session-cookie check and returns
`{ "csrf": "<ui-token>" }` with `Cache-Control: no-store`. The UI calls it
same-origin with credentials when it needs a CSRF value for its first write;
concurrent bootstrap calls are shared. This read-only endpoint does not exempt
mutations from the CSRF header requirement. No CORS headers are emitted.

`Content-Security-Policy` uses `frame-ancestors` from `ui.allowedFrameOrigins`.
When unset, defaults include `dsh-app://app` and the existing local DSH web
origins (`DSH_WEB_URL`, or `http://127.0.0.1:58094` when unset,
`http://localhost:58094`, `http://127.0.0.1:58231`, and
`http://localhost:58231`). An explicit
`ui.allowedFrameOrigins` allow-list remains in force without extra origins
being appended.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/session` | authenticated CSRF bootstrap; `{ csrf }`, `Cache-Control: no-store` |
| GET | `/api/health` | plugin/worker/DB/UI status, versions, degraded reason |
| GET | `/api/projects` | projects + workspaces visible to the caller |
| GET | `/api/overview?projectId=&workspaceId=` | KPI counts, recent, jobs, usage |
| GET | `/api/memories?projectId=&workspaceId=&status=&scene=&kind=&q=&agentId=&page=&pageSize=` | paged browser |
| GET | `/api/memories/:id` | record + evidence + versions + claims + bindings + validations |
| POST | `/api/memories/:id/transition` | `{ to, reason, expectedRevision }` |
| POST | `/api/memories/:id/feedback` | `{ kind: "useful"|"incorrect"|"stale", note? }` |
| GET | `/api/conflicts?projectId=&state=` | conflict cases with both claims |
| POST | `/api/conflicts/:id/resolve` | `{ resolution, reason }` |
| GET | `/api/agents?projectId=` | agents/sessions/grants summary |
| GET | `/api/grants?projectId=` | grants |
| POST | `/api/grants` | `{ subjectId, objectScope, action, expiresAt? }` |
| DELETE | `/api/grants/:id` | revoke |
| GET | `/api/jobs?status=` | capture queue |
| POST | `/api/jobs/:id/retry` | retry one job |
| GET | `/api/usage?projectId=` | usage + quality metrics |
| GET | `/api/settings` | `{ settings, revision }` |
| PUT | `/api/settings` | `{ patch, expectedRevision }` |
| GET | `/api/diagnostics` | dependency checks, paths, versions, audit chain |
| GET | `/api/events?limit=` | audit events (redacted) |
| GET | `/api/export?projectId=&redacted=1` | JSON export |
| POST | `/api/backup` | `{ destination? }` → backup path + sha256 |
| GET | `/api/code/:memoryId` | bindings + diff chain + freshness |
| GET | `/api/studio-config` | locale, theme, capabilities |

## 3. Engine abstraction (TypeScript side)

```ts
export interface EngineHealth { ok: boolean; engine: 'hy-memory' | 'mock'; engineVersion: string; degraded: boolean; reason: string | null }
export interface EngineCandidate { scene: Scene; kind: MemoryKind; title: string; text: string; claims: ClaimDraft[]; confidence: number; engineMemoryId: string; source: string }
export interface EngineSearchHit { engineMemoryId: string; governanceId: string | null; text: string; score: number; scene: Scene; kind: MemoryKind; chainBlock: string | null }
export interface MemoryEngine {
  health(): Promise<EngineHealth>
  ingest(input: IngestInput): Promise<{ engineMemoryIds: string[]; candidates: EngineCandidate[]; elapsedMs: number }>
  search(input: EngineSearchInput): Promise<{ results: EngineSearchHit[]; elapsedMs: number }>
  get(engineMemoryId: string): Promise<{ text: string; metadata: Record<string, unknown> } | null>
  delete(engineMemoryId: string): Promise<void>
  close(): Promise<void>
}
```

## 4. Capture → recall data flow (single source of truth)

1. `session/event` builds a `CaptureEnvelope`; secrets are redacted before it
   leaves the Host; `sourceKey` is deterministic; the job is enqueued with an
   idempotency key.
2. The worker extracts candidates. The Host anchors each candidate to real
   evidence (`anchorClaim`), stores a governance record with the anchored
   status, and links the engine id.
3. Recall: Host authorizes candidates first (`authorize('read', row)`), then asks
   the worker only for the allowed engine ids; union with SQLite FTS; rerank;
   dedupe by content hash; filter statuses; apply the hard token budget; emit
   clue-first context with citations.

## 5. Ownership

- `packages/governance`: SQLite, ACL, evidence, state machine, conflicts,
  settings, audit, jobs, receipts. **Owner: Lead.**
- `packages/retrieval`: ACL-first hybrid retrieval, rerank, budget, injection
  text. **Owner: retrieval-dev.**
- `packages/coding-trace`: git fingerprint, code bindings, freshness, diff chain.
  **Owner: retrieval-dev.**
- `python/hymem_worker`: Hy-Memory SDK adapter, mock engine, HTTP server.
  **Owner: worker-dev.**
- `packages/host-plugin` + `packages/ui-client` + client bundle: **Owner: Lead**
  (UI pages by ui-dev).
