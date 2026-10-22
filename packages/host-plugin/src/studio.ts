/**
 * Memory Studio backend: authenticated loopback HTTP API plus the built SPA.
 *
 * Security model:
 * - binds 127.0.0.1 only;
 * - a random UI token is required once (`/studio/?token=`), then an HttpOnly
 *   partitioned cross-site cookie carries the session into the DSH iframe;
 * - mutations require the `X-HyMemory-CSRF` header;
 * - `frame-ancestors` is restricted to the local DSH web origins;
 * - no CORS headers are emitted, so a page from another origin cannot read
 *   responses.
 *
 * Response bodies use the camelCase field names the Studio normalizers expect;
 * the SQLite rows keep their snake_case column names internally.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { ErrorCode, HyMemoryError, errorPayload, randomToken } from '@dsh-hy-memory/contracts'
import { evaluateFreshness } from '@dsh-hy-memory/coding-trace'
import type { HostRuntime } from './runtime.js'

const MAX_BODY = 4 * 1024 * 1024
const PLUGIN_VERSION = '0.1.0'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

interface StudioOptions {
  runtime: HostRuntime
  host: string
  port: number
  token: string
  studioDir: string
  frameOrigins: string[]
  cookieSecret: string
}

type Row = Record<string, unknown>

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

function fail(response: ServerResponse, error: unknown): void {
  const payload = errorPayload(error)
  const status = error instanceof HyMemoryError ? error.status : 500
  json(response, status, payload)
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new HyMemoryError(ErrorCode.VALIDATION, 'request body too large', 413)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HyMemoryError(ErrorCode.VALIDATION, 'body must be a JSON object', 400)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HyMemoryError) throw error
    throw new HyMemoryError(ErrorCode.VALIDATION, 'invalid JSON body', 400)
  }
}

function memorySummary(row: Row | object): Row {
  const source = row as Row
  const evidence = Array.isArray(source.evidenceIds) ? source.evidenceIds.length : 0
  return {
    id: source.id,
    title: source.title,
    content: source.canonical_text ?? source.content ?? '',
    excerpt: String(source.canonical_text ?? source.content ?? '').slice(0, 240),
    status: source.status,
    scope: source.scope,
    scene: source.scene,
    kind: source.kind,
    sensitivity: source.sensitivity,
    projectId: source.project_id,
    workspaceId: source.workspace_id ?? undefined,
    agentId: source.agent_id ?? undefined,
    evidenceCount: evidence,
    version: source.version,
    revision: source.revision,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
  }
}

function memoryDetailPayload(runtime: HostRuntime, id: string): Row | null {
  const store = runtime.store
  const record = store.getMemory(id, 'owner')
  if (!record) return null
  const raw = store.getRawMemory(id)
  const evidence = store.getEvidenceFor(id).map(item => ({
    id: item.id,
    sourceEventId: item.source_event_id,
    type: item.type,
    uri: item.uri ?? undefined,
    sha256: item.sha256,
    trustLevel: item.trust_level,
    revision: item.revision,
    verifiedAt: item.verified_at ?? undefined,
    retentionDays: item.retention_days ?? undefined,
    excerpt: item.excerpt ?? undefined,
    createdAt: item.created_at,
  }))
  const versions = store.listVersions(id).map(item => ({
    id: item.id,
    version: item.parent_version ?? 1,
    createdAt: item.created_at,
    authorPrincipalId: item.actor_id,
    note: item.change_reason,
  }))
  const claims = store.db
    .prepare('SELECT * FROM memory_claims WHERE memory_id = ? ORDER BY created_at')
    .all(id)
    .map(item => {
      const claim = item as Row
      return {
        id: claim.id,
        memoryId: claim.memory_id,
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        polarity: claim.polarity,
        qualifiers: JSON.parse(String(claim.qualifiers_json ?? '{}')) as Record<string, string>,
      }
    })
  const bindings = store.listCodeBindings(id).map(item => ({
    id: item.id,
    memoryId: item.memory_id,
    workspaceId: item.workspace_id,
    branch: item.branch ?? undefined,
    baseCommit: item.base_commit ?? undefined,
    headCommit: item.head_commit ?? undefined,
    filePath: item.file_path ?? undefined,
    symbol: item.symbol ?? undefined,
    patchHash: item.patch_hash ?? undefined,
    createdAt: item.created_at,
  }))
  const validations = (store.db.prepare('SELECT * FROM memory_validations WHERE memory_id = ? ORDER BY created_at DESC').all(id) as Row[]).map(item => ({
    id: item.id,
    validator: item.validator,
    commandDigest: item.command_digest,
    result: item.result,
    testedCommit: item.tested_commit ?? undefined,
    createdAt: item.created_at,
  }))
  const preview = runtime.recall.preview(record)
  return {
    memory: {
      ...memorySummary({ ...raw, evidenceIds: record.evidenceIds }),
      content: record.content,
      evidenceIds: record.evidenceIds,
      confidenceCalibration: record.confidenceCalibration,
    },
    claims,
    evidence,
    versions,
    bindings,
    validations,
    injection: { tokenCost: preview.tokenCost, withinBudget: preview.withinBudget, rendered: preview.rendered },
  }
}

/**
 * The Studio HTTP server. One instance per plugin activation; `close()` is
 * idempotent and awaited during disposal.
 */
