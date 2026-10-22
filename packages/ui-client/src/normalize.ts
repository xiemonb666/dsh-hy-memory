/**
 * Tolerant normalizers for Host Studio API payloads.
 *
 * The Host is the only producer, but its DTOs carry optional fields (a count the
 * Host could not compute, a version it does not know, a binding without a diff).
 * These helpers keep the UI honest: a missing value stays `undefined` so the
 * renderer can show `unknown` / `Unverifiable` instead of a fabricated number.
 */
import type {
  AgentSummary,
  AgentUsage,
  AuditChainStatus,
  AuditEvent,
  CaptureJob,
  Claim,
  CodeBinding,
  CodeFreshness,
  CodeResponse,
  ConflictCase,
  ConflictClaimSide,
  ConflictState,
  DiagnosticsResponse,
  DependencyCheck,
  EngineHealth,
  EvidenceItem,
  Grant,
  HealthResponse,
  JobSummary,
  MemoryDetail,
  MemorySummary,
  MemoryVersion,
  OverviewResponse,
  Page,
  PatchFile,
  PermissionMatrixRow,
  Project,
  QualityMetrics,
  SettingsResponse,
  StudioConfig,
  TestResult,
  UsageResponse,
  Validation,
} from './types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function int(value: unknown): number | undefined {
  const n = num(value)
  return n === undefined ? undefined : Math.trunc(n)
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function strMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Accepts either `{ items, total }`, `{ results }`, or a bare array. */
export function pageOf<T>(raw: unknown, map: (item: unknown) => T | null): Page<T> {
  const source = isRecord(raw) ? raw : {}
  const list = Array.isArray(raw) ? raw : arr(source.items ?? source.results ?? source.rows)
  const items: T[] = []
  for (const entry of list) {
    const mapped = map(entry)
    if (mapped) items.push(mapped)
  }
  return {
    items,
    ...(int(source.total) !== undefined ? { total: int(source.total) } : {}),
    ...(int(source.page) !== undefined ? { page: int(source.page) } : {}),
    ...(int(source.pageSize) !== undefined ? { pageSize: int(source.pageSize) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Health / config / projects                                          */
/* ------------------------------------------------------------------ */

function engineHealth(raw: unknown): EngineHealth {
  const value = record(raw)
  return {
    ...(bool(value.ok) !== undefined ? { ok: bool(value.ok) } : {}),
    ...(str(value.engine) ? { engine: str(value.engine) } : {}),
    ...(str(value.engineVersion) ? { engineVersion: str(value.engineVersion) } : {}),
    ...(bool(value.degraded) !== undefined ? { degraded: bool(value.degraded) } : {}),
    ...(value.reason === null || typeof value.reason === 'string' ? { reason: value.reason as string | null } : {}),
    ...(int(value.queueDepth) !== undefined ? { queueDepth: int(value.queueDepth) } : {}),
    ...(str(value.mode) ? { mode: str(value.mode) } : {}),
  }
}

export function health(raw: unknown): HealthResponse {
  const value = record(raw)
  const plugin = record(value.plugin)
  const db = record(value.db)
  const ui = record(value.ui)
  return {
    ok: bool(value.ok) ?? false,
    plugin: {
      ...(str(plugin.version) ? { version: str(plugin.version) } : {}),
      ...(bool(plugin.enabled) !== undefined ? { enabled: bool(plugin.enabled) } : {}),
      ...(str(plugin.dataDir) ? { dataDir: str(plugin.dataDir) } : {}),
    },
    worker: engineHealth(value.worker),
    db: {
      ...(bool(db.ok) !== undefined ? { ok: bool(db.ok) } : {}),
      ...(int(db.schemaVersion) !== undefined ? { schemaVersion: int(db.schemaVersion) } : {}),
      ...(str(db.path) ? { path: str(db.path) } : {}),
    },
    ui: {
      ...(str(ui.version) ? { version: str(ui.version) } : {}),
      ...(int(ui.port) !== undefined ? { port: int(ui.port) } : {}),
    },
    ...(bool(value.degraded) !== undefined ? { degraded: bool(value.degraded) } : {}),
    ...(value.reason === null || typeof value.reason === 'string' ? { reason: value.reason as string | null } : {}),
    ...(str(value.checkedAt) ? { checkedAt: str(value.checkedAt) } : {}),
  }
}

export function studioConfig(raw: unknown): StudioConfig {
  const value = record(raw)
  const capabilities = record(value.capabilities)
  return {
    ...(value.locale === 'en' || value.locale === 'zh-CN' ? { locale: value.locale } : {}),
    ...(value.theme === 'light' || value.theme === 'dark' || value.theme === 'system' ? { theme: value.theme } : {}),
    capabilities: {
      ...(bool(capabilities.canCancelJobs) !== undefined ? { canCancelJobs: bool(capabilities.canCancelJobs) } : {}),
      ...(bool(capabilities.canBackup) !== undefined ? { canBackup: bool(capabilities.canBackup) } : {}),
      ...(bool(capabilities.canExport) !== undefined ? { canExport: bool(capabilities.canExport) } : {}),
      ...(str(capabilities.benchmarkUrl) ? { benchmarkUrl: str(capabilities.benchmarkUrl) } : {}),
      ...(str(capabilities.logDownloadUrl) ? { logDownloadUrl: str(capabilities.logDownloadUrl) } : {}),
    },
  }
}

export function projects(raw: unknown): Project[] {
  return pageOf(raw, entry => {
    const value = record(entry)
    const id = str(value.id)
    if (!id) return null
    return {
      id,
      ...(str(value.name) ? { name: str(value.name) } : {}),
      workspaces: arr(value.workspaces).map(workspace => {
        const item = record(workspace)
        return {
          id: str(item.id) ?? '',
          ...(str(item.name) ? { name: str(item.name) } : {}),
          ...(str(item.rootAlias) ? { rootAlias: str(item.rootAlias) } : {}),
          ...(str(item.repoFingerprint) ? { repoFingerprint: str(item.repoFingerprint) } : {}),
          ...(str(item.remote) ? { remote: str(item.remote) } : {}),
        }
      }).filter(workspace => workspace.id !== ''),
    }
  }).items
}

/* ------------------------------------------------------------------ */
/* Memories                                                            */
/* ------------------------------------------------------------------ */

export function memorySummary(raw: unknown): MemorySummary | null {
  const value = record(raw)
  const id = str(value.id)
  const updatedAt = str(value.updatedAt) ?? str(value.updated_at)
  if (!id || !updatedAt) return null
  const status = str(value.status)
  const scope = str(value.scope)
  return {
    id,
    title: str(value.title) ?? str(value.name) ?? id,
    ...(str(value.excerpt) ? { excerpt: str(value.excerpt) } : {}),
    ...(str(value.content) ? { content: str(value.content) } : {}),
    status: (status ?? 'proposed') as MemorySummary['status'],
    scope: (scope ?? 'project') as MemorySummary['scope'],
    ...(str(value.scene) ? { scene: str(value.scene) as MemorySummary['scene'] } : {}),
    ...(str(value.kind) ? { kind: str(value.kind) as MemorySummary['kind'] } : {}),
    ...(str(value.sensitivity) ? { sensitivity: str(value.sensitivity) as MemorySummary['sensitivity'] } : {}),
    ...(str(value.projectId) ? { projectId: str(value.projectId) } : {}),
    ...(str(value.workspaceId) ? { workspaceId: str(value.workspaceId) } : {}),
    ...(str(value.agentId) ? { agentId: str(value.agentId) } : {}),
    ...(int(value.evidenceCount) !== undefined
      ? { evidenceCount: int(value.evidenceCount) }
      : Array.isArray(value.evidenceIds)
        ? { evidenceCount: value.evidenceIds.length }
        : {}),
    ...(int(value.version) !== undefined ? { version: int(value.version) } : {}),
    revision: int(value.revision) ?? 0,
    updatedAt,
    ...(str(value.createdAt) ? { createdAt: str(value.createdAt) } : {}),
    ...(num(value.confidenceCalibration) !== undefined
      ? { confidenceCalibration: num(value.confidenceCalibration) }
      : {}),
  }
}

function claim(raw: unknown): Claim | null {
  const value = record(raw)
  const subject = str(value.subject)
  const predicate = str(value.predicate)
  if (!subject || !predicate) return null
  return {
    ...(str(value.id) ? { id: str(value.id) } : {}),
    ...(str(value.memoryId) ? { memoryId: str(value.memoryId) } : {}),
    subject,
    predicate,
    object: str(value.object) ?? '',
    ...(value.polarity === 'affirm' || value.polarity === 'negate' || value.polarity === 'unknown'
      ? { polarity: value.polarity }
      : {}),
    ...(strMap(value.qualifiers) ? { qualifiers: strMap(value.qualifiers) } : {}),
    ...(str(value.validFrom) ? { validFrom: str(value.validFrom) } : {}),
    ...(str(value.validUntil) ? { validUntil: str(value.validUntil) } : {}),
  }
}

function evidence(raw: unknown): EvidenceItem | null {
  const value = record(raw)
  const id = str(value.id)
  if (!id) return null
  return {
    id,
    ...(str(value.sourceEventId) ? { sourceEventId: str(value.sourceEventId) } : {}),
    type: str(value.type) ?? 'unknown',
    ...(str(value.uri) ? { uri: str(value.uri) } : {}),
    sha256: str(value.sha256) ?? '',
    trustLevel: str(value.trustLevel) ?? 'unknown',
    ...(int(value.revision) !== undefined ? { revision: int(value.revision) } : {}),
    ...(str(value.verifiedAt) ? { verifiedAt: str(value.verifiedAt) } : {}),
    ...(int(value.retentionDays) !== undefined ? { retentionDays: int(value.retentionDays) } : {}),
    ...(str(value.excerpt) ? { excerpt: str(value.excerpt) } : {}),
    createdAt: str(value.createdAt) ?? '',
  }
}

function version(raw: unknown): MemoryVersion | null {
  const value = record(raw)
  const v = int(value.version)
  if (v === undefined) return null
  return {
    version: v,
    ...(str(value.status) ? { status: str(value.status) as MemoryVersion['status'] } : {}),
    ...(str(value.title) ? { title: str(value.title) } : {}),
    createdAt: str(value.createdAt) ?? '',
    ...(int(value.revision) !== undefined ? { revision: int(value.revision) } : {}),
    ...(str(value.authorPrincipalId) ? { authorPrincipalId: str(value.authorPrincipalId) } : {}),
    ...(str(value.note) ? { note: str(value.note) } : {}),
    ...(value.revertedFrom === null ? { revertedFrom: null } : int(value.revertedFrom) !== undefined ? { revertedFrom: int(value.revertedFrom) } : {}),
    ...(value.revertOf === null ? { revertOf: null } : int(value.revertOf) !== undefined ? { revertOf: int(value.revertOf) } : {}),
  }
}

export function codeBinding(raw: unknown): CodeBinding | null {
  const value = record(raw)
  const id = str(value.id)
  if (!id) return null
  return {
    id,
    ...(str(value.memoryId) ? { memoryId: str(value.memoryId) } : {}),
    ...(str(value.workspaceId) ? { workspaceId: str(value.workspaceId) } : {}),
    ...(str(value.branch) ? { branch: str(value.branch) } : {}),
    ...(str(value.baseCommit) ? { baseCommit: str(value.baseCommit) } : {}),
    ...(str(value.headCommit) ? { headCommit: str(value.headCommit) } : {}),
    ...(str(value.filePath) ? { filePath: str(value.filePath) } : {}),
    ...(str(value.symbol) ? { symbol: str(value.symbol) } : {}),
    ...(str(value.signatureHash) ? { signatureHash: str(value.signatureHash) } : {}),
    ...(str(value.patchHash) ? { patchHash: str(value.patchHash) } : {}),
    createdAt: str(value.createdAt) ?? '',
  }
}

function validation(raw: unknown): Validation | null {
  const value = record(raw)
  if (!isRecord(raw)) return null
  return {
    ...(str(value.id) ? { id: str(value.id) } : {}),
    ...(str(value.memoryId) ? { memoryId: str(value.memoryId) } : {}),
    ...(str(value.kind) ? { kind: str(value.kind) } : {}),
    ...(bool(value.passed) !== undefined ? { passed: bool(value.passed) } : {}),
    ...(str(value.detail) ? { detail: str(value.detail) } : {}),
    ...(str(value.createdAt) ? { createdAt: str(value.createdAt) } : {}),
  }
}

export function memoryDetail(raw: unknown, fallbackId: string): MemoryDetail | null {
  const value = record(raw)
  const recordRaw = value.memory ?? value.record ?? raw
  const summary = memorySummary({ id: fallbackId, ...record(recordRaw) })
  if (!summary) return null
  return {
    memory: {
      ...summary,
      content: str(record(recordRaw).content) ?? summary.excerpt ?? '',
      ...(Array.isArray(record(recordRaw).evidenceIds)
        ? { evidenceIds: arr(record(recordRaw).evidenceIds).map(item => String(item)) }
        : {}),
    },
    claims: arr(value.claims).map(claim).filter((item): item is Claim => item !== null),
    evidence: arr(value.evidence).map(evidence).filter((item): item is EvidenceItem => item !== null),
    versions: arr(value.versions).map(version).filter((item): item is MemoryVersion => item !== null),
    bindings: arr(value.bindings).map(codeBinding).filter((item): item is CodeBinding => item !== null),
    validations: arr(value.validations).map(validation).filter((item): item is Validation => item !== null),
  }
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export function overview(raw: unknown): OverviewResponse {
  const value = record(raw)
  const counts = record(value.counts)
  const healthRaw = record(value.health)
  const usage = record(value.usage)
  const trend = record(value.trend)
  const jobs = record(value.jobs ?? value.jobSummary)

  const points = (input: unknown) =>
    arr(input)
      .map(entry => {
        if (Array.isArray(entry)) {
          const at = str(entry[0])
          const count = num(entry[1])
          return at && count !== undefined ? { at, value: count } : null
        }
        const item = record(entry)
        const at = str(item.at) ?? str(item.t)
        const count = num(item.value ?? item.count)
        return at && count !== undefined ? { at, value: count } : null
      })
      .filter((item): item is { at: string; value: number } => item !== null)

  const byStatus: JobSummary['byStatus'] = {}
  for (const [key, raw2] of Object.entries(record(jobs.byStatus))) {
    const count = int(raw2)
    if (count !== undefined) byStatus[key] = count
  }

  return {
    counts: {
      ...(int(counts.total) !== undefined ? { total: int(counts.total) } : {}),
      ...(int(counts.verified) !== undefined ? { verified: int(counts.verified) } : {}),
      ...(int(counts.needsReview) !== undefined ? { needsReview: int(counts.needsReview) } : {}),
      ...(int(counts.proposed) !== undefined ? { proposed: int(counts.proposed) } : {}),
      ...(int(counts.supported) !== undefined ? { supported: int(counts.supported) } : {}),
      ...(int(counts.conflicted) !== undefined ? { conflicted: int(counts.conflicted) } : {}),
      ...(int(counts.stale) !== undefined ? { stale: int(counts.stale) } : {}),
      ...(int(counts.superseded) !== undefined ? { superseded: int(counts.superseded) } : {}),
      ...(int(counts.rejected) !== undefined ? { rejected: int(counts.rejected) } : {}),
      ...(int(counts.deleted) !== undefined ? { deleted: int(counts.deleted) } : {}),
    },
    health: {
      ...(int(healthRaw.stale) !== undefined ? { stale: int(healthRaw.stale) } : {}),
      ...(int(healthRaw.conflicted) !== undefined ? { conflicted: int(healthRaw.conflicted) } : {}),
      ...(int(healthRaw.errors) !== undefined ? { errors: int(healthRaw.errors) } : {}),
    },
    usage: {
      ...(int(usage.recallCount24h) !== undefined ? { recallCount24h: int(usage.recallCount24h) } : {}),
      ...(int(usage.injectedTokens24h) !== undefined ? { injectedTokens24h: int(usage.injectedTokens24h) } : {}),
      ...(int(usage.skippedQueries24h) !== undefined ? { skippedQueries24h: int(usage.skippedQueries24h) } : {}),
      ...(int(usage.errors24h) !== undefined ? { errors24h: int(usage.errors24h) } : {}),
      ...(int(usage.timeouts24h) !== undefined ? { timeouts24h: int(usage.timeouts24h) } : {}),
    },
    trend: { retrieval: points(trend.retrieval), capture: points(trend.capture) },
    recent: arr(value.recent).map(memorySummary).filter((item): item is MemorySummary => item !== null),
    jobs: {
      byStatus,
      ...(int(jobs.total) !== undefined ? { total: int(jobs.total) } : {}),
      ...(int(jobs.failed24h) !== undefined ? { failed24h: int(jobs.failed24h) } : {}),
      ...(str(jobs.oldestQueuedAt) ? { oldestQueuedAt: str(jobs.oldestQueuedAt) } : {}),
    },
  }
}

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

function conflictSide(raw: unknown): ConflictClaimSide | null {
  const value = record(raw)
  const memoryId = str(value.memoryId) ?? str(value.id)
  if (!memoryId) return null
  const claimValue = claim(value.claim ?? value)
  return {
    memoryId,
    ...(str(value.title) ? { title: str(value.title) } : {}),
    ...(claimValue ? { claim: claimValue } : {}),
    ...(str(value.status) ? { status: str(value.status) as ConflictClaimSide['status'] } : {}),
    ...(strMap(value.qualifiers) ? { qualifiers: strMap(value.qualifiers) } : {}),
    ...(int(value.evidenceCount) !== undefined ? { evidenceCount: int(value.evidenceCount) } : {}),
    ...(str(value.updatedAt) ? { updatedAt: str(value.updatedAt) } : {}),
  }
}

export function conflict(raw: unknown): ConflictCase | null {
  const value = record(raw)
  const id = str(value.id)
  const older = conflictSide(value.older ?? value.olderClaim)
  const newer = conflictSide(value.newer ?? value.newerClaim)
  if (!id || !older || !newer) return null
  return {
    id,
    state: (str(value.state) ?? 'open') as ConflictState,
    ...(str(value.projectId) ? { projectId: str(value.projectId) } : {}),
    older,
    newer,
    ...(str(value.createdAt) ? { createdAt: str(value.createdAt) } : {}),
    ...(str(value.resolvedAt) ? { resolvedAt: str(value.resolvedAt) } : {}),
    ...(str(value.resolution) ? { resolution: str(value.resolution) as ConflictCase['resolution'] } : {}),
    ...(str(value.reason) ? { reason: str(value.reason) } : {}),
    ...(str(value.detail) ? { detail: str(value.detail) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Agents, grants                                                      */
/* ------------------------------------------------------------------ */

export function agent(raw: unknown): AgentSummary | null {
  const value = record(raw)
  const id = str(value.id) ?? str(value.agentId)
  if (!id) return null
  return {
    id,
    ...(str(value.name) ? { name: str(value.name) } : {}),
    ...(str(value.kind) ? { kind: str(value.kind) as AgentSummary['kind'] } : {}),
    ...(str(value.role) ? { role: str(value.role) as AgentSummary['role'] } : {}),
    ...(str(value.ownerId) ? { ownerId: str(value.ownerId) } : {}),
    ...(str(value.parentAgentId) ? { parentAgentId: str(value.parentAgentId) } : {}),
    ...(str(value.projectId) ? { projectId: str(value.projectId) } : {}),
    ...(str(value.workspaceId) ? { workspaceId: str(value.workspaceId) } : {}),
    ...(str(value.lastRecallAt) ? { lastRecallAt: str(value.lastRecallAt) } : {}),
    ...(str(value.lastDenialReason) ? { lastDenialReason: str(value.lastDenialReason) } : {}),
    ...(str(value.lastDenialAt) ? { lastDenialAt: str(value.lastDenialAt) } : {}),
    ...(int(value.sessionCount) !== undefined ? { sessionCount: int(value.sessionCount) } : {}),
    ...(int(value.grantCount) !== undefined ? { grantCount: int(value.grantCount) } : {}),
  }
}

export function grant(raw: unknown): Grant | null {
  const value = record(raw)
  const id = str(value.id)
  const subjectId = str(value.subjectId)
  if (!id || !subjectId) return null
  return {
    id,
    subjectId,
    objectScope: str(value.objectScope) ?? '',
    action: (str(value.action) ?? 'read') as Grant['action'],
    ...(str(value.projectId) ? { projectId: str(value.projectId) } : {}),
    ...(str(value.workspaceId) ? { workspaceId: str(value.workspaceId) } : {}),
    ...(value.expiresAt === null ? { expiresAt: null } : str(value.expiresAt) ? { expiresAt: str(value.expiresAt) } : {}),
    ...(str(value.issuer) ? { issuer: str(value.issuer) } : {}),
    ...(int(value.revision) !== undefined ? { revision: int(value.revision) } : {}),
    ...(str(value.createdAt) ? { createdAt: str(value.createdAt) } : {}),
    ...(value.revokedAt === null ? { revokedAt: null } : str(value.revokedAt) ? { revokedAt: str(value.revokedAt) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export function job(raw: unknown): CaptureJob | null {
  const value = record(raw)
  const id = str(value.id)
  const status = str(value.status)
  if (!id || !status) return null
  return {
    id,
    status,
    ...(int(value.attempt) !== undefined ? { attempt: int(value.attempt) } : {}),
    ...(value.nextRetryAt === null ? { nextRetryAt: null } : str(value.nextRetryAt) ? { nextRetryAt: str(value.nextRetryAt) } : {}),
    ...(value.errorCode === null ? { errorCode: null } : str(value.errorCode) ? { errorCode: str(value.errorCode) } : {}),
    ...(str(value.createdAt) ? { createdAt: str(value.createdAt) } : {}),
    ...(str(value.updatedAt) ? { updatedAt: str(value.updatedAt) } : {}),
    ...(str(value.scene) ? { scene: str(value.scene) as CaptureJob['scene'] } : {}),
    ...(str(value.sourceKey) ? { sourceKey: str(value.sourceKey) } : {}),
    ...(int(value.payloadBytes) !== undefined ? { payloadBytes: int(value.payloadBytes) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export function usage(raw: unknown): UsageResponse {
  const value = record(raw)
  const quality = record(value.quality)
  const cost = record(value.cost)
  const qualityMetrics: QualityMetrics = {
    ...(num(quality.verifiedRatio) !== undefined ? { verifiedRatio: num(quality.verifiedRatio) } : {}),
    ...(num(quality.staleRatio) !== undefined ? { staleRatio: num(quality.staleRatio) } : {}),
    ...(num(quality.conflictRate) !== undefined ? { conflictRate: num(quality.conflictRate) } : {}),
    ...(num(quality.evidenceCoverage) !== undefined ? { evidenceCoverage: num(quality.evidenceCoverage) } : {}),
    ...(num(quality.retrievalPrecision) !== undefined ? { retrievalPrecision: num(quality.retrievalPrecision) } : {}),
    ...(int(quality.feedbackUseful) !== undefined ? { feedbackUseful: int(quality.feedbackUseful) } : {}),
    ...(int(quality.feedbackIncorrect) !== undefined ? { feedbackIncorrect: int(quality.feedbackIncorrect) } : {}),
    ...(int(quality.feedbackStale) !== undefined ? { feedbackStale: int(quality.feedbackStale) } : {}),
  }
  const perAgent: AgentUsage[] = arr(value.perAgent)
    .map(entry => {
      const item = record(entry)
      const agentId = str(item.agentId) ?? str(item.id)
      if (!agentId) return null
      return {
        agentId,
        ...(str(item.name) ? { name: str(item.name) } : {}),
        ...(int(item.recallCount) !== undefined ? { recallCount: int(item.recallCount) } : {}),
        ...(int(item.injectedTokens) !== undefined ? { injectedTokens: int(item.injectedTokens) } : {}),
        ...(int(item.skippedQueries) !== undefined ? { skippedQueries: int(item.skippedQueries) } : {}),
        ...(int(item.errors) !== undefined ? { errors: int(item.errors) } : {}),
      }
    })
    .filter((item): item is AgentUsage => item !== null)

  return {
    ...(int(value.recallCount) !== undefined ? { recallCount: int(value.recallCount) } : {}),
    ...(int(value.injectedTokens) !== undefined ? { injectedTokens: int(value.injectedTokens) } : {}),
    ...(int(value.skippedQueries) !== undefined ? { skippedQueries: int(value.skippedQueries) } : {}),
    ...(int(value.errors) !== undefined ? { errors: int(value.errors) } : {}),
    ...(int(value.timeouts) !== undefined ? { timeouts: int(value.timeouts) } : {}),
    ...(num(value.cacheHitRate) !== undefined ? { cacheHitRate: num(value.cacheHitRate) } : {}),
    perAgent,
    quality: qualityMetrics,
    cost: {
      ...(num(cost.estimatedUsd) !== undefined ? { estimatedUsd: num(cost.estimatedUsd) } : {}),
      ...(num(cost.ratePer1kTokensUsd) !== undefined ? { ratePer1kTokensUsd: num(cost.ratePer1kTokensUsd) } : {}),
      ...(bool(cost.rateKnown) !== undefined ? { rateKnown: bool(cost.rateKnown) } : {}),
    },
    ...(str(value.benchmarkUrl) ? { benchmarkUrl: str(value.benchmarkUrl) } : {}),
    ...(int(value.windowHours) !== undefined ? { windowHours: int(value.windowHours) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function settings(raw: unknown): SettingsResponse {
  const value = record(raw)
  return {
    settings: (value.settings ?? {}) as SettingsResponse['settings'],
    revision: int(value.revision) ?? 0,
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

function dependency(raw: unknown): DependencyCheck | null {
  const value = record(raw)
  const name = str(value.name)
  if (!name) return null
  return {
    name,
    ok: bool(value.ok) ?? false,
    ...(str(value.version) ? { version: str(value.version) } : {}),
    ...(str(value.detail) ? { detail: str(value.detail) } : {}),
    ...(bool(value.required) !== undefined ? { required: bool(value.required) } : {}),
  }
}

export function diagnostics(raw: unknown): DiagnosticsResponse {
  const value = record(raw)
  const versions = record(value.versions)
  const paths = record(value.paths)
  const audit = record(value.audit)
  const auditChain: AuditChainStatus = {
    ...(bool(audit.ok) !== undefined ? { ok: bool(audit.ok) } : {}),
    ...(int(audit.length) !== undefined ? { length: int(audit.length) } : {}),
    ...(str(audit.headHash) ? { headHash: str(audit.headHash) } : {}),
    ...(str(audit.verifiedAt) ? { verifiedAt: str(audit.verifiedAt) } : {}),
    ...(audit.brokenAt === null ? { brokenAt: null } : str(audit.brokenAt) ? { brokenAt: str(audit.brokenAt) } : {}),
  }
  const permissionMatrix: PermissionMatrixRow[] = arr(value.permissionMatrix)
    .map(entry => {
      const item = record(entry)
      const role = str(item.role)
      if (!role) return null
      return {
        role,
        scopes: arr(item.scopes).map(scope => String(scope)),
        actions: arr(item.actions).map(action => String(action) as PermissionMatrixRow['actions'][number]),
      }
    })
    .filter((item): item is PermissionMatrixRow => item !== null)

  return {
    versions: {
      ...(str(versions.dsh) ? { dsh: str(versions.dsh) } : {}),
      ...(str(versions.plugin) ? { plugin: str(versions.plugin) } : {}),
      ...(str(versions.worker) ? { worker: str(versions.worker) } : {}),
      ...(str(versions.ui) ? { ui: str(versions.ui) } : {}),
      ...(str(versions.profile) ? { profile: str(versions.profile) } : {}),
      ...(str(versions.node) ? { node: str(versions.node) } : {}),
      ...(str(versions.python) ? { python: str(versions.python) } : {}),
    },
    dependencies: arr(value.dependencies).map(dependency).filter((item): item is DependencyCheck => item !== null),
    paths: {
      ...(str(paths.dataDir) ? { dataDir: str(paths.dataDir) } : {}),
      ...(str(paths.db) ? { db: str(paths.db) } : {}),
      ...(str(paths.logs) ? { logs: str(paths.logs) } : {}),
      ...(str(paths.artifacts) ? { artifacts: str(paths.artifacts) } : {}),
      ...(str(paths.backup) ? { backup: str(paths.backup) } : {}),
    },
    audit: auditChain,
    ...(permissionMatrix.length > 0 ? { permissionMatrix } : {}),
    ...(str(value.logDownloadUrl) ? { logDownloadUrl: str(value.logDownloadUrl) } : {}),
    ...(str(value.profileName) ? { profileName: str(value.profileName) } : {}),
    ...(isRecord(value.worker) ? { worker: engineHealth(value.worker) } : {}),
  }
}

export function auditEvent(raw: unknown): AuditEvent | null {
  const value = record(raw)
  const id = str(value.id)
  const action = str(value.action)
  if (!id || !action) return null
  return {
    id,
    at: str(value.at) ?? str(value.createdAt) ?? '',
    ...(str(value.actor) ? { actor: str(value.actor) } : {}),
    action,
    ...(str(value.objectType) ? { objectType: str(value.objectType) } : {}),
    ...(str(value.objectId) ? { objectId: str(value.objectId) } : {}),
    ...(str(value.outcome) ? { outcome: str(value.outcome) } : {}),
    ...(str(value.detail) ? { detail: str(value.detail) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Code bindings                                                       */
/* ------------------------------------------------------------------ */

export function code(raw: unknown): CodeResponse {
  const value = record(raw)
  const freshnessRaw = record(value.freshness)
  const diffs: PatchFile[] = arr(value.diffs ?? value.patch)
    .map(entry => {
      if (typeof entry === 'string') return { path: '', patch: entry }
      const item = record(entry)
      const patch = str(item.patch) ?? str(item.diff)
      if (!patch) return null
      return { path: str(item.path) ?? str(item.filePath) ?? '', patch }
    })
    .filter((item): item is PatchFile => item !== null)

  const tests: TestResult[] = arr(value.tests)
    .map(entry => {
      const item = record(entry)
      if (!isRecord(entry)) return null
      return {
        ...(str(item.id) ? { id: str(item.id) } : {}),
        ...(str(item.commit) ? { commit: str(item.commit) } : {}),
        ...(item.exitCode === null ? { exitCode: null } : int(item.exitCode) !== undefined ? { exitCode: int(item.exitCode) } : {}),
        ...(str(item.environment) ? { environment: str(item.environment) } : {}),
        ...(str(item.command) ? { command: str(item.command) } : {}),
        ...(str(item.ranAt) ? { ranAt: str(item.ranAt) } : {}),
        ...(bool(item.passed) !== undefined ? { passed: bool(item.passed) } : {}),
        ...(str(item.suite) ? { suite: str(item.suite) } : {}),
      }
    })
    .filter((item): item is TestResult => item !== null)

  const freshness: CodeFreshness = {
    ...(bool(freshnessRaw.stale) !== undefined ? { stale: bool(freshnessRaw.stale) } : {}),
    ...(str(freshnessRaw.reason) ? { reason: str(freshnessRaw.reason) } : {}),
    ...(str(freshnessRaw.checkedAt) ? { checkedAt: str(freshnessRaw.checkedAt) } : {}),
    ...(str(freshnessRaw.headCommit) ? { headCommit: str(freshnessRaw.headCommit) } : {}),
    ...(str(freshnessRaw.baseCommit) ? { baseCommit: str(freshnessRaw.baseCommit) } : {}),
    ...(bool(freshnessRaw.dirty) !== undefined ? { dirty: bool(freshnessRaw.dirty) } : {}),
  }

  const patchHashes = arr(value.patchHashes)
    .map(entry => {
      const item = record(entry)
      const patchHash = str(item.patchHash)
      if (!patchHash) return null
      return {
        ...(str(item.baseCommit) ? { baseCommit: str(item.baseCommit) } : {}),
        ...(str(item.headCommit) ? { headCommit: str(item.headCommit) } : {}),
        patchHash,
      }
    })
    .filter((item): item is { baseCommit?: string; headCommit?: string; patchHash: string } => item !== null)

  return {
    bindings: arr(value.bindings).map(codeBinding).filter((item): item is CodeBinding => item !== null),
    diffs,
    tests,
    ...(Object.keys(freshness).length > 0 ? { freshness } : {}),
    ...(patchHashes.length > 0 ? { patchHashes } : {}),
  }
}
