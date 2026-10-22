/**
 * Typed client for the Host Studio API (`docs/internal/API_CONTRACT.md` §2).
 *
 * Base URL resolution order:
 *   1. `window.__HYMEM_CONFIG__.apiBase` (injected by the Host when the SPA is
 *      framed by the DSH web UI),
 *   2. `import.meta.env.VITE_API_BASE` (build-time override for dev),
 *   3. same-origin (the Host serves the SPA from `/studio/`).
 *
 * Auth: the Host validates `?token=` once, then sets a partitioned HttpOnly
 * `SameSite=None; Secure` session cookie for the cross-site DSH iframe, so every
 * call sends `credentials: 'include'`. Mutations need `X-HyMemory-CSRF`; a fresh
 * iframe bootstraps it from the authenticated, same-origin `/api/session` route
 * when no compatible host/query/sessionStorage value is already available.
 *
 * Every call has a hard timeout, one retry for idempotent requests, and maps
 * failures to a small set of UI states: `forbidden` (403), `degraded` (503),
 * `timeout`, `offline`, `unauthorized` (401), `conflict` (409), `http`.
 */
import * as N from './normalize'
import type {
  AgentSummary,
  AuditEvent,
  BackupResult,
  CaptureJob,
  CodeResponse,
  ConflictCase,
  ConflictResolveInput,
  ConflictResolveResult,
  ConflictState,
  DiagnosticsResponse,
  FeedbackInput,
  Grant,
  GrantInput,
  HealthResponse,
  JobSummary,
  MemoryDetail,
  MemoryQuery,
  MemoryStatus,
  MemorySummary,
  OverviewResponse,
  Page,
  Project,
  SettingsResponse,
  SettingsSaveInput,
  StudioConfig,
  TransitionInput,
  UsageResponse,
} from './types'

/* ------------------------------------------------------------------ */
/* Runtime configuration                                               */
/* ------------------------------------------------------------------ */

export interface HostConfig {
  apiBase?: string
  csrf?: string
}

interface HyMemWindow extends Window {
  __HYMEM_CONFIG__?: HostConfig
}

const CSRF_STORAGE_KEY = 'hymem.csrf'

function hostConfig(): HostConfig {
  const target = window as HyMemWindow
  return target.__HYMEM_CONFIG__ ?? {}
}

/** Captured once at module load; also strips the token from the visible URL. */
function captureTokenFromQuery(): string | undefined {
  try {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('token')
    if (!token) return undefined
    try {
      window.sessionStorage.setItem(CSRF_STORAGE_KEY, token)
    } catch {
      /* storage may be disabled: keep the in-memory copy only */
    }
    url.searchParams.delete('token')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    return token
  } catch {
    return undefined
  }
}

const capturedToken = captureTokenFromQuery()