export class StudioServer {
  private readonly options: StudioOptions
  private server: Server | null = null
  private readonly sessionValue: string

  constructor(options: StudioOptions) {
    this.options = options
    this.sessionValue = createHmac('sha256', options.cookieSecret).update(options.token).digest('hex')
  }

  get port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address.port : this.options.port
  }

  /** Start listening; resolves once the socket is bound. */
  async start(): Promise<number> {
    if (this.server) return this.port
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        try {
          fail(response, error)
        } catch {
          response.destroy()
        }
      })
    })
    this.server = server
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    return this.port
  }

  /** Stop listening and drop connections. */
  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>(resolveClose => {
      server.close(() => resolveClose())
      server.closeAllConnections?.()
    })
  }

  private authorized(request: IncomingMessage): boolean {
    const cookies = parseCookies(request.headers.cookie)
    const value = cookies['hymem_session']
    return typeof value === 'string' && safeEqual(value, this.sessionValue)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname
    response.setHeader(
      'content-security-policy',
      `frame-ancestors ${this.options.frameOrigins.join(' ')}; default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`,
    )
    response.setHeader('referrer-policy', 'no-referrer')

    if (path === '/') {
      response.writeHead(302, { location: '/studio/' })
      response.end()
      return
    }
    if (path === '/studio/login' || path === '/studio/') {
      const token = url.searchParams.get('token')
      if (token && safeEqual(token, this.options.token)) {
        response.writeHead(302, {
          location: '/studio/',
          'set-cookie': `hymem_session=${encodeURIComponent(this.sessionValue)}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/; Max-Age=86400`,
        })
        response.end()
        return
      }
      if (!this.authorized(request)) {
        json(response, 401, { error: { code: ErrorCode.UNAUTHORIZED, message: 'open the Studio through the DSH panel or a valid ?token=' } })
        return
      }
    }

    if (path.startsWith('/api/')) {
      if (!this.authorized(request)) {
        json(response, 401, { error: { code: ErrorCode.UNAUTHORIZED, message: 'authentication required' } })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const csrf = request.headers['x-hymemory-csrf']
        if (typeof csrf !== 'string' || !safeEqual(csrf, this.options.token)) {
          json(response, 403, { error: { code: ErrorCode.FORBIDDEN, message: 'CSRF token missing or invalid' } })
          return
        }
      }
      await this.api(request, response, url)
      return
    }

    if (path.startsWith('/studio')) {
      this.static(response, path)
      return
    }
    json(response, 404, { error: { code: ErrorCode.NOT_FOUND, message: 'not found' } })
  }

  private static(response: ServerResponse, path: string): void {
    const root = resolve(this.options.studioDir)
    const relative = path.replace(/^\/studio\/?/, '')
    const candidate = normalize(join(root, relative.length === 0 ? 'index.html' : relative))
    if (!candidate.startsWith(root)) {
      json(response, 403, { error: { code: ErrorCode.FORBIDDEN, message: 'path traversal rejected' } })
      return
    }
    let file = candidate
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) {
      // A missing asset must never fall back to index.html: the browser would
      // reject the HTML with a MIME error and the SPA would fail to boot.
      if (/\.[a-z0-9]+$/i.test(relative)) {
        json(response, 404, { error: { code: ErrorCode.NOT_FOUND, message: `asset not found: ${relative}` } })
        return
      }
      file = join(root, 'index.html')
      if (!existsSync(file)) {
        json(response, 404, { error: { code: ErrorCode.NOT_FOUND, message: 'Studio assets are not built; run pnpm build:studio' } })
        return
      }
    }
    const body = readFileSync(file)
    response.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    })
    response.end(body)
  }

  private async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const { runtime } = this.options
    const store = runtime.store
    const method = request.method ?? 'GET'
    const path = url.pathname
    if (method === 'GET' && path === '/api/session') {
      // The endpoint is already behind the authenticated /api gate. Keeping
      // the CSRF value out of HTML and the post-login URL lets a fresh iframe
      // bootstrap writes without weakening the mutation guard.
      json(response, 200, { csrf: this.options.token })
      return
    }
    const projectId = url.searchParams.get('projectId') ?? runtime.workspace().projectId
    const workspaceId = url.searchParams.get('workspaceId') ?? undefined
    const checkedAt = new Date().toISOString()

    if (method === 'GET' && path === '/api/health') {
      const health = await runtime.engineHealth()
      const audit = store.verifyAuditChain()
      json(response, 200, {
        ok: true,
        plugin: { version: PLUGIN_VERSION, enabled: true, dataDir: runtime.config.dataDir },
        worker: {
          ok: health.ok,
          engine: health.engine,
          engineVersion: health.version,
          degraded: health.degraded,
          reason: health.reason,
          mode: runtime.recall.settings().mode,
          queueDepth: Object.values(store.jobStats()).reduce((sum, count) => sum + count, 0),
        },
        db: { ok: audit.valid, schemaVersion: 1, path: runtime.config.dataDir },
        ui: { version: PLUGIN_VERSION, port: this.port },
        degraded: health.degraded || !audit.valid,
        reason: health.reason,
        checkedAt,
      })
      return
    }

    if (method === 'GET' && path === '/api/studio-config') {
      json(response, 200, {
        locale: 'zh-CN',
        theme: 'system',
        capabilities: { canCancelJobs: true, canBackup: true, canExport: true },
      })
      return
    }

    if (method === 'GET' && path === '/api/projects') {
      const rows = store.db
        .prepare('SELECT p.id, p.name, w.id AS workspace_id, w.root_alias, w.remote FROM projects p LEFT JOIN workspaces w ON w.project_id = p.id ORDER BY p.created_at')
        .all() as Row[]
      const map = new Map<string, Row>()
      for (const row of rows) {
        const id = String(row.id)
        const entry = map.get(id) ?? { id, name: String(row.name), workspaces: [] as Row[] }
        if (row.workspace_id) {
          ;(entry.workspaces as Row[]).push({
            id: row.workspace_id,
            rootAlias: row.root_alias ?? undefined,
            remote: row.remote ?? undefined,
          })
        }
        map.set(id, entry)
      }
      json(response, 200, { items: [...map.values()], current: runtime.workspace() })
      return
    }

    if (method === 'GET' && path === '/api/overview') {
      const overview = store.overview(projectId, workspaceId)
      const jobs = store.jobStats()
      const usage = store.usageSummary(projectId)
      const recentRows = store.listMemories({ projectId, ...(workspaceId ? { workspaceId } : null), limit: 5 }).items
      json(response, 200, {
        counts: {
          total: overview.total,
          verified: overview.verified,
          needsReview: overview.needsReview,
          proposed: overview.proposed,
          supported: overview.supported,
          conflicted: overview.conflicted,
          stale: overview.stale,
          superseded: 0,
          rejected: overview.rejected,
          deleted: 0,
        },
        health: { stale: overview.stale, conflicted: overview.conflicted, errors: usage.errors },
        usage: {
          recallCount24h: usage.recalls,
          injectedTokens24h: usage.tokensIn,
          skippedQueries24h: 0,
          errors24h: usage.errors,
          timeouts24h: 0,
        },
        trend: { retrieval: [], capture: [] },
        recent: recentRows.map(memory => memorySummary(store.getRawMemory(memory.id) ?? {})),
        jobs: {
          byStatus: jobs,
          total: Object.values(jobs).reduce((sum, count) => sum + count, 0),
          failed24h: (jobs.quarantined ?? 0) + (jobs.rejected ?? 0),
        },
      })
      return
    }

    if (method === 'GET' && path === '/api/memories') {
      const statuses = url.searchParams.getAll('status').filter(Boolean)
      const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
      const pageSize = Math.min(Number.parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20, 100)
      const result = store.listMemories({
        projectId,
        ...(workspaceId ? { workspaceId } : {}),
        ...(statuses.length > 0 ? { statuses: statuses as never[] } : {}),
        ...(url.searchParams.get('scene') ? { scene: url.searchParams.get('scene') as never } : {}),
        ...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind') as never } : {}),
        ...(url.searchParams.get('q') ? { query: url.searchParams.get('q') ?? '' } : {}),
        ...(url.searchParams.get('agentId') ? { agentId: url.searchParams.get('agentId') ?? '' } : {}),
        limit: pageSize,
        offset: (Math.max(page, 1) - 1) * pageSize,
      })
      json(response, 200, {
        items: result.items.map(memory => memorySummary(store.getRawMemory(memory.id) ?? {})),
        total: result.total,
        page,
        pageSize,
      })
      return
    }

    const memoryMatch = /^\/api\/memories\/([^/]+)(?:\/(transition|feedback))?$/.exec(path)
    if (memoryMatch) {
      const id = decodeURIComponent(memoryMatch[1]!)
      const action = memoryMatch[2]
      if (method === 'GET' && !action) {
        const payload = memoryDetailPayload(runtime, id)
        if (!payload) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
        json(response, 200, payload)
        return
      }
      if (method === 'POST' && action === 'transition') {
        const body = await readBody(request)
        const to = String(body.to ?? '')
        const reason = String(body.reason ?? '')
        const expectedRevision = Number(body.expectedRevision)
        if (!reason) throw new HyMemoryError(ErrorCode.VALIDATION, 'reason is required', 400)
        const updated = store.transition(id, to as never, 'owner', reason, expectedRevision)
        runtime.recall.invalidate()
        json(response, 200, { memory: memorySummary(store.getRawMemory(updated.id) ?? {}) })
        return
      }
      if (method === 'POST' && action === 'feedback') {
        const body = await readBody(request)
        const record = store.getMemory(id, 'owner')
        if (!record) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
        store.recordUsage({ projectId: record.projectId, operation: `ui-feedback:${String(body.kind ?? '')}`, hitIds: [id] })
        json(response, 200, { ok: true })
        return
      }
    }

    if (method === 'GET' && path === '/api/conflicts') {
      const conflicts = store.listConflicts(projectId, url.searchParams.get('state') ?? undefined)
      json(response, 200, {
        items: conflicts.map(item => ({
          id: item.id,
          state: item.state,
          reason: item.reason,
          createdAt: item.created_at,
          resolvedAt: item.resolved_at ?? undefined,
          older: {
            memoryId: item.left_memory_id,
            title: item.left_title,
            status: item.left_status,
            claim: {
              subject: item.left_subject,
              predicate: item.left_predicate,
              object: item.left_object,
              polarity: item.left_polarity,
            },
          },
          newer: {
            memoryId: item.right_memory_id,
            title: item.right_title,
            status: item.right_status,
            claim: {
              subject: item.right_subject,
              predicate: item.right_predicate,
              object: item.right_object,
              polarity: item.right_polarity,
            },
          },
        })),
      })
      return
    }
    const resolveMatch = /^\/api\/conflicts\/([^/]+)\/resolve$/.exec(path)
    if (method === 'POST' && resolveMatch) {
      const body = await readBody(request)
      const resolution = String(body.resolution ?? '')
      if (!['keep_both', 'supersede', 'reject', 'unresolved'].includes(resolution)) {
        throw new HyMemoryError(ErrorCode.VALIDATION, 'invalid resolution', 400)
      }
      store.resolveConflict(decodeURIComponent(resolveMatch[1]!), {
        resolution: resolution as 'keep_both' | 'supersede' | 'reject' | 'unresolved',
        resolver: 'owner',
        reason: String(body.reason ?? ''),
      })
      runtime.recall.invalidate()
      json(response, 200, { ok: true })
      return
    }

    if (method === 'GET' && path === '/api/agents') {
      const rows = store.db
        .prepare(
          `SELECT a.agent_id, a.principal_id, a.session_id, a.parent_agent_id, a.project_id, a.workspace_id, a.created_at, p.role
           FROM agent_sessions a JOIN principals p ON p.id = a.principal_id
           WHERE a.project_id = ? ORDER BY a.created_at`,
        )
        .all(projectId) as Row[]
      json(response, 200, {
        items: rows.map(row => ({
          id: row.agent_id,
          name: row.agent_id,
          kind: row.parent_agent_id ? 'subagent' : 'agent',
          role: row.role,
          projectId: row.project_id,
          workspaceId: row.workspace_id ?? undefined,
          parentAgentId: row.parent_agent_id ?? undefined,
          sessionCount: 1,
        })),
      })
      return
    }

    if (method === 'GET' && path === '/api/grants') {
      json(response, 200, {
        items: store.listGrants().map(grant => ({
          id: grant.id,
          subjectId: grant.subject_id,
          objectScope: grant.object_scope,
          action: grant.action,
          projectId: grant.project_id ?? undefined,
          workspaceId: grant.workspace_id ?? undefined,
          expiresAt: grant.expires_at,
          issuer: grant.issuer,
          revision: grant.revision,
          createdAt: grant.created_at,
          revokedAt: grant.revoked_at,
        })),
      })
      return
    }
    if (method === 'POST' && path === '/api/grants') {
      const body = await readBody(request)
      const grant = store.addGrant({
        subjectId: String(body.subjectId ?? ''),
        objectScope: String(body.objectScope ?? ''),
        action: String(body.action ?? 'read') as never,
        ...(body.projectId ? { projectId: String(body.projectId) } : { projectId }),
        ...(body.workspaceId ? { workspaceId: String(body.workspaceId) } : {}),
        ...(body.expiresAt ? { expiresAt: String(body.expiresAt) } : {}),
        issuer: 'owner',
      })
      runtime.recall.invalidate()
      json(response, 200, {
        grant: {
          id: grant.id,
          subjectId: grant.subject_id,
          objectScope: grant.object_scope,
          action: grant.action,
          projectId: grant.project_id ?? undefined,
          workspaceId: grant.workspace_id ?? undefined,
          expiresAt: grant.expires_at,
          issuer: grant.issuer,
          revision: grant.revision,
          createdAt: grant.created_at,
          revokedAt: grant.revoked_at,
        },
      })
      return
    }
    const grantMatch = /^\/api\/grants\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && grantMatch) {
      store.revokeGrant(decodeURIComponent(grantMatch[1]!), 'owner')
      runtime.recall.invalidate()
      json(response, 200, { ok: true })
      return
    }

    if (method === 'GET' && path === '/api/jobs') {
      const statuses = url.searchParams.getAll('status').filter(Boolean)
      json(response, 200, {
        items: store.listJobs(statuses.length > 0 ? statuses : undefined, 200).map(job => ({
          id: job.id,
          status: job.status,
          attempt: job.attempt,
          nextRetryAt: job.next_retry_at,
          errorCode: job.error_code,
          createdAt: job.created_at,
          updatedAt: job.updated_at,
          sourceKey: job.idempotency_key,
          payloadBytes: job.payload_json.length,
        })),
        stats: store.jobStats(),
      })
      return
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)\/(retry|cancel)$/.exec(path)
    if (method === 'POST' && jobMatch) {
      const id = decodeURIComponent(jobMatch[1]!)
      const action = jobMatch[2]
      // Cancel only moves a job that has not produced a record yet; an `active`
      // job is withdrawn through the memory's own delete path instead.
      const ok = action === 'cancel' ? store.cancelJob(id, 'owner') : store.retryJob(id)
      json(response, 200, { ok })
      return
    }

    if (method === 'GET' && path === '/api/usage') {
      const usage = store.usageSummary(projectId)
      json(response, 200, {
        recallCount: usage.recalls,
        injectedTokens: usage.tokensIn,
        skippedQueries: 0,
        errors: usage.errors,
        timeouts: 0,
        cacheHitRate: 0,
        perAgent: [],
        quality: {},
        cost: { rateKnown: false },
        windowHours: 24,
      })
      return
    }

    if (method === 'GET' && path === '/api/settings') {
      json(response, 200, store.getSettings())
      return
    }
    if (method === 'PUT' && path === '/api/settings') {
      const body = await readBody(request)
      const patch = body.patch
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HyMemoryError(ErrorCode.VALIDATION, 'patch object required', 400)
      const updated = store.updateSettings(patch as Record<string, unknown>, Number(body.expectedRevision), 'owner')
      runtime.recall.invalidate()
      json(response, 200, updated)
      return
    }

    if (method === 'GET' && path === '/api/events') {
      json(response, 200, {
        items: store.listAudit(Math.min(Number(url.searchParams.get('limit') ?? '100'), 500)).map(event => ({
          id: event.id,
          at: event.created_at,
          actor: event.actor,
          action: event.operation,
          objectType: event.target,
          objectId: event.target,
          outcome: event.outcome,
          detail: typeof event.detail_json === 'string' ? event.detail_json : undefined,
        })),
      })
      return
    }

    if (method === 'GET' && path === '/api/diagnostics') {
      const health = await runtime.engineHealth()
      const audit = store.verifyAuditChain()
      const auditCount = store.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }
      const head = store.db.prepare('SELECT hash FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { hash: string } | undefined
      json(response, 200, {
        versions: { plugin: PLUGIN_VERSION, node: process.version, dsh: process.env.DSH_PROFILE ?? undefined },
        dependencies: [
          { name: 'sqlite (node:sqlite)', ok: true, detail: 'built-in' },
          { name: 'python worker', ok: health.ok, detail: health.engine, required: false },
          { name: 'audit chain', ok: audit.valid, detail: audit.valid ? 'valid' : 'broken' },
        ],
        paths: { dataDir: runtime.config.dataDir, db: runtime.config.dataDir, logs: runtime.config.dataDir },
        audit: {
          ok: audit.valid,
          length: auditCount.count,
          headHash: head?.hash,
          verifiedAt: checkedAt,
          brokenAt: audit.brokenAt ?? null,
        },
        worker: {
          ok: health.ok,
          engine: health.engine,
          engineVersion: health.version,
          degraded: health.degraded,
          reason: health.reason,
        },
        permissionMatrix: [
          { role: 'owner', scopes: ['project', 'workspace', 'memory', 'global'], actions: ['read', 'propose', 'review', 'feedback', 'delete', 'admin'] },
          { role: 'main agent', scopes: ['workspace', 'agent'], actions: ['read', 'propose', 'feedback'] },
          { role: 'subagent', scopes: ['agent'], actions: ['read', 'propose', 'feedback'] },
          { role: 'unauthorized agent', scopes: [], actions: [] },
        ],
      })
      return
    }

    if (method === 'GET' && path === '/api/export') {
      json(response, 200, { export: store.exportProject(projectId, url.searchParams.get('redacted') !== '0') })
      return
    }
    if (method === 'POST' && path === '/api/backup') {
      const body = await readBody(request)
      const destination = String(body.destination ?? join(runtime.config.dataDir, 'backups', `hymem-${Date.now()}.db`))
      mkdirSync(resolve(destination, '..'), { recursive: true })
      json(response, 200, store.backup(destination))
      return
    }

    const codeMatch = /^\/api\/code\/([^/]+)$/.exec(path)
    if (method === 'GET' && codeMatch) {
      const id = decodeURIComponent(codeMatch[1]!)
      const record = store.getMemory(id, 'owner')
      if (!record) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
      const bindings = store.listCodeBindings(id)
      const workspace = runtime.workspace()
      const evaluations = bindings.map(binding => {
        const result = evaluateFreshness(
          {
            workspaceId: typeof binding.workspace_id === 'string' ? binding.workspace_id : undefined,
            branch: typeof binding.branch === 'string' ? binding.branch : null,
            headCommit: typeof binding.head_commit === 'string' ? binding.head_commit : null,
            filePath: typeof binding.file_path === 'string' ? binding.file_path : null,
          },
          {
            branch: workspace.branch ?? null,
            headCommit: workspace.headCommit ?? null,
            shallow: workspace.shallow,
            detached: workspace.detached,
            changedFiles: [],
          },
          { root: workspace.rootAlias },
        )
        return { bindingId: binding.id, ...result }
      })
      const stale = evaluations.some(item => item.state === 'stale' || item.state === 'unknown')
      json(response, 200, {
        freshness: {
          stale,
          reason: evaluations.map(item => `${item.bindingId}: ${item.state}`).join('; '),
          checkedAt,
          headCommit: workspace.headCommit,
          baseCommit: workspace.headCommit,
          dirty: workspace.dirty,
        },
        diffs: [],
        tests: [],
        bindings,
        evaluations,
      })
      return
    }

    json(response, 404, { error: { code: ErrorCode.NOT_FOUND, message: `unknown endpoint ${method} ${path}` } })
  }
}

/**
 * Resolve the UI token: configured value, else a persisted random token.
 * @param dataDir - plugin data directory.
 * @param configured - token from config, when present.
 * @returns the token and whether it was generated.
 */
export function resolveUiToken(dataDir: string, configured: string | null): { token: string; generated: boolean } {
  if (configured) return { token: configured, generated: false }
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'ui-token')
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim()
    if (value.length >= 24) return { token: value, generated: false }
  }
  const token = randomToken(32)
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return { token, generated: true }
}

/**
 * Resolve the built Studio directory, preferring the bundle-local copy.
 * @param baseDir - directory containing the built host bundle.
 * @returns absolute path to the SPA root (may not exist before build).
 */
export function resolveStudioDir(baseDir: string): string {
  const candidates = [join(baseDir, 'studio'), join(baseDir, '..', 'ui-client', 'dist')]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return candidates[0]!
}

/** List files recursively (used by diagnostics to prove assets exist). */
export function listAssets(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listAssets(path))
    else out.push(path)
  }
  return out
}


