/**
 * Governance store: the authoritative, auditable layer over derived memory.
 *
 * Responsibilities: identity/ACL, immutable evidence, memory state machine,
 * versioning, conflict cases, code bindings, validations, capture jobs,
 * injection receipts, usage metrics, settings, and a hash-chained audit log.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ALLOWED_TRANSITIONS,
  ErrorCode,
  HyMemoryError,
  PluginSettingsSchema,
  canonicalJson,
  estimateTokens,
  looksLikeEcho,
  sha256,
  uuidv7,
  type CaptureEnvelope,
  type GrantAction,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStatus,
  type PluginSettings,
  type Scene,
  type Sensitivity,
} from '@dsh-hy-memory/contracts'
import { openDatabase, transaction, memoryContentHash } from './db.js'
import { claimsConflict, deriveClaim } from './evidence.js'
import { redact } from './redact.js'

const now = (): string => new Date().toISOString()

export interface PrincipalInput {
  id: string
  kind: 'user' | 'agent' | 'service' | 'subagent'
  name: string
  role?: 'owner' | 'main' | 'subagent' | 'service'
  ownerId?: string
}

export interface AgentSessionInput {
  agentId: string
  principalId: string
  sessionId: string
  parentAgentId?: string
  projectId: string
  workspaceId?: string
}

export interface MemoryInput {
  scene: Scene
  kind: MemoryKind
  title: string
  content: string
  status?: MemoryStatus
  scope: MemoryScope
  projectId: string
  workspaceId?: string
  agentId?: string
  authorPrincipalId: string
  sensitivity?: Sensitivity
  confidence?: number
  evidenceIds?: string[]
  validFrom?: string
  validUntil?: string
  engineId?: string
  claims?: Array<{ subject: string; predicate: string; object: string; polarity?: 'affirm' | 'negate' | 'unknown'; qualifiers?: Record<string, string> }>
}

export interface MemoryFilter {
  projectId: string
  workspaceId?: string
  statuses?: MemoryStatus[]
  scene?: Scene
  kind?: MemoryKind
  scope?: MemoryScope
  agentId?: string
  query?: string
  limit?: number
  offset?: number
  includeDeleted?: boolean
}

export interface MemoryRow {
  id: string
  engine_id: string | null
  version: number
  scene: Scene
  kind: MemoryKind
  title: string
  canonical_text: string
  status: MemoryStatus
  scope: MemoryScope
  project_id: string
  workspace_id: string | null
  agent_id: string | null
  author_id: string
  sensitivity: Sensitivity
  confidence: number | null
  valid_from: string | null
  valid_until: string | null
  content_hash: string
  revision: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  tombstone: number
}

export interface EvidenceRow {
  id: string
  source_event_id: string
  type: string
  uri: string | null
  sha256: string
  trust_level: string
  revision: number
  verified_at: string | null
  retention_days: number | null
  excerpt: string | null
  created_at: string
}

export interface GrantRow {
  id: string
  subject_id: string
  object_scope: string
  action: GrantAction
  project_id: string | null
  workspace_id: string | null
  expires_at: string | null
  issuer: string
  revision: number
  created_at: string
  revoked_at: string | null
}

export interface JobRow {
  id: string
  idempotency_key: string
  status: string
  attempt: number
  next_retry_at: string | null
  error_code: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  payload_json: string
  result_json: string | null
  created_at: string
  updated_at: string
}

function toMemoryRecord(row: MemoryRow, evidenceIds: string[]): MemoryRecord {
  return {
    id: row.id,
    ...(row.engine_id ? { engineId: row.engine_id } : {}),
    version: row.version,
    scene: row.scene,
    kind: row.kind,
    title: row.title,
    content: row.canonical_text,
    status: row.status,
    scope: row.scope,
    projectId: row.project_id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    authorPrincipalId: row.author_id,
    evidenceIds,
    sensitivity: row.sensitivity,
    ...(row.valid_from ? { validFrom: row.valid_from } : {}),
    ...(row.valid_until ? { validUntil: row.valid_until } : {}),
    ...(row.confidence !== null ? { confidenceCalibration: row.confidence } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  }
}

/** Deep merge plain objects (arrays and scalars replace). */
function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out as T
}

/**
 * Authoritative governance store. One instance owns one SQLite connection;
 * use a short-lived transaction per mutation.
 */