function readStoredCsrf(): string | undefined {
  try {
    return window.sessionStorage.getItem(CSRF_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

const API_BASE = (hostConfig().apiBase ?? import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')
let csrfToken = hostConfig().csrf ?? capturedToken ?? readStoredCsrf()
let csrfBootstrapPromise: Promise<string> | null = null

/** True only when the bundle was built with `VITE_USE_FIXTURES=1`. */
export const FIXTURE_MODE = import.meta.env.VITE_USE_FIXTURES === '1'

/** Absolute URL for the API root, useful for `<a href>` download links. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ApiErrorKind = 'http' | 'timeout' | 'offline' | 'aborted' | 'parse' | 'fixture'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  readonly code: string | null
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(init: {
    message: string
    kind: ApiErrorKind
    status?: number | null
    code?: string | null
    retryable?: boolean
    details?: Record<string, unknown>
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status ?? null
    this.code = init.code ?? null
    this.retryable = init.retryable ?? false
    this.details = init.details
  }

  /** Permission denied (HTTP 403 / `E_FORBIDDEN`). */
  get forbidden(): boolean {
    return this.status === 403 || this.code === 'E_FORBIDDEN'
  }

  /** Session missing or expired (HTTP 401 / `E_UNAUTHORIZED`). */
  get unauthorized(): boolean {
    return this.status === 401 || this.code === 'E_UNAUTHORIZED'
  }

  /** Backend degraded or unreachable (HTTP 503 / `E_BACKEND_UNAVAILABLE`). */
  get degraded(): boolean {
    return this.status === 503 || this.code === 'E_BACKEND_UNAVAILABLE'
  }

  /** Optimistic-concurrency mismatch (HTTP 409 / `E_REVISION_MISMATCH`). */
  get conflict(): boolean {
    return this.status === 409 || this.code === 'E_REVISION_MISMATCH' || this.code === 'E_CONFLICT'
  }
}

/* ------------------------------------------------------------------ */
/* Core request                                                        */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 15_000
const IDEMPOTENT_RETRIES = 1

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  /** Set false for requests whose success is optional (e.g. probing capabilities). */
  allowRetry?: boolean
}

function buildPath(path: string, query: RequestOptions['query']): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`
}

function errorFromBody(raw: unknown, status: number): { code: string | null; message: string; details?: Record<string, unknown> } {
  const body = N.record(raw)
  const error = N.record(body.error)
  const code = N.str(error.code) ?? null
  const message = N.str(error.message) ?? N.str(body.message) ?? `HTTP ${status}`
  const details = N.isRecord(error.details) ? error.details : undefined
  return { code, message, ...(details ? { details } : {}) }
}

async function requestCsrfBootstrap(): Promise<string> {
  const endpoint = new URL(buildPath('/api/session', undefined), window.location.href)
  if (endpoint.origin !== window.location.origin) {
    throw new ApiError({ message: 'The Host CSRF bootstrap must use the same origin as Studio.', kind: 'http' })
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), 8_000)
  try {
    const response = await fetch(endpoint.href, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.trim() === '' ? undefined : JSON.parse(text)
    } catch {
      throw new ApiError({ message: 'The Host returned an invalid CSRF bootstrap response.', kind: 'parse', status: response.status })
    }
    if (!response.ok) {
      const info = errorFromBody(parsed, response.status)
      throw new ApiError({ message: info.message, kind: 'http', status: response.status, code: info.code })
    }
    const token = N.str(N.record(parsed).csrf)
    if (!token) throw new ApiError({ message: 'The Host did not provide a CSRF token for this session.', kind: 'parse', status: response.status })
    csrfToken = token
    return token
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError({ message: 'The Host did not answer the CSRF bootstrap in time.', kind: 'timeout', retryable: false })
    }
    throw new ApiError({
      message: error instanceof Error ? error.message : 'The Host could not establish a CSRF session.',
      kind: 'offline',
      retryable: false,
    })
  } finally {
    window.clearTimeout(timer)
  }
}

async function ensureCsrfToken(): Promise<string> {
  const existing = hostConfig().csrf ?? csrfToken ?? readStoredCsrf()
  if (existing) {
    csrfToken = existing
    return existing
  }
  if (!csrfBootstrapPromise) csrfBootstrapPromise = requestCsrfBootstrap()
  const pending = csrfBootstrapPromise
  try {
    return await pending
  } finally {
    if (csrfBootstrapPromise === pending) csrfBootstrapPromise = null
  }
}

async function perform<T>(path: string, options: RequestOptions): Promise<T> {
  const method = options.method ?? 'GET'
  const idempotent = method === 'GET'
  if (!idempotent) {
    if (options.signal?.aborted) throw new ApiError({ message: 'Request cancelled.', kind: 'aborted' })
    await ensureCsrfToken()
    if (options.signal?.aborted) throw new ApiError({ message: 'Request cancelled.', kind: 'aborted' })
  }
  const attempts = options.retries ?? (idempotent ? IDEMPOTENT_RETRIES : 0)
  const url = buildPath(path, options.query)
  let lastError: ApiError | null = null

  for (let attempt = 0; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'
      const csrf = hostConfig().csrf ?? csrfToken ?? readStoredCsrf()
      if (csrf) headers['X-HyMemory-CSRF'] = csrf

      const response = await fetch(url, {
        method,
        credentials: 'include',
        headers,
        cache: 'no-store',
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })

      const text = await response.text()
      let parsed: unknown = undefined
      if (text.trim() !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          if (response.ok) {
            throw new ApiError({ message: 'The Host returned a malformed JSON response.', kind: 'parse', status: response.status })
          }
        }
      }

      if (!response.ok) {
        const info = errorFromBody(parsed, response.status)
        const retryable = response.status === 503 || response.status === 502 || response.status === 504
        const failure = new ApiError({
          message: info.message,
          kind: response.status === 503 ? 'http' : 'http',
          status: response.status,
          code: info.code,
          retryable,
          ...(info.details ? { details: info.details } : {}),
        })
        if (retryable && attempt < attempts) {
          lastError = failure
          await sleep(250 * (attempt + 1))
          continue
        }
        throw failure
      }

      return parsed as T
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.retryable && attempt < attempts) {
          lastError = error
          await sleep(250 * (attempt + 1))
          continue
        }
        throw error
      }
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
      if (aborted && options.signal?.aborted) {
        throw new ApiError({ message: 'Request cancelled.', kind: 'aborted' })
      }
      if (timedOut || aborted) {
        const failure = new ApiError({ message: 'The Host did not answer in time.', kind: 'timeout', retryable: true })
        if (attempt < attempts) {
          lastError = failure
          await sleep(250 * (attempt + 1))
          continue
        }
        throw failure
      }
      const failure = new ApiError({
        message: error instanceof Error ? error.message : 'Network request failed.',
        kind: 'offline',
        retryable: true,
      })
      if (attempt < attempts) {
        lastError = failure
        await sleep(250 * (attempt + 1))
        continue
      }
      throw failure
    } finally {
      window.clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  throw lastError ?? new ApiError({ message: 'Request failed.', kind: 'offline' })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

type FixtureModule = typeof import('./dev-mock')
let fixtureModule: FixtureModule | null = null

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (FIXTURE_MODE) {
    // Fixture mode is an explicit, build-time opt-in (`VITE_USE_FIXTURES=1`).
    // It never activates in a normal production build: `vite.config.ts` compiles
    // the flag to a literal, so this branch is dead code and the dynamic import
    // is dropped from the production bundle.
    fixtureModule ??= await import('./dev-mock')
    const fixture = fixtureModule.fixtureRequest(path, options)
    const body = N.record(fixture)
    if (N.isRecord(body.error)) {
      const info = N.record(body.error)
      throw new ApiError({
        message: N.str(info.message) ?? 'Fixture mode has no data for this request.',
        kind: 'http',
        status: N.str(info.code) === 'E_REVISION_MISMATCH' ? 409 : 404,
        code: N.str(info.code) ?? 'E_NOT_FOUND',
      })
    }
    return fixture as T
  }
  return perform<T>(path, options)
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  /** `GET /api/health` — plugin/worker/DB/UI status. */
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return N.health(await request<unknown>('/api/health', { signal, timeoutMs: 8_000 }))
  },

  /** `GET /api/studio-config` — locale, theme, capabilities. */
  async studioConfig(signal?: AbortSignal): Promise<StudioConfig> {
    return N.studioConfig(await request<unknown>('/api/studio-config', { signal }))
  },

  /** `GET /api/projects` — projects + workspaces visible to the caller. */
  async projects(signal?: AbortSignal): Promise<Project[]> {
    return N.projects(await request<unknown>('/api/projects', { signal }))
  },

  /** `GET /api/overview` — KPI counts, recent memories, jobs, usage. */
  async overview(query: { projectId?: string; workspaceId?: string }, signal?: AbortSignal): Promise<OverviewResponse> {
    return N.overview(await request<unknown>('/api/overview', { query, signal }))
  },

  /** `GET /api/memories` — paged browser. */
  async memories(query: MemoryQuery, signal?: AbortSignal): Promise<Page<MemorySummary>> {
    return N.pageOf(await request<unknown>('/api/memories', { query: { ...query }, signal }), N.memorySummary)
  },

  /** `GET /api/memories/:id` — record + evidence + versions + claims + bindings. */
  async memory(id: string, signal?: AbortSignal): Promise<MemoryDetail> {
    const detail = N.memoryDetail(await request<unknown>(`/api/memories/${encodeURIComponent(id)}`, { signal }), id)
    if (!detail) {
      throw new ApiError({ message: 'The Host returned an empty memory record.', kind: 'parse', status: 200 })
    }
    return detail
  },

  /** `POST /api/memories/:id/transition` — state machine transition. */
  async transitionMemory(id: string, input: TransitionInput): Promise<{ status?: MemoryStatus; revision?: number }> {
    const raw = await request<unknown>(`/api/memories/${encodeURIComponent(id)}/transition`, {
      method: 'POST',
      body: input,
    })
    const value = N.record(raw)
    return {
      ...(N.str(value.status) ? { status: N.str(value.status) as MemoryStatus } : {}),
      ...(N.int(value.revision) !== undefined ? { revision: N.int(value.revision) } : {}),
    }
  },

  /** `POST /api/memories/:id/feedback`. */
  async feedbackMemory(id: string, input: FeedbackInput): Promise<void> {
    await request<unknown>(`/api/memories/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: input })
  },

  /** `GET /api/conflicts` — conflict cases with both claims. */
  async conflicts(query: { projectId?: string; state?: string }, signal?: AbortSignal): Promise<ConflictCase[]> {
    return N.pageOf(await request<unknown>('/api/conflicts', { query, signal }), N.conflict).items
  },

  /** `POST /api/conflicts/:id/resolve`. */
  async resolveConflict(id: string, input: ConflictResolveInput): Promise<ConflictResolveResult> {
    const raw = await request<unknown>(`/api/conflicts/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: input })
    const value = N.record(raw)
    const projected = N.record(value.result)
    const conflict = N.conflict(value.conflict)
    const olderStatus = N.str(projected.olderStatus)
    const newerStatus = N.str(projected.newerStatus)
    const state = N.str(projected.state)
    const auditEventId = N.str(projected.auditEventId)
    const result: NonNullable<ConflictResolveResult['result']> = {
      ...(olderStatus ? { olderStatus: olderStatus as MemoryStatus } : {}),
      ...(newerStatus ? { newerStatus: newerStatus as MemoryStatus } : {}),
      ...(state ? { state: state as ConflictState } : {}),
      ...(auditEventId ? { auditEventId } : {}),
    }
    return {
      ...(conflict ? { conflict } : {}),
      ...(Object.keys(result).length > 0 ? { result } : {}),
    }
  },

  /** `GET /api/agents` — agents/sessions/grants summary. */
  async agents(query: { projectId?: string }, signal?: AbortSignal): Promise<AgentSummary[]> {
    return N.pageOf(await request<unknown>('/api/agents', { query, signal }), N.agent).items
  },

  /** `GET /api/grants`. */
  async grants(query: { projectId?: string }, signal?: AbortSignal): Promise<Grant[]> {
    return N.pageOf(await request<unknown>('/api/grants', { query, signal }), N.grant).items
  },

  /** `POST /api/grants`. */
  async createGrant(input: GrantInput): Promise<Grant | null> {
    return N.grant(await request<unknown>('/api/grants', { method: 'POST', body: input }))
  },

  /** `DELETE /api/grants/:id`. */
  async deleteGrant(id: string): Promise<void> {
    await request<unknown>(`/api/grants/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  /** `GET /api/jobs` — capture queue. */
  async jobs(query: { status?: string }, signal?: AbortSignal): Promise<Page<CaptureJob> & { byStatus?: JobSummary['byStatus'] }> {
    const raw = await request<unknown>('/api/jobs', { query, signal })
    const page = N.pageOf(raw, N.job)
    const value = N.record(raw)
    const byStatus: JobSummary['byStatus'] = {}
    for (const [key, count] of Object.entries(N.record(value.byStatus))) {
      const parsed = N.int(count)
      if (parsed !== undefined) byStatus[key] = parsed
    }
    return Object.keys(byStatus).length > 0 ? { ...page, byStatus } : page
  },

  /** `POST /api/jobs/:id/retry`. */
  async retryJob(id: string): Promise<void> {
    await request<unknown>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  },

  /**
   * Cancel is not part of the frozen contract table; it is offered only when
   * `/api/studio-config` advertises `capabilities.canCancelJobs`.
   */
  async cancelJob(id: string): Promise<void> {
    await request<unknown>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  },

  /** `GET /api/usage` — usage + quality metrics. */
  async usage(query: { projectId?: string }, signal?: AbortSignal): Promise<UsageResponse> {
    return N.usage(await request<unknown>('/api/usage', { query, signal }))
  },

  /** `GET /api/settings` — `{ settings, revision }`. */
  async settings(signal?: AbortSignal): Promise<SettingsResponse> {
    return N.settings(await request<unknown>('/api/settings', { signal }))
  },

  /** `PUT /api/settings` — optimistic concurrency via `expectedRevision`. */
  async saveSettings(input: SettingsSaveInput): Promise<SettingsResponse> {
    return N.settings(await request<unknown>('/api/settings', { method: 'PUT', body: input }))
  },

  /** `GET /api/diagnostics`. */
  async diagnostics(signal?: AbortSignal): Promise<DiagnosticsResponse> {
    return N.diagnostics(await request<unknown>('/api/diagnostics', { signal }))
  },

  /** `GET /api/events` — redacted audit events. */
  async events(limit: number, signal?: AbortSignal): Promise<AuditEvent[]> {
    return N.pageOf(await request<unknown>('/api/events', { query: { limit }, signal }), N.auditEvent).items
  },

  /** `GET /api/code/:memoryId` — bindings + diff chain + freshness. */
  async code(memoryId: string, signal?: AbortSignal): Promise<CodeResponse> {
    return N.code(await request<unknown>(`/api/code/${encodeURIComponent(memoryId)}`, { signal }))
  },

  /** `POST /api/backup` — backup path + sha256. */
  async backup(destination?: string): Promise<BackupResult> {
    const raw = await request<unknown>('/api/backup', { method: 'POST', body: destination ? { destination } : {} })
    const value = N.record(raw)
    return {
      path: N.str(value.path) ?? '',
      sha256: N.str(value.sha256) ?? '',
      ...(N.int(value.bytes) !== undefined ? { bytes: N.int(value.bytes) } : {}),
      ...(N.str(value.createdAt) ? { createdAt: N.str(value.createdAt) } : {}),
    }
  },

  /** Absolute export URL (`GET /api/export`), used as a download link. */
  exportUrl(projectId?: string, redacted = true): string {
    const params = new URLSearchParams()
    if (projectId) params.set('projectId', projectId)
    if (redacted) params.set('redacted', '1')
    return apiUrl(`/api/export?${params.toString()}`)
  },
}

/** Re-exported so pages can distinguish permission/degraded states without importing normalize. */
export { N as normalize }
