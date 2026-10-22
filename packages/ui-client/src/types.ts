/**
 * Studio view models.
 *
 * The vocabulary (statuses, scenes, kinds, scopes, trust levels, job states,
 * conflict states, settings shape) mirrors `packages/contracts/src/index.ts`.
 * It is duplicated here — deliberately, as types only — because that module
 * imports `node:crypto` and must never be pulled into the browser bundle.
 *
 * Host DTOs (overview, agents, diagnostics, ...) are the shapes the Studio SPA
 * consumes from `docs/internal/API_CONTRACT.md` §2. Every field that the Host
 * may omit is optional: the UI renders an explicit `unknown` / `Unverifiable`
 * state instead of inventing a value.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary (mirrors contracts)                                      */
/* ------------------------------------------------------------------ */

export const MEMORY_STATUSES = [
  'proposed',
  'needs_review',
  'supported',
  'verified',
  'conflicted',
  'stale',
  'superseded',
  'rejected',
  'deleted',
] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const SCENES = ['chat', 'working', 'coding'] as const
export type Scene = (typeof SCENES)[number]

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'experience', 'failure', 'todo', 'hypothesis'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const MEMORY_SCOPES = ['private', 'agent', 'workspace', 'project', 'shared'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const SENSITIVITIES = ['public', 'internal', 'secret'] as const
export type Sensitivity = (typeof SENSITIVITIES)[number]

export const EVIDENCE_TRUST = [
  'user_explicit',
  'tool_observed',
  'repository_observed',
  'test_verified',
  'external_cited',
  'model_generated',
] as const
export type EvidenceTrust = (typeof EVIDENCE_TRUST)[number]

export const EVIDENCE_TYPES = [
  'user_message',
  'assistant_message',
  'tool_result',
  'test_result',
  'git_commit',
  'git_diff',
  'file_content',
  'external_doc',
  'model_claim',
] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

export const GRANT_ACTIONS = ['read', 'propose', 'review', 'feedback', 'delete', 'admin'] as const
export type GrantAction = (typeof GRANT_ACTIONS)[number]

export const JOB_STATUSES = [
  'received',
  'redacted',
  'admitted',
  'extracting',
  'validating',
  'indexed',
  'active',
  'retryable',
  'quarantined',
  'rejected',
  'cancelled',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const CONFLICT_STATES = [
  'open',
  'resolved_keep_both',
  'resolved_supersede',
  'resolved_reject',
  'unresolved',
  'dismissed',
] as const
export type ConflictState = (typeof CONFLICT_STATES)[number]

export const CONFLICT_RESOLUTIONS = ['keep_both', 'supersede', 'reject', 'request_verification', 'leave_unresolved'] as const
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number]

export const SEARCH_MODES = ['hybrid', 'keyword', 'semantic'] as const
export type SearchMode = (typeof SEARCH_MODES)[number]

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

/** A point in a sparkline series. `value` may be absent when the Host did not report it. */
export interface TrendPoint {
  at: string
  value: number
}

export interface ProjectWorkspace {
  id: string
  name?: string
  rootAlias?: string
  repoFingerprint?: string
  remote?: string
}

export interface Project {
  id: string
  name?: string
  workspaces: ProjectWorkspace[]
}

/** Envelope used by every Host list endpoint. */
export interface Page<T> {
  items: T[]
  total?: number
  page?: number
  pageSize?: number
}

/* ------------------------------------------------------------------ */
/* Health / studio config                                              */
/* ------------------------------------------------------------------ */

export interface EngineHealth {
  ok?: boolean
  engine?: string
  engineVersion?: string
  degraded?: boolean
  reason?: string | null
  queueDepth?: number
  mode?: string
}

export interface HealthResponse {
  ok: boolean
  plugin?: { version?: string; enabled?: boolean; dataDir?: string }
  worker?: EngineHealth
  db?: { ok?: boolean; schemaVersion?: number; path?: string }
  ui?: { version?: string; port?: number }
  degraded?: boolean
  reason?: string | null
  checkedAt?: string
}

export interface StudioConfig {
  locale?: 'en' | 'zh-CN'
  theme?: 'light' | 'dark' | 'system'
  capabilities?: {
    canCancelJobs?: boolean
    canBackup?: boolean
    canExport?: boolean
    benchmarkUrl?: string
    logDownloadUrl?: string
  }
}

/* ------------------------------------------------------------------ */
/* Memories                                                            */
/* ------------------------------------------------------------------ */

/** One row of `GET /api/memories`. */
export interface MemorySummary {
  id: string
  title: string
  /** Two-line excerpt source; falls back to `content` when the Host sends the full record. */
  excerpt?: string
  content?: string
  status: MemoryStatus
  scope: MemoryScope
  scene?: Scene
  kind?: MemoryKind
  sensitivity?: Sensitivity
  projectId?: string
  workspaceId?: string
  agentId?: string
  evidenceCount?: number
  version?: number
  revision: number
  updatedAt: string
  createdAt?: string
  confidenceCalibration?: number
}

export interface Claim {
  id?: string
  memoryId?: string
  subject: string
  predicate: string
  object: string
  polarity?: 'affirm' | 'negate' | 'unknown'
  qualifiers?: Record<string, string>
  validFrom?: string
  validUntil?: string
}

export interface EvidenceItem {
  id: string
  sourceEventId?: string
  type: EvidenceType | string
  uri?: string
  sha256: string
  trustLevel: EvidenceTrust | string
  revision?: number
  verifiedAt?: string
  retentionDays?: number
  excerpt?: string
  createdAt: string
}

export interface MemoryVersion {
  version: number
  status?: MemoryStatus
  title?: string
  createdAt: string
  revision?: number
  authorPrincipalId?: string
  note?: string
  /** Set when this version was produced by a revert, so the UI can badge it. */
  revertedFrom?: number | null
  revertOf?: number | null
}

export interface CodeBinding {
  id: string
  memoryId?: string
  workspaceId?: string
  branch?: string
  baseCommit?: string
  headCommit?: string
  filePath?: string
  symbol?: string
  signatureHash?: string
  patchHash?: string
  createdAt: string
}

export interface Validation {
  id?: string
  memoryId?: string
  kind?: string
  passed?: boolean
  detail?: string
  createdAt?: string
}

export interface MemoryDetail {
  memory: MemorySummary & { content: string; evidenceIds?: string[] }
  claims: Claim[]
  evidence: EvidenceItem[]
  versions: MemoryVersion[]
  bindings: CodeBinding[]
  validations: Validation[]
}

export interface MemoryQuery {
  projectId?: string
  workspaceId?: string
  status?: MemoryStatus | ''
  scene?: Scene | ''
  kind?: MemoryKind | ''
  scope?: MemoryScope | ''
  /** Additive query parameter; the Host may ignore it. */
  mode?: SearchMode
  q?: string
  agentId?: string
  page?: number
  pageSize?: number
}

export interface TransitionInput {
  to: MemoryStatus
  reason: string
  expectedRevision: number
}

export interface FeedbackInput {
  kind: 'useful' | 'incorrect' | 'stale'
  note?: string
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export interface OverviewCounts {
  total?: number
  verified?: number
  needsReview?: number
  proposed?: number
  supported?: number
  conflicted?: number
  stale?: number
  superseded?: number
  rejected?: number
  deleted?: number
}

export interface OverviewUsage {
  recallCount24h?: number
  injectedTokens24h?: number
  skippedQueries24h?: number
  errors24h?: number
  timeouts24h?: number
}

export interface OverviewTrend {
  retrieval: TrendPoint[]
  capture: TrendPoint[]
}

export interface JobSummary {
  byStatus: Partial<Record<JobStatus | string, number>>
  total?: number
  failed24h?: number
  oldestQueuedAt?: string
}

export interface OverviewResponse {
  counts: OverviewCounts
  health: { stale?: number; conflicted?: number; errors?: number }
  usage: OverviewUsage
  trend: OverviewTrend
  recent: MemorySummary[]
  jobs: JobSummary
}

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

export interface ConflictClaimSide {
  memoryId: string
  title?: string
  claim?: Claim
  status?: MemoryStatus
  qualifiers?: Record<string, string>
  evidenceCount?: number
  updatedAt?: string
}

export interface ConflictCase {
  id: string
  state: ConflictState
  projectId?: string
  older: ConflictClaimSide
  newer: ConflictClaimSide
  createdAt?: string
  resolvedAt?: string
  resolution?: ConflictResolution
  reason?: string
  /** Free-form note the Host may attach describing the detected clash. */
  detail?: string
}

export interface ConflictResolveInput {
  resolution: ConflictResolution
  reason: string
}

export interface ConflictResolveResult {
  conflict?: ConflictCase
  /** Host-projected state after resolution, when it chooses to send one. */
  result?: {
    olderStatus?: MemoryStatus
    newerStatus?: MemoryStatus
    state?: ConflictState
    auditEventId?: string
  }
}

/* ------------------------------------------------------------------ */
/* Agents and grants                                                   */
/* ------------------------------------------------------------------ */

export interface AgentSummary {
  id: string
  name?: string
  kind?: 'user' | 'agent' | 'service' | 'subagent'
  role?: 'owner' | 'main' | 'subagent' | 'service'
  ownerId?: string
  parentAgentId?: string
  projectId?: string
  workspaceId?: string
  lastRecallAt?: string
  lastDenialReason?: string
  lastDenialAt?: string
  sessionCount?: number
  grantCount?: number
}

export interface Grant {
  id: string
  subjectId: string
  objectScope: string
  action: GrantAction
  projectId?: string
  workspaceId?: string
  expiresAt?: string | null
  issuer?: string
  revision?: number
  createdAt?: string
  revokedAt?: string | null
}

export interface GrantInput {
  subjectId: string
  objectScope: string
  action: GrantAction
  expiresAt?: string
}

/* ------------------------------------------------------------------ */
/* Capture jobs                                                        */
/* ------------------------------------------------------------------ */

export interface CaptureJob {
  id: string
  status: JobStatus | string
  attempt?: number
  nextRetryAt?: string | null
  errorCode?: string | null
  createdAt?: string
  updatedAt?: string
  scene?: Scene
  sourceKey?: string
  payloadBytes?: number
}

export interface JobsResponse {
  items: CaptureJob[]
  total?: number
  byStatus?: Partial<Record<string, number>>
}

/** Capture queue columns required by the UI. */
export const JOB_QUEUE_COLUMNS = ['queued', 'running', 'retrying', 'quarantined', 'done'] as const
export type JobQueueColumn = (typeof JOB_QUEUE_COLUMNS)[number]

/* ------------------------------------------------------------------ */
/* Usage and quality                                                   */
/* ------------------------------------------------------------------ */

export interface AgentUsage {
  agentId: string
  name?: string
  recallCount?: number
  injectedTokens?: number
  skippedQueries?: number
  errors?: number
}

export interface QualityMetrics {
  /** Any of these may be missing; the UI shows `unknown` for absent values. */
  verifiedRatio?: number
  staleRatio?: number
  conflictRate?: number
  evidenceCoverage?: number
  retrievalPrecision?: number
  feedbackUseful?: number
  feedbackIncorrect?: number
  feedbackStale?: number
}

export interface CostEstimate {
  estimatedUsd?: number | null
  ratePer1kTokensUsd?: number | null
  /** False when the Host has no configured rate; the UI then prints `unknown`. */
  rateKnown?: boolean
}

export interface UsageResponse {
  recallCount?: number
  injectedTokens?: number
  skippedQueries?: number
  errors?: number
  timeouts?: number
  cacheHitRate?: number
  perAgent: AgentUsage[]
  quality: QualityMetrics
  cost: CostEstimate
  benchmarkUrl?: string
  windowHours?: number
}

/* ------------------------------------------------------------------ */
/* Settings (mirrors contracts PluginSettings)                         */
/* ------------------------------------------------------------------ */

export interface RecallSettings {
  enabled: boolean
  mode: 'clue-first' | 'tool-only'
  trigger: 'task-boundary' | 'every-step'
  candidateLimit: number
  clueLimit: number
  maxInjectionTokens: number
  maxSingleClueTokens: number
  searchTimeoutMs: number
  cacheTtlSeconds: number
  allowUnverifiedAsFact: boolean
  staleGuidance: 'clue-only' | 'hide'
  skipStaleTechFacts: boolean
  fallback: 'no-memory'
}

export interface CaptureSettings {
  enabled: boolean
  enableChat: boolean
  enableWorking: boolean
  enableCoding: boolean
  async: boolean
  autoCapture: boolean
  historicalImport: boolean
  secretScrubbing: 'strict' | 'off'
  evidenceRetentionDays: number
  rawTracePolicy: 'metadata-only' | 'redacted-excerpt'
  excludeToolOutputOverKb: number
  persistRawToolOutput: boolean
  offlineQueueMaxMib: number
  maxWriteCostPerDayUsd: number
  maxBatchEvents: number
}

export interface ModelSettings {
  mode: 'pro' | 'ultra' | 'lite'
  extractionEndpointEnv: string
  embeddingEndpointEnv: string
  externalEgress: 'ask-first' | 'deny' | 'allow-configured'
  localOnly: boolean
}

export interface SecuritySettings {
  denyCrossProjectByDefault: boolean
  keyStorage: 'os-keyring-or-0600-env'
  auditLog: boolean
  exportConfirmation: boolean
  autoPromoteModelClaims: false
}

export interface UiSettings {
  enabled: boolean
  locale: 'en' | 'zh-CN'
  followHostTheme: boolean
  port: number
  /** Never rendered: the UI only reports whether a token is configured. */
  token?: string
}

export interface AgentSettings {
  defaultScope: MemoryScope
  sharedMemory: 'explicit-grants-only'
  concurrency: number
  mergePolicy: 'optimistic-revision'
}

export interface PluginSettings {
  version: number
  enabled: boolean
  backend: 'sdk' | 'memhub'
  dataDir: string
  safeMode: boolean
  profileScope: 'current' | 'isolated' | 'all'
  models: ModelSettings
  capture: CaptureSettings
  recall: RecallSettings
  security: SecuritySettings
  ui: UiSettings
  agents: AgentSettings
}

export interface SettingsResponse {
  settings: PluginSettings
  revision: number
}

export interface SettingsSaveInput {
  patch: Record<string, unknown>
  expectedRevision: number
}

/* ------------------------------------------------------------------ */
/* Diagnostics / audit                                                 */
/* ------------------------------------------------------------------ */

export interface DependencyCheck {
  name: string
  ok: boolean
  version?: string
  detail?: string
  required?: boolean
}

export interface AuditChainStatus {
  ok?: boolean
  length?: number
  headHash?: string
  verifiedAt?: string
  brokenAt?: string | null
}

export interface PermissionMatrixRow {
  role: string
  scopes: string[]
  actions: GrantAction[]
}

export interface DiagnosticsResponse {
  versions: {
    dsh?: string
    plugin?: string
    worker?: string
    ui?: string
    profile?: string
    node?: string
    python?: string
  }
  dependencies: DependencyCheck[]
  paths: {
    dataDir?: string
    db?: string
    logs?: string
    artifacts?: string
    backup?: string
  }
  audit: AuditChainStatus
  permissionMatrix?: PermissionMatrixRow[]
  logDownloadUrl?: string
  profileName?: string
  worker?: EngineHealth
}

export interface AuditEvent {
  id: string
  at: string
  actor?: string
  action: string
  objectType?: string
  objectId?: string
  outcome?: string
  detail?: string
}

/* ------------------------------------------------------------------ */
/* Code bindings (Evidence & Versions page)                            */
/* ------------------------------------------------------------------ */

export interface PatchFile {
  path: string
  patch: string
}

export interface TestResult {
  id?: string
  commit?: string
  exitCode?: number | null
  environment?: string
  command?: string
  ranAt?: string
  passed?: boolean
  suite?: string
}

export interface CodeFreshness {
  stale?: boolean
  reason?: string
  checkedAt?: string
  headCommit?: string
  baseCommit?: string
  dirty?: boolean
}

export interface CodeResponse {
  bindings: CodeBinding[]
  diffs: PatchFile[]
  tests: TestResult[]
  freshness?: CodeFreshness
  /** Host-computed diff-chain verification; absent means the UI reports Unverifiable. */
  patchHashes?: Array<{ baseCommit?: string; headCommit?: string; patchHash?: string }>
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

export interface BackupResult {
  path: string
  sha256: string
  bytes?: number
  createdAt?: string
}