export class GovernanceStore {
  readonly db: DatabaseSync
  private readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.db = openDatabase({ path: dbPath })
  }

  close(): void {
    this.db.close()
  }

  /* ---------------------------------------------------------------- */
  /* Identity and ACL                                                  */
  /* ---------------------------------------------------------------- */

  ensureProject(id: string, name = id): void {
    this.db
      .prepare('INSERT INTO projects(id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, name, now())
  }

  ensureWorkspace(input: { id: string; projectId: string; repoFingerprint: string; rootAlias: string; remote?: string }): void {
    this.ensureProject(input.projectId)
    this.db
      .prepare(
        `INSERT INTO workspaces(id, project_id, repo_fingerprint, root_alias, remote, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET root_alias = excluded.root_alias, remote = excluded.remote`,
      )
      .run(input.id, input.projectId, input.repoFingerprint, input.rootAlias, input.remote ?? null, now())
  }

  registerPrincipal(input: PrincipalInput): void {
    this.db
      .prepare(
        `INSERT INTO principals(id, kind, name, role, owner_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, owner_id = excluded.owner_id`,
      )
      .run(input.id, input.kind, input.name, input.role ?? (input.kind === 'agent' ? 'main' : 'service'), input.ownerId ?? null, now())
  }

  ensureOwner(id = 'owner', name = 'Local Owner'): void {
    this.registerPrincipal({ id, kind: 'user', name, role: 'owner' })
  }

  bindAgentSession(input: AgentSessionInput): void {
    this.registerPrincipal({
      id: input.principalId,
      kind: input.parentAgentId ? 'subagent' : 'agent',
      name: input.agentId,
      role: input.parentAgentId ? 'subagent' : 'main',
      ownerId: 'owner',
    })
    this.db
      .prepare(
        `INSERT INTO agent_sessions(agent_id, principal_id, session_id, parent_agent_id, project_id, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET session_id = excluded.session_id, parent_agent_id = excluded.parent_agent_id,
           project_id = excluded.project_id, workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
      )
      .run(input.agentId, input.principalId, input.sessionId, input.parentAgentId ?? null, input.projectId, input.workspaceId ?? null, now(), now())
  }

  getAgentSession(agentId: string): { agent_id: string; principal_id: string; session_id: string; parent_agent_id: string | null; project_id: string; workspace_id: string | null } | undefined {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ?').get(agentId) as
      | { agent_id: string; principal_id: string; session_id: string; parent_agent_id: string | null; project_id: string; workspace_id: string | null }
      | undefined
  }

  addGrant(input: { subjectId: string; objectScope: string; action: GrantAction; projectId?: string; workspaceId?: string; expiresAt?: string; issuer: string }): GrantRow {
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO grants(id, subject_id, object_scope, action, project_id, workspace_id, expires_at, issuer, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(subject_id, object_scope, action) DO UPDATE SET expires_at = excluded.expires_at,
           revoked_at = NULL, revision = grants.revision + 1, issuer = excluded.issuer`,
      )
      .run(id, input.subjectId, input.objectScope, input.action, input.projectId ?? null, input.workspaceId ?? null, input.expiresAt ?? null, input.issuer, now())
    this.bumpAcl(input.projectId)
    return this.db.prepare('SELECT * FROM grants WHERE subject_id = ? AND object_scope = ? AND action = ?').get(input.subjectId, input.objectScope, input.action) as unknown as GrantRow
  }

  revokeGrant(id: string, issuer: string): void {
    const grant = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as unknown as GrantRow | undefined
    if (!grant) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'grant not found', 404)
    this.db.prepare('UPDATE grants SET revoked_at = ?, revision = revision + 1, issuer = ? WHERE id = ?').run(now(), issuer, id)
    this.bumpAcl(grant.project_id ?? undefined)
    this.audit(issuer, 'grant.revoke', id, 'allow', { objectScope: grant.object_scope })
  }

  listGrants(subjectId?: string): GrantRow[] {
    if (subjectId) return this.db.prepare('SELECT * FROM grants WHERE subject_id = ? ORDER BY created_at DESC').all(subjectId) as unknown as GrantRow[]
    return this.db.prepare('SELECT * FROM grants ORDER BY created_at DESC').all() as unknown as GrantRow[]
  }

  private bumpAcl(projectId?: string): void {
    if (!projectId) return
    this.db
      .prepare(
        `INSERT INTO project_state(project_id, acl_revision, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(project_id) DO UPDATE SET acl_revision = project_state.acl_revision + 1, updated_at = excluded.updated_at`,
      )
      .run(projectId, now())
  }

  aclRevision(projectId: string): number {
    const row = this.db.prepare('SELECT acl_revision FROM project_state WHERE project_id = ?').get(projectId) as { acl_revision: number } | undefined
    return row?.acl_revision ?? 0
  }

  private activeGrant(subjectId: string, action: GrantAction | 'write', projectId?: string, workspaceId?: string, memoryId?: string): GrantRow | undefined {
    const grantAction: GrantAction = action === 'write' ? 'propose' : action
    const rows = this.db.prepare('SELECT * FROM grants WHERE subject_id = ? AND action = ? AND revoked_at IS NULL').all(subjectId, grantAction) as unknown as GrantRow[]
    const timestamp = Date.now()
    return rows.find(grant => {
      if (grant.expires_at && Date.parse(grant.expires_at) < timestamp) return false
      if (grant.object_scope === 'global') return true
      // project_id/workspace_id constrain a scoped grant; they do not grant
      // access by themselves. The grant's object_scope remains authoritative.
      if (grant.project_id && grant.project_id !== projectId) return false
      if (grant.workspace_id && grant.workspace_id !== workspaceId) return false
      if (memoryId && grant.object_scope === `memory:${memoryId}`) return true
      if (workspaceId && grant.object_scope === `workspace:${workspaceId}`) return true
      if (projectId && grant.object_scope === `project:${projectId}`) return true
      return false
    })
  }

  /**
   * Default-deny authorization. Owner has all rights; a main agent can read its
   * own project's workspace memory; subagents additionally need an explicit
   * grant for anything they did not author; `shared` memory always needs a
   * grant, even for the main agent.
   * @param principalId - authenticated principal.
   * @param action - required action.
   * @param memory - memory row (or a project/workspace scope for non-memory checks).
   * @returns whether the action is allowed.
   */
  authorize(principalId: string, action: GrantAction | 'write', memory?: MemoryRow | { projectId: string; workspaceId?: string }): boolean {
    const principal = this.db.prepare('SELECT * FROM principals WHERE id = ?').get(principalId) as
      | { id: string; kind: string; role: string }
      | undefined
    if (!principal) return false
    if (principal.role === 'owner') return true
    const session = this.db.prepare('SELECT * FROM agent_sessions WHERE principal_id = ?').get(principalId) as
      | { project_id: string; workspace_id: string | null; parent_agent_id: string | null; agent_id: string }
      | undefined
    const projectId = memory ? ('project_id' in (memory as MemoryRow) ? (memory as MemoryRow).project_id : (memory as { projectId: string }).projectId) : session?.project_id
    const workspaceId = memory
      ? 'workspace_id' in (memory as MemoryRow)
        ? (memory as MemoryRow).workspace_id ?? undefined
        : (memory as { workspaceId?: string }).workspaceId
      : session?.workspace_id ?? undefined
    const memoryId = memory && 'id' in memory ? memory.id : undefined
    if (!projectId || (session && session.project_id !== projectId)) {
      return Boolean(this.activeGrant(principalId, action, projectId, workspaceId, memoryId))
    }
    if (this.activeGrant(principalId, action, projectId, workspaceId, memoryId)) {
      return true
    }
    if (action === 'read' || action === 'feedback') {
      const row = memory as MemoryRow | undefined
      if (!row) return action === 'read'
      if (row.author_id === principalId) return true
      if (row.scope === 'private') return false
      if (row.scope === 'shared') return false
      if (row.scope === 'agent') return row.agent_id === session?.agent_id
      if (session?.parent_agent_id) return false
      if (row.scope === 'workspace') return row.workspace_id === session?.workspace_id
      if (row.scope === 'project') return row.project_id === session?.project_id
    }
    if (action === 'propose' || action === 'write') {
      return true
    }
    return false
  }

  /* ---------------------------------------------------------------- */
  /* Evidence                                                          */
  /* ---------------------------------------------------------------- */

  appendSourceEvent(input: {
    sourceKey: string
    checksum: string
    eventType: string
    payload: unknown
    sessionId?: string
    workspaceId?: string
    observedAt?: string
  }): { id: string; created: boolean; redactedPayload: string } {
    const redacted = redact(JSON.stringify(input.payload)).text
    const existing = this.db
      .prepare('SELECT id, redacted_payload FROM source_events WHERE source_key = ? AND checksum = ?')
      .get(input.sourceKey, input.checksum) as { id: string; redacted_payload: string } | undefined
    if (existing) return { id: existing.id, created: false, redactedPayload: existing.redacted_payload }
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO source_events(id, source_key, checksum, event_type, redacted_payload, session_id, workspace_id, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sourceKey, input.checksum, input.eventType, redacted, input.sessionId ?? null, input.workspaceId ?? null, input.observedAt ?? now(), now())
    return { id, created: true, redactedPayload: redacted }
  }

  addEvidence(input: {
    sourceEventId: string
    type: string
    uri?: string
    payload?: string
    trustLevel: string
    verifiedAt?: string
    retentionDays?: number
    excerpt?: string
  }): EvidenceRow {
    const id = uuidv7()
    const payload = input.payload ?? ''
    // Redact the complete payload before clipping a default or caller-supplied
    // prefix. A secret that starts just before the excerpt boundary must not be
    // persisted as an unrecognized partial token.
    const redactedPayload = redact(payload).text
    const redactedInputExcerpt = input.excerpt === undefined ? undefined : redact(input.excerpt).text
    const excerptSource =
      input.excerpt !== undefined && input.excerpt.length > 0 && payload.startsWith(input.excerpt)
        ? redactedPayload
        : (redactedInputExcerpt ?? redactedPayload)
    const excerpt = excerptSource.slice(0, 512)
    this.db
      .prepare(
        `INSERT INTO evidence_items(id, source_event_id, type, uri, sha256, trust_level, revision, verified_at, retention_days, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, input.sourceEventId, input.type, input.uri ?? null, sha256(payload), input.trustLevel, input.verifiedAt ?? null, input.retentionDays ?? null, excerpt, now())
    return this.db.prepare('SELECT * FROM evidence_items WHERE id = ?').get(id) as unknown as EvidenceRow
  }

  getEvidenceFor(memoryId: string): EvidenceRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM evidence_items e JOIN memory_evidence me ON me.evidence_id = e.id WHERE me.memory_id = ? ORDER BY e.created_at`,
      )
      .all(memoryId) as unknown as EvidenceRow[]
  }

  /** Evidence rows whose originating source event is one of the given ids. */
  evidenceForSourceEvents(sourceEventIds: string[]): EvidenceRow[] {
    if (sourceEventIds.length === 0) return []
    return this.db
      .prepare(`SELECT * FROM evidence_items WHERE source_event_id IN (${sourceEventIds.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(...sourceEventIds) as unknown as EvidenceRow[]
  }

  /** Governance memory id for an engine id, used for idempotent re-processing. */
  findMemoryByEngineId(engineId: string): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM memory_records WHERE engine_id = ?').get(engineId) as MemoryRow | undefined
  }

  /** Update only the engine id of an existing record (index rebuild keeps identity). */
  linkEngineId(memoryId: string, engineId: string): void {
    this.db.prepare('UPDATE memory_records SET engine_id = ?, updated_at = ? WHERE id = ?').run(engineId, now(), memoryId)
  }

  /* ---------------------------------------------------------------- */
  /* Memories                                                          */
  /* ---------------------------------------------------------------- */

  createMemory(input: MemoryInput, actor: string): MemoryRecord {
    const id = uuidv7()
    const timestamp = now()
    const content = redact(input.content).text
    const title = redact(input.title).text.slice(0, 200)
    const hash = memoryContentHash(title, content)
    const status = input.status ?? 'proposed'
    const evidenceIds = input.evidenceIds ?? []
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO memory_records(id, engine_id, version, scene, kind, title, canonical_text, status, scope, project_id,
             workspace_id, agent_id, author_id, sensitivity, confidence, valid_from, valid_until, content_hash, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.engineId ?? null,
          input.scene,
          input.kind,
          title,
          content,
          status,
          input.scope,
          input.projectId,
          input.workspaceId ?? null,
          input.agentId ?? null,
          input.authorPrincipalId,
          input.sensitivity ?? 'internal',
          input.confidence ?? null,
          input.validFrom ?? null,
          input.validUntil ?? null,
          hash,
          timestamp,
          timestamp,
        )
      for (const evidenceId of evidenceIds) {
        this.db
          .prepare('INSERT OR IGNORE INTO memory_evidence(memory_id, evidence_id, relation, claim_hash) VALUES (?, ?, ?, ?)')
          .run(id, evidenceId, 'supports', sha256(content))
      }
      this.insertVersion(id, 1, hash, 'created', null, actor, timestamp)
      for (const claim of input.claims ?? []) {
        const parts = claim.predicate
          ? { ...claim, polarity: claim.polarity ?? 'affirm', claimKey: sha256(`${claim.subject}|${claim.predicate}`) }
          : deriveClaim(`${input.title} ${content}`, input.projectId)
        this.db
          .prepare(
            `INSERT INTO memory_claims(id, memory_id, subject, predicate, object, polarity, qualifiers_json, claim_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uuidv7(), id, parts.subject, parts.predicate, parts.object, parts.polarity, canonicalJson(claim.qualifiers ?? {}), parts.claimKey, timestamp)
      }
      this.audit(actor, 'memory.create', id, 'allow', { status, scope: input.scope, projectId: input.projectId })
    })
    return this.getMemory(id)!
  }

  private insertVersion(memoryId: string, parentVersion: number | null, contentHash: string, reason: string, supersedesId: string | null, actor: string, timestamp: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_versions(id, memory_id, parent_version, content_hash, change_reason, supersedes_id, actor_id, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv7(), memoryId, parentVersion, contentHash, reason, supersedesId, actor, '{}', timestamp)
  }

  /**
   * Read a record including tombstones. Used by the transition path, which must
   * return the post-transition record even when it became `deleted`; every
   * ordinary read path uses {@link getMemory} and therefore cannot see it.
   */
  private recordIncludingTombstone(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as MemoryRow | undefined
    if (!row) return null
    const evidence = this.db.prepare('SELECT evidence_id FROM memory_evidence WHERE memory_id = ?').all(id) as Array<{ evidence_id: string }>
    return toMemoryRecord(row, evidence.map(item => item.evidence_id))
  }

  getMemory(id: string, principalId?: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as MemoryRow | undefined
    if (!row) return null
    // A tombstoned record is gone for every read path, including the owner:
    // deletion must not be reversible by guessing the id.
    if (row.tombstone === 1 || row.status === 'deleted') return null
    if (principalId && !this.authorize(principalId, 'read', row)) return null
    const evidence = this.db.prepare('SELECT evidence_id FROM memory_evidence WHERE memory_id = ?').all(id) as Array<{ evidence_id: string }>
    return toMemoryRecord(row, evidence.map(item => item.evidence_id))
  }

  getRawMemory(id: string): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM memory_records WHERE id = ?').get(id) as MemoryRow | undefined
  }

  /**
   * Find a live record with identical content in the same project. This is the
   * second half of capture idempotency: the engine id covers a re-run of the
   * same engine, and the content hash covers an engine that mints a new id for
   * the same text (the mock does, and a real model-backed run can too).
   * @param projectId - project scope.
   * @param title - candidate title.
   * @param content - candidate text.
   * @returns the existing row, or undefined.
   */
  findMemoryByContent(projectId: string, title: string, content: string): MemoryRow | undefined {
    const hash = memoryContentHash(title.slice(0, 200), content)
    return this.db
      .prepare('SELECT * FROM memory_records WHERE project_id = ? AND content_hash = ? AND tombstone = 0 LIMIT 1')
      .get(projectId, hash) as MemoryRow | undefined
  }

  listMemories(filter: MemoryFilter): { items: MemoryRecord[]; total: number } {
    const conditions: string[] = ['m.project_id = ?']
    const params: Array<string | number> = [filter.projectId]
    if (filter.workspaceId) {
      conditions.push('m.workspace_id = ?')
      params.push(filter.workspaceId)
    }
    if (!filter.includeDeleted) conditions.push("m.status != 'deleted' AND m.tombstone = 0")
    if (filter.statuses && filter.statuses.length > 0) {
      conditions.push(`m.status IN (${filter.statuses.map(() => '?').join(',')})`)
      params.push(...filter.statuses)
    }
    if (filter.scene) {
      conditions.push('m.scene = ?')
      params.push(filter.scene)
    }
    if (filter.kind) {
      conditions.push('m.kind = ?')
      params.push(filter.kind)
    }
    if (filter.scope) {
      conditions.push('m.scope = ?')
      params.push(filter.scope)
    }
    if (filter.agentId) {
      conditions.push('m.agent_id = ?')
      params.push(filter.agentId)
    }
    let from = 'memory_records m'
    if (filter.query && filter.query.trim().length > 0) {
      const tokens = filter.query
        .split(/[^\p{L}\p{N}_.:/-]+/u)
        .filter(token => token.length > 1)
        .slice(0, 12)
        .map(token => `"${token.replaceAll('"', '""')}"`)
      if (tokens.length > 0) {
        from = 'memory_records m JOIN memory_fts f ON f.memory_id = m.id'
        conditions.push('memory_fts MATCH ?')
        params.push(tokens.join(' OR '))
      }
    }
    const where = conditions.join(' AND ')
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`).get(...params) as { total: number }
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200)
    const offset = Math.max(filter.offset ?? 0, 0)
    const rows = this.db
      .prepare(`SELECT m.* FROM ${from} WHERE ${where} ORDER BY m.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as MemoryRow[]
    const items = rows.map(row => {
      const evidence = this.db.prepare('SELECT evidence_id FROM memory_evidence WHERE memory_id = ?').all(row.id) as Array<{ evidence_id: string }>
      return toMemoryRecord(row, evidence.map(item => item.evidence_id))
    })
    return { items, total: countRow.total }
  }

  updateMemory(
    id: string,
    patch: { title?: string; content?: string; kind?: MemoryKind; scope?: MemoryScope; sensitivity?: Sensitivity; validFrom?: string; validUntil?: string },
    expectedRevision: number,
    actor: string,
  ): MemoryRecord {
    const row = this.getRawMemory(id)
    if (!row) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
    if (row.revision !== expectedRevision) {
      throw new HyMemoryError(ErrorCode.REVISION_MISMATCH, `expected revision ${expectedRevision}, found ${row.revision}`, 409)
    }
    if (row.tombstone === 1) throw new HyMemoryError(ErrorCode.CONFLICT, 'memory is deleted', 409)
    const title = redact(patch.title ?? row.title).text.slice(0, 200)
    const content = redact(patch.content ?? row.canonical_text).text
    const hash = memoryContentHash(title, content)
    const timestamp = now()
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE memory_records SET title = ?, canonical_text = ?, kind = ?, scope = ?, sensitivity = ?, valid_from = ?, valid_until = ?,
             content_hash = ?, version = version + 1, revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          title,
          content,
          patch.kind ?? row.kind,
          patch.scope ?? row.scope,
          patch.sensitivity ?? row.sensitivity,
          patch.validFrom ?? row.valid_from,
          patch.validUntil ?? row.valid_until,
          hash,
          timestamp,
          id,
        )
      this.insertVersion(id, row.version, hash, 'content_update', null, actor, timestamp)
      this.audit(actor, 'memory.update', id, 'allow', { fromVersion: row.version })
    })
    return this.getMemory(id)!
  }

  /**
   * Apply a status transition with optimistic revision checking and audit.
   * `verified` additionally requires a passing validation record; model output
   * can never satisfy that requirement.
   * @param id - memory id.
   * @param to - destination status.
   * @param actor - acting principal.
   * @param reason - human-readable reason recorded in history.
   * @param expectedRevision - caller's observed revision.
   * @returns the updated record.
   */
  transition(id: string, to: MemoryStatus, actor: string, reason: string, expectedRevision: number): MemoryRecord {
    const row = this.getRawMemory(id)
    if (!row) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
    if (row.revision !== expectedRevision) {
      throw new HyMemoryError(ErrorCode.REVISION_MISMATCH, `expected revision ${expectedRevision}, found ${row.revision}`, 409)
    }
    if (!ALLOWED_TRANSITIONS[row.status].includes(to)) {
      throw new HyMemoryError(ErrorCode.CONFLICT, `illegal transition ${row.status} -> ${to}`, 409)
    }
    if (to === 'verified') {
      const validation = this.db
        .prepare("SELECT COUNT(*) AS count FROM memory_validations WHERE memory_id = ? AND result = 'pass'")
        .get(id) as { count: number }
      if (validation.count === 0) {
        throw new HyMemoryError(ErrorCode.VALIDATION, 'verified requires a real passing validation record', 409)
      }
      const trusted = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_evidence me JOIN evidence_items e ON e.id = me.evidence_id
           WHERE me.memory_id = ? AND e.trust_level IN ('test_verified','repository_observed','tool_observed')`,
        )
        .get(id) as { count: number }
      if (trusted.count === 0) throw new HyMemoryError(ErrorCode.VALIDATION, 'verified requires trusted evidence', 409)
    }
    const timestamp = now()
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE memory_records SET status = ?, revision = revision + 1, updated_at = ?, deleted_at = ?, tombstone = ? WHERE id = ?')
        .run(to, timestamp, to === 'deleted' ? timestamp : row.deleted_at, to === 'deleted' ? 1 : row.tombstone, id)
      if (to === 'deleted') {
        this.db.prepare('INSERT OR REPLACE INTO tombstones(memory_id, reason, actor, created_at) VALUES (?, ?, ?, ?)').run(id, reason, actor, timestamp)
      }
      this.db
        .prepare(
          `INSERT INTO memory_versions(id, memory_id, parent_version, content_hash, change_reason, supersedes_id, actor_id, snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(uuidv7(), id, row.version, row.content_hash, `status:${row.status}->${to}:${reason}`, actor, '{}', timestamp)
      this.audit(actor, 'memory.transition', id, 'allow', { from: row.status, to, reason })
    })
    return this.recordIncludingTombstone(id)!
  }

  /** Physically remove content but keep a tombstone (explicit purge only). */
  purgeMemory(id: string, actor: string, reason: string): void {
    const row = this.getRawMemory(id)
    if (!row) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
    transaction(this.db, () => {
      this.db.prepare("UPDATE memory_records SET status = 'deleted', canonical_text = '', title = '[purged]', tombstone = 1, revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), id)
      this.db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(id)
      this.db.prepare('DELETE FROM memory_claims WHERE memory_id = ?').run(id)
      this.db.prepare('DELETE FROM code_bindings WHERE memory_id = ?').run(id)
      this.db.prepare('INSERT OR REPLACE INTO tombstones(memory_id, reason, actor, created_at) VALUES (?, ?, ?, ?)').run(id, reason, actor, now())
      this.audit(actor, 'memory.purge', id, 'allow', { reason })
    })
  }

  listVersions(memoryId: string): Array<{ id: string; parent_version: number | null; content_hash: string; change_reason: string; actor_id: string; created_at: string }> {
    return this.db
      .prepare('SELECT id, parent_version, content_hash, change_reason, actor_id, created_at FROM memory_versions WHERE memory_id = ? ORDER BY created_at ASC')
      .all(memoryId) as Array<{ id: string; parent_version: number | null; content_hash: string; change_reason: string; actor_id: string; created_at: string }>
  }

  /* ---------------------------------------------------------------- */
  /* Claims and conflicts                                              */
  /* ---------------------------------------------------------------- */

  addClaim(memoryId: string, claim: { subject: string; predicate: string; object: string; polarity?: 'affirm' | 'negate' | 'unknown'; qualifiers?: Record<string, string>; validFrom?: string; validUntil?: string }): string {
    const id = uuidv7()
    const polarity = claim.polarity ?? 'affirm'
    const claimKey = sha256(`${claim.subject}|${claim.predicate}`)
    this.db
      .prepare(
        `INSERT INTO memory_claims(id, memory_id, subject, predicate, object, polarity, qualifiers_json, valid_from, valid_until, claim_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, memoryId, claim.subject, claim.predicate, claim.object, polarity, canonicalJson(claim.qualifiers ?? {}), claim.validFrom ?? null, claim.validUntil ?? null, claimKey, now())
    return id
  }

  /**
   * Detect and record conflicts for a claim against live claims in the same
   * project. Returns created conflict ids; never resolves automatically.
   */
  detectConflicts(memoryId: string, actor: string): string[] {
    const memory = this.getRawMemory(memoryId)
    if (!memory) return []
    const claims = this.db.prepare('SELECT * FROM memory_claims WHERE memory_id = ?').all(memoryId) as Array<{
      id: string
      subject: string
      predicate: string
      object: string
      polarity: string
      claim_key: string
    }>
    const created: string[] = []
    for (const claim of claims) {
      const others = this.db
        .prepare(
          `SELECT c.*, m.project_id, m.status AS memory_status FROM memory_claims c
           JOIN memory_records m ON m.id = c.memory_id
           WHERE c.claim_key = ? AND c.memory_id != ? AND m.tombstone = 0 AND m.status IN ('proposed','needs_review','supported','verified','conflicted')`,
        )
        .all(claim.claim_key, memoryId) as Array<{ id: string; memory_id: string; subject: string; predicate: string; object: string; polarity: string; project_id: string; memory_status: string }>
      for (const other of others) {
        if (other.project_id !== memory.project_id) continue
        const reason = claimsConflict(claim, other)
        if (!reason) continue
        const existing = this.db
          .prepare('SELECT id FROM conflict_cases WHERE (left_claim_id = ? AND right_claim_id = ?) OR (left_claim_id = ? AND right_claim_id = ?) AND state = ?')
          .get(claim.id, other.id, other.id, claim.id, 'open') as { id: string } | undefined
        if (existing) continue
        const conflictId = uuidv7()
        this.db
          .prepare(
            `INSERT INTO conflict_cases(id, left_claim_id, right_claim_id, left_memory_id, right_memory_id, reason, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
          )
          .run(conflictId, other.id, claim.id, other.memory_id, memoryId, reason, now())
        if (other.memory_status === 'verified' || other.memory_status === 'supported') {
          this.db.prepare("UPDATE memory_records SET status = 'conflicted', revision = revision + 1, updated_at = ? WHERE id = ? AND status IN ('supported','verified')").run(now(), memoryId)
        }
        this.audit(actor, 'conflict.create', conflictId, 'allow', { reason, left: other.memory_id, right: memoryId })
        created.push(conflictId)
      }
    }
    return created
  }

  listConflicts(projectId: string, state?: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT cc.*, lm.title AS left_title, lm.status AS left_status, rm.title AS right_title, rm.status AS right_status,
                lc.subject AS left_subject, lc.predicate AS left_predicate, lc.object AS left_object, lc.polarity AS left_polarity,
                rc.subject AS right_subject, rc.predicate AS right_predicate, rc.object AS right_object, rc.polarity AS right_polarity
         FROM conflict_cases cc
         JOIN memory_records lm ON lm.id = cc.left_memory_id
         JOIN memory_records rm ON rm.id = cc.right_memory_id
         JOIN memory_claims lc ON lc.id = cc.left_claim_id
         JOIN memory_claims rc ON rc.id = cc.right_claim_id
         WHERE lm.project_id = ? ${state ? 'AND cc.state = ?' : ''}
         ORDER BY cc.created_at DESC`,
      )
      .all(...(state ? [projectId, state] : [projectId])) as Array<Record<string, unknown>>
    return rows
  }

  resolveConflict(
    id: string,
    input: { resolution: 'keep_both' | 'supersede' | 'reject' | 'unresolved'; resolver: string; reason: string; expectedRevision?: number },
  ): void {
    const conflict = this.db.prepare('SELECT * FROM conflict_cases WHERE id = ?').get(id) as
      | { id: string; left_memory_id: string; right_memory_id: string; state: string }
      | undefined
    if (!conflict) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'conflict not found', 404)
    if (conflict.state !== 'open' && conflict.state !== 'unresolved') {
      throw new HyMemoryError(ErrorCode.CONFLICT, 'conflict already resolved', 409)
    }
    transaction(this.db, () => {
      const state = input.resolution === 'keep_both' ? 'resolved_keep_both' : input.resolution === 'supersede' ? 'resolved_supersede' : input.resolution === 'reject' ? 'resolved_reject' : 'unresolved'
      this.db.prepare('UPDATE conflict_cases SET state = ?, resolution = ?, resolver = ?, resolved_at = ? WHERE id = ?').run(state, input.reason, input.resolver, now(), id)
      if (input.resolution === 'supersede') {
        this.db.prepare("UPDATE memory_records SET status = 'superseded', revision = revision + 1, updated_at = ? WHERE id = ? AND status != 'deleted'").run(now(), conflict.right_memory_id)
        this.db.prepare("UPDATE memory_records SET status = 'supported', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'conflicted'").run(now(), conflict.left_memory_id)
      } else if (input.resolution === 'reject') {
        this.db.prepare("UPDATE memory_records SET status = 'rejected', revision = revision + 1, updated_at = ? WHERE id = ? AND status != 'deleted'").run(now(), conflict.right_memory_id)
        this.db.prepare("UPDATE memory_records SET status = 'supported', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'conflicted'").run(now(), conflict.left_memory_id)
      } else if (input.resolution === 'keep_both') {
        this.db.prepare("UPDATE memory_records SET status = 'supported', revision = revision + 1, updated_at = ? WHERE id IN (?, ?) AND status = 'conflicted'").run(now(), conflict.left_memory_id, conflict.right_memory_id)
      }
      this.audit(input.resolver, 'conflict.resolve', id, 'allow', { resolution: input.resolution, reason: input.reason })
    })
  }

  /* ---------------------------------------------------------------- */
  /* Validations and code bindings                                     */
  /* ---------------------------------------------------------------- */

  addValidation(input: {
    memoryId: string
    validator: string
    commandDigest: string
    result: 'pass' | 'fail' | 'error'
    testedCommit?: string
    evidenceId?: string
    detail?: unknown
  }): string {
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO memory_validations(id, memory_id, validator, command_digest, result, tested_commit, evidence_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.memoryId, input.validator, input.commandDigest, input.result, input.testedCommit ?? null, input.evidenceId ?? null, canonicalJson(input.detail ?? {}), now())
    this.audit(input.validator, 'memory.validate', input.memoryId, input.result, { result: input.result })
    return id
  }

  addCodeBinding(input: {
    memoryId: string
    workspaceId: string
    branch?: string
    baseCommit?: string
    headCommit?: string
    filePath?: string
    symbol?: string
    signatureHash?: string
    patchHash?: string
    chain?: unknown
  }): string {
    const id = uuidv7()
    this.db
      .prepare(
        `INSERT INTO code_bindings(id, memory_id, workspace_id, branch, base_commit, head_commit, file_path, symbol, signature_hash, patch_hash, chain_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.memoryId,
        input.workspaceId,
        input.branch ?? null,
        input.baseCommit ?? null,
        input.headCommit ?? null,
        input.filePath ?? null,
        input.symbol ?? null,
        input.signatureHash ?? null,
        input.patchHash ?? null,
        canonicalJson(input.chain ?? {}),
        now(),
      )
    return id
  }

  listCodeBindings(memoryId: string): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM code_bindings WHERE memory_id = ?').all(memoryId) as Array<Record<string, unknown>>
  }

  /* ---------------------------------------------------------------- */
  /* Job queue                                                         */
  /* ---------------------------------------------------------------- */

  enqueueJob(envelope: CaptureEnvelope, idempotencyKey: string): { job: JobRow; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM capture_jobs WHERE idempotency_key = ?').get(idempotencyKey) as unknown as JobRow | undefined
    if (existing) return { job: existing, created: false }
    const id = uuidv7()
    // The queue is durable, so its payload is a persistence boundary: redact it
    // here even when the caller already did, so no code path can store a secret.
    const serialized = JSON.stringify(envelope)
    if (serialized === undefined) throw new HyMemoryError(ErrorCode.VALIDATION, 'capture envelope cannot be serialized')
    const payload = redact(serialized).text
    this.db
      .prepare(
        `INSERT INTO capture_jobs(id, idempotency_key, status, attempt, next_retry_at, payload_json, created_at, updated_at)
         VALUES (?, ?, 'received', 0, ?, ?, ?, ?)`,
      )
      .run(id, idempotencyKey, now(), payload, now(), now())
    return { job: this.db.prepare('SELECT * FROM capture_jobs WHERE id = ?').get(id) as unknown as JobRow, created: true }
  }

  leaseJobs(owner: string, limit = 2, leaseMs = 60_000): JobRow[] {
    return transaction(this.db, () => {
      const timestamp = now()
      const eligible = `((status IN ('received','redacted','retryable') AND (next_retry_at IS NULL OR next_retry_at <= ?))
         OR (status = 'extracting' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`
      const rows = this.db
        .prepare(`SELECT * FROM capture_jobs WHERE ${eligible} ORDER BY created_at ASC LIMIT ?`)
        .all(timestamp, timestamp, limit) as unknown as JobRow[]
      const expires = new Date(Date.parse(timestamp) + leaseMs).toISOString()
      const leased: JobRow[] = []
      const update = this.db.prepare(
        `UPDATE capture_jobs SET status = 'extracting', attempt = attempt + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND ${eligible}`,
      )
      for (const row of rows) {
        const result = update.run(owner, expires, timestamp, row.id, timestamp, timestamp)
        if (result.changes > 0) {
          leased.push({ ...row, status: 'extracting', attempt: row.attempt + 1, lease_owner: owner, lease_expires_at: expires })
        }
      }
      return leased
    })
  }

  completeJob(id: string, result: unknown, lease?: { owner: string; attempt: number }): boolean {
    // Synchronous CLI captures finish directly from the received state. Host
    // consumers always supply their lease and must still own that exact attempt.
    const stateFilter = lease ? "status = 'extracting'" : "status IN ('received','redacted') AND lease_owner IS NULL"
    const leaseFilter = lease ? ' AND lease_owner = ? AND attempt = ?' : ''
    const params: Array<string | number> = [canonicalJson(result), now(), id]
    if (lease) params.push(lease.owner, lease.attempt)
    const updated = this.db
      .prepare(`UPDATE capture_jobs SET status = 'active', result_json = ?, lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND ${stateFilter}${leaseFilter}`)
      .run(...params)
    return updated.changes > 0
  }

  failJob(id: string, errorCode: string, retryable: boolean, lease?: { owner: string; attempt: number }): boolean {
    const row = this.db.prepare('SELECT * FROM capture_jobs WHERE id = ?').get(id) as unknown as JobRow | undefined
    if (!row || row.status !== 'extracting' || !lease) return false
    if (row.lease_owner !== lease.owner || row.attempt !== lease.attempt) return false
    const leaseFilter = ' AND lease_owner = ? AND attempt = ?'
    const leaseParams: Array<string | number> = [lease.owner, lease.attempt]
    const maxAttempts = 5
    if (retryable && row.attempt < maxAttempts) {
      const delayMs = Math.min(60_000, 1000 * 2 ** row.attempt) * (0.7 + Math.random() * 0.6)
      const updated = this.db
        .prepare(`UPDATE capture_jobs SET status = 'retryable', error_code = ?, next_retry_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'extracting'${leaseFilter}`)
        .run(errorCode, new Date(Date.now() + delayMs).toISOString(), now(), id, ...leaseParams)
      return updated.changes > 0
    } else {
      const updated = this.db
        .prepare(`UPDATE capture_jobs SET status = ?, error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'extracting'${leaseFilter}`)
        .run(retryable ? 'quarantined' : 'rejected', errorCode, now(), id, ...leaseParams)
      return updated.changes > 0
    }
  }

  retryJob(id: string): boolean {
    const result = this.db
      .prepare("UPDATE capture_jobs SET status = 'retryable', next_retry_at = ?, error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('quarantined','rejected','retryable')")
      .run(now(), now(), id)
    return result.changes > 0
  }

  /**
   * Cancel a job that has not yet produced a memory. A job already `active`
   * (its record is written) cannot be cancelled: deleting the memory is the
   * governance action for that, not a queue operation.
   * @param id - job id.
   * @param actor - acting principal, recorded in the audit trail.
   * @returns whether the job moved to `cancelled`.
   */
  cancelJob(id: string, actor: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE capture_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
           next_retry_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('received','redacted','admitted','extracting','retryable','quarantined')`,
      )
      .run(now(), id)
    const changed = result.changes > 0
    this.audit(actor, 'job.cancel', id, changed ? 'allow' : 'deny', { changed })
    return changed
  }

  listJobs(statuses?: string[], limit = 50): JobRow[] {
    if (statuses && statuses.length > 0) {
      return this.db
        .prepare(`SELECT * FROM capture_jobs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`)
        .all(...statuses, limit) as unknown as JobRow[]
    }
    return this.db.prepare('SELECT * FROM capture_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as JobRow[]
  }

  jobStats(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM capture_jobs GROUP BY status').all() as Array<{ status: string; count: number }>
    return Object.fromEntries(rows.map(row => [row.status, row.count]))
  }

  /* ---------------------------------------------------------------- */
  /* Injection receipts and echo prevention                            */
  /* ---------------------------------------------------------------- */

  recordInjection(input: {
    sessionId: string
    turnId?: string
    principalId: string
    ids: string[]
    tokenCount: number
    reason: string
    elapsedMs: number
    cacheHit?: boolean
    aclRevision?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO injection_receipts(id, session_id, turn_id, principal_id, ids_json, token_count, reason, redaction_version, elapsed_ms, cache_hit, acl_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        input.sessionId,
        input.turnId ?? null,
        input.principalId,
        canonicalJson(input.ids),
        input.tokenCount,
        input.reason,
        input.elapsedMs,
        input.cacheHit ? 1 : 0,
        input.aclRevision ?? 0,
        now(),
      )
  }

  /**
   * True when text reproduces a memory id previously injected into this
   * session (anti-echo gate) or is structurally a recall payload.
   */
  wasInjected(sessionId: string, text: string): boolean {
    if (looksLikeEcho(text)) return true
    const rows = this.db
      .prepare('SELECT ids_json FROM injection_receipts WHERE session_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(sessionId) as Array<{ ids_json: string }>
    for (const row of rows) {
      const ids = JSON.parse(row.ids_json) as string[]
      if (ids.some(id => text.includes(id))) return true
    }
    return false
  }

  listInjections(sessionId?: string, limit = 50): Array<Record<string, unknown>> {
    if (sessionId) return this.db.prepare('SELECT * FROM injection_receipts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit) as Array<Record<string, unknown>>
    return this.db.prepare('SELECT * FROM injection_receipts ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  }

  recordUsage(input: { projectId?: string; sessionId?: string; agentId?: string; operation: string; tokenEst?: number; llmCostEst?: number | null; recallMs?: number; hitIds?: string[]; error?: string }): void {
    this.db
      .prepare(
        `INSERT INTO usage_metrics(id, timestamp, project_id, session_id, agent_id, operation, token_est, llm_cost_est, recall_ms, hit_ids, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        now(),
        input.projectId ?? null,
        input.sessionId ?? null,
        input.agentId ?? null,
        input.operation,
        input.tokenEst ?? 0,
        input.llmCostEst ?? null,
        input.recallMs ?? null,
        canonicalJson(input.hitIds ?? []),
        input.error ?? null,
      )
  }

  usageSummary(projectId: string, hours = 24): { recalls: number; injections: number; tokensIn: number; errors: number } {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    const usage = this.db
      .prepare(
        `SELECT operation, COUNT(*) AS count, COALESCE(SUM(token_est),0) AS tokens FROM usage_metrics
         WHERE project_id = ? AND timestamp >= ? GROUP BY operation`,
      )
      .all(projectId, since) as Array<{ operation: string; count: number; tokens: number }>
    // Keep tombstoned memory rows for historical attribution: deleting a memory
    // must not rewrite project usage already recorded in a receipt.
    const receipts = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(r.token_count),0) AS tokens FROM injection_receipts r
         WHERE r.created_at >= ? AND r.principal_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM json_each(r.ids_json) AS memory_ids
           JOIN memory_records mm ON mm.id = memory_ids.value
           WHERE mm.project_id = ?)`,
      )
      .get(since, projectId) as { count: number; tokens: number }
    const errors = this.db
      .prepare("SELECT COUNT(*) AS count FROM usage_metrics WHERE project_id = ? AND timestamp >= ? AND error IS NOT NULL")
      .get(projectId, since) as { count: number }
    const recalls = usage.find(item => item.operation === 'recall')?.count ?? 0
    return {
      recalls,
      injections: receipts.count,
      tokensIn: (usage.find(item => item.operation === 'injection')?.tokens ?? receipts.tokens) as number,
      errors: errors.count,
    }
  }

  /* ---------------------------------------------------------------- */
  /* Overview                                                          */
  /* ---------------------------------------------------------------- */

  overview(projectId: string, workspaceId?: string): Record<string, unknown> {
    const scope = workspaceId ? 'project_id = ? AND workspace_id = ?' : 'project_id = ?'
    const params = workspaceId ? [projectId, workspaceId] : [projectId]
    const counts = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM memory_records WHERE ${scope} AND tombstone = 0 GROUP BY status`)
      .all(...params) as Array<{ status: string; count: number }>
    const byStatus = Object.fromEntries(counts.map(row => [row.status, row.count]))
    const total = counts.reduce((sum, row) => sum + row.count, 0)
    const recent = this.db
      .prepare(`SELECT id, title, status, scene, scope, updated_at FROM memory_records WHERE ${scope} AND tombstone = 0 ORDER BY updated_at DESC LIMIT 5`)
      .all(...params) as Array<Record<string, unknown>>
    const jobs = this.jobStats()
    const failed = (jobs.quarantined ?? 0) + (jobs.rejected ?? 0)
    return {
      total,
      verified: byStatus.verified ?? 0,
      supported: byStatus.supported ?? 0,
      proposed: byStatus.proposed ?? 0,
      needsReview: byStatus.needs_review ?? 0,
      conflicted: byStatus.conflicted ?? 0,
      stale: byStatus.stale ?? 0,
      rejected: byStatus.rejected ?? 0,
      recent,
      jobs: { queued: (jobs.received ?? 0) + (jobs.retryable ?? 0), running: jobs.extracting ?? 0, failed, byStatus: jobs },
      usage: this.usageSummary(projectId),
      health: { backend: 'unknown' },
    }
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  getSettings(): { settings: PluginSettings; revision: number } {
    const row = this.db.prepare('SELECT value, revision FROM settings WHERE key = ?').get('plugin') as { value: string; revision: number }
    return { settings: PluginSettingsSchema.parse(JSON.parse(row.value)), revision: row.revision }
  }

  updateSettings(patch: Record<string, unknown>, expectedRevision: number, actor: string): { settings: PluginSettings; revision: number } {
    const current = this.getSettings()
    if (current.revision !== expectedRevision) {
      throw new HyMemoryError(ErrorCode.REVISION_MISMATCH, `expected settings revision ${expectedRevision}, found ${current.revision}`, 409)
    }
    const merged = PluginSettingsSchema.parse(deepMerge(current.settings as unknown as Record<string, unknown>, patch))
    const revision = current.revision + 1
    this.db.prepare('UPDATE settings SET value = ?, revision = ?, updated_at = ? WHERE key = ?').run(canonicalJson(merged), revision, now(), 'plugin')
    this.audit(actor, 'settings.update', 'plugin', 'allow', { revision })
    return { settings: merged, revision }
  }

  /* ---------------------------------------------------------------- */
  /* Audit                                                             */
  /* ---------------------------------------------------------------- */

  audit(actor: string, operation: string, target: string, outcome: string, detail: Record<string, unknown>): void {
    const previous = this.db.prepare('SELECT hash FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { hash: string } | undefined
    const createdAt = now()
    const payload = { actor, operation, target, outcome, detail, createdAt, prev: previous?.hash ?? '' }
    const hash = sha256(canonicalJson(payload))
    this.db
      .prepare('INSERT INTO audit_events(id, actor, operation, target, outcome, detail_json, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv7(), actor, operation, target, outcome, canonicalJson(detail), createdAt, previous?.hash ?? null, hash)
  }

  listAudit(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  }

  verifyAuditChain(): { valid: boolean; brokenAt?: string } {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY created_at ASC, rowid ASC').all() as Array<{
      id: string
      actor: string
      operation: string
      target: string
      outcome: string
      detail_json: string
      created_at: string
      prev_hash: string | null
      hash: string
    }>
    let previous: string | null = null
    for (const row of rows) {
      const expected = sha256(
        canonicalJson({
          actor: row.actor,
          operation: row.operation,
          target: row.target,
          outcome: row.outcome,
          detail: JSON.parse(row.detail_json),
          createdAt: row.created_at,
          prev: previous ?? '',
        }),
      )
      if (expected !== row.hash || (row.prev_hash ?? null) !== previous) return { valid: false, brokenAt: row.id }
      previous = row.hash
    }
    return { valid: true }
  }

  /* ---------------------------------------------------------------- */
  /* Export and backup                                                 */
  /* ---------------------------------------------------------------- */

  exportProject(projectId: string, redacted = true): Record<string, unknown> {
    const memories = this.db.prepare('SELECT * FROM memory_records WHERE project_id = ?').all(projectId) as unknown as MemoryRow[]
    const ids = memories.map(row => row.id)
    const evidence = ids.length
      ? (this.db
          .prepare(`SELECT e.* FROM evidence_items e JOIN memory_evidence me ON me.evidence_id = e.id WHERE me.memory_id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids) as unknown as EvidenceRow[])
      : []
    const versions = ids.length
      ? this.db.prepare(`SELECT * FROM memory_versions WHERE memory_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : []
    const claims = ids.length ? this.db.prepare(`SELECT * FROM memory_claims WHERE memory_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : []
    const bindings = ids.length ? this.db.prepare(`SELECT * FROM code_bindings WHERE memory_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : []
    const conflicts = this.db
      .prepare('SELECT * FROM conflict_cases WHERE left_memory_id IN (SELECT id FROM memory_records WHERE project_id = ?) OR right_memory_id IN (SELECT id FROM memory_records WHERE project_id = ?)')
      .all(projectId, projectId)
    const payload = { schemaVersion: 1, projectId, exportedAt: now(), memories, evidence, versions, claims, bindings, conflicts }
    if (!redacted) return payload
    return JSON.parse(redact(JSON.stringify(payload)).text) as Record<string, unknown>
  }

  backup(destination: string): { path: string; sha256: string; bytes: number } {
    if (this.dbPath === ':memory:') throw new HyMemoryError(ErrorCode.VALIDATION, 'in-memory databases cannot be backed up', 400)
    mkdirSync(dirname(destination), { recursive: true })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(this.dbPath, destination)
    const bytes = statSync(destination).size
    return { path: destination, sha256: sha256(readFileSync(destination)), bytes }
  }

  /** Read-only verification of a backup file before restore. */
  static inspectBackup(path: string): { ok: boolean; schemaVersion?: number; memories?: number; reasons: string[] } {
    if (!existsSync(path)) return { ok: false, reasons: ['file missing'] }
    let db: DatabaseSync | undefined
    try {
      db = openDatabase({ path, seedSettings: false })
      const migration = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }
      const count = db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }
      return { ok: true, schemaVersion: migration.version ?? 0, memories: count.count, reasons: [] }
    } catch (error) {
      return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] }
    } finally {
      db?.close()
    }
  }

  /** Token estimate helper re-exported for callers building clue budgets. */
  estimate(text: string): number {
    return estimateTokens(text)
  }
}

export { anchorClaim, claimsConflict, deriveClaim, isFactualGuidance, needsUnverifiedLabel } from './evidence.js'
export { redact, redactValue, detectPromptInjection, isSecretPath, REDACTION_VERSION } from './redact.js'
export type { AnchorInput, AnchorResult, ClaimParts } from './evidence.js'
export type { RedactionFinding, RedactionResult } from './redact.js'
export { openDatabase, transaction, memoryContentHash, SCHEMA_VERSION } from './db.js'



