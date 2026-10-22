/**
 * Shared contracts for DSH HyMemory: status vocabulary, evidence trust levels,
 * capture envelopes, governance DTOs, settings, error codes and budget helpers.
 *
 * These are project-internal contracts (not upstream DeepSeek Harness types).
 * Every runtime boundary that accepts JSON validates with the schemas below.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const SCHEMA_VERSION = 1 as const
export const SOURCE_ID = 'dsh-hy-memory' as const

/* ------------------------------------------------------------------ */
/* Status and taxonomy                                                 */
/* ------------------------------------------------------------------ */

export const MemoryStatusSchema = z.enum([
  'proposed',
  'needs_review',
  'supported',
  'verified',
  'conflicted',
  'stale',
  'superseded',
  'rejected',
  'deleted',
])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

export const MEMORY_STATUSES = MemoryStatusSchema.options

/** Allowed state transitions. Anything absent is rejected by the state machine. */
export const ALLOWED_TRANSITIONS: Readonly<Record<MemoryStatus, readonly MemoryStatus[]>> = {
  proposed: ['needs_review', 'supported', 'rejected', 'deleted'],
  needs_review: ['supported', 'rejected', 'deleted', 'conflicted'],
  supported: ['verified', 'conflicted', 'superseded', 'stale', 'deleted'],
  verified: ['stale', 'conflicted', 'superseded', 'deleted'],
  conflicted: ['supported', 'verified', 'superseded', 'rejected', 'deleted'],
  stale: ['supported', 'superseded', 'deleted', 'verified'],
  superseded: ['deleted'],
  rejected: ['deleted'],
  deleted: [],
}

export const TERMINAL_STATUSES: readonly MemoryStatus[] = ['deleted', 'superseded', 'rejected']

export const SceneSchema = z.enum(['chat', 'working', 'coding'])
export type Scene = z.infer<typeof SceneSchema>

export const KindSchema = z.enum(['fact', 'preference', 'decision', 'experience', 'failure', 'todo', 'hypothesis'])
export type MemoryKind = z.infer<typeof KindSchema>

export const ScopeSchema = z.enum(['private', 'agent', 'workspace', 'project', 'shared'])
export type MemoryScope = z.infer<typeof ScopeSchema>

export const SensitivitySchema = z.enum(['public', 'internal', 'secret'])
export type Sensitivity = z.infer<typeof SensitivitySchema>

export const EvidenceTrustSchema = z.enum([
  'user_explicit',
  'tool_observed',
  'repository_observed',
  'test_verified',
  'external_cited',
  'model_generated',
])
export type EvidenceTrust = z.infer<typeof EvidenceTrustSchema>

/** Trust levels that may support a `verified` transition together with a validation record. */
export const VERIFYING_TRUST: readonly EvidenceTrust[] = ['test_verified', 'repository_observed', 'tool_observed']

export const EvidenceTypeSchema = z.enum([
  'user_message',
  'assistant_message',
  'tool_result',
  'test_result',
  'git_commit',
  'git_diff',
  'file_content',
  'external_doc',
  'model_claim',
])
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>

export const GrantActionSchema = z.enum(['read', 'propose', 'review', 'feedback', 'delete', 'admin'])
export type GrantAction = z.infer<typeof GrantActionSchema>

export const GRANT_ACTIONS = GrantActionSchema.options

export const PrincipalKindSchema = z.enum(['user', 'agent', 'service', 'subagent'])
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>

export const JobStatusSchema = z.enum([
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
])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const ConflictStateSchema = z.enum(['open', 'resolved_keep_both', 'resolved_supersede', 'resolved_reject', 'unresolved', 'dismissed'])
export type ConflictState = z.infer<typeof ConflictStateSchema>

/* ------------------------------------------------------------------ */
/* IDs and hashing                                                     */
/* ------------------------------------------------------------------ */

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Generate a UUIDv7 (time-ordered, 48-bit unix milliseconds + random tail).
 * Falls back to `crypto.randomUUID` only if the platform lacks random bytes.
 * @returns a UUIDv7 string.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  let ts = BigInt(now)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn)
    ts >>= 8n
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isUuid(value: string): boolean {
  return UUID7_RE.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function newId(prefix?: string): string {
  const id = uuidv7()
  return prefix ? `${prefix}_${id}` : id
}

/**
 * SHA-256 hex digest of a UTF-8 string or buffer.
 * @param input - text or bytes to hash.
 * @returns lowercase hex digest.
 */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Stable JSON stringification with sorted object keys, used for checksums and
 * idempotency keys. Arrays keep their order.
 * @param value - JSON-compatible value.
 * @returns canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/**
 * Deterministic source key for an event: session id + event sequence + payload hash.
 * @param parts - stable identity parts.
 * @returns hex idempotency key.
 */
export function sourceKey(...parts: Array<string | number>): string {
  return sha256(parts.join('\u0000'))
}

/* ------------------------------------------------------------------ */
/* Token budget                                                        */
/* ------------------------------------------------------------------ */

/**
 * Conservative token estimate used for hard budgets. ASCII runs are charged
 * at 1 token per 3 characters (a superset of common BPE rates), CJK and other
 * non-ASCII code points at 1 token each, and every message pays 4 tokens of
 * structural overhead. The estimate is deliberately an upper bound: exceeding
 * the budget is a hard failure, under-using it is acceptable.
 * @param text - text to measure.
 * @returns estimated token count (never negative).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++
    else wide++
  }
  return Math.ceil(ascii / 3) + wide
}

/**
 * Truncate text to a token budget while preserving the beginning and the end
 * (qualifiers often live at the end). Returns `''` when the budget is too small
 * to convey anything useful.
 * @param text - source text.
 * @param maxTokens - hard token ceiling.
 * @returns truncated text with an ellipsis marker when cut.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const marker = ' … '
  const markerTokens = estimateTokens(marker)
  if (maxTokens <= markerTokens + 2) return ''
  const budget = maxTokens - markerTokens
  const chars = [...text]
  let head = ''
  let tail = ''
  let headTokens = 0
  let tailTokens = 0
  for (const ch of chars) {
    const cost = ch.codePointAt(0)! < 0x80 ? 1 / 3 : 1
    if (headTokens + cost > budget * 0.65) break
    head += ch
    headTokens += cost
  }
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]!
    const cost = ch.codePointAt(0)! < 0x80 ? 1 / 3 : 1
    if (tailTokens + cost > budget * 0.35) break
    tail = ch + tail
    tailTokens += cost
  }
  return `${head}${marker}${tail}`
}

/* ------------------------------------------------------------------ */
/* Capture envelope                                                    */
/* ------------------------------------------------------------------ */

export const ToolOutcomeSchema = z.object({
  callId: z.string(),
  name: z.string(),
  exitCode: z.number().int().optional(),
  success: z.boolean().optional(),
  outputHash: z.string().optional(),
  outputExcerpt: z.string().max(2048).optional(),
  command: z.string().max(1024).optional(),
})
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>

export const CaptureMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.string(),
      }),
    )
    .optional(),
})
export type CaptureMessage = z.infer<typeof CaptureMessageSchema>

export const GitContextSchema = z.object({
  root: z.string(),
  branch: z.string().optional(),
  baseCommit: z.string().optional(),
  headCommit: z.string().optional(),
  dirty: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  remote: z.string().optional(),
  shallow: z.boolean().optional(),
})
export type GitContext = z.infer<typeof GitContextSchema>

export const CaptureEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKey: z.string().min(8),
  principalId: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  sceneCandidate: SceneSchema,
  userIntent: z.string().optional(),
  messages: z.array(CaptureMessageSchema).max(200),
  toolOutcomes: z.array(ToolOutcomeSchema).max(100),
  git: GitContextSchema.optional(),
  sourceEventIds: z.array(z.string()),
  observedAt: z.string(),
})
export type CaptureEnvelope = z.infer<typeof CaptureEnvelopeSchema>

/* ------------------------------------------------------------------ */
/* Memory records                                                      */
/* ------------------------------------------------------------------ */

export const MemoryRecordSchema = z.object({
  id: z.string(),
  engineId: z.string().optional(),
  version: z.number().int().positive(),
  scene: SceneSchema,
  kind: KindSchema,
  title: z.string(),
  content: z.string(),
  status: MemoryStatusSchema,
  scope: ScopeSchema,
  projectId: z.string(),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  authorPrincipalId: z.string(),
  evidenceIds: z.array(z.string()),
  sensitivity: SensitivitySchema,
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  codeBindingIds: z.array(z.string()).optional(),
  confidenceCalibration: z.number().min(0).max(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
})
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>

export const EvidenceItemSchema = z.object({
  id: z.string(),
  sourceEventId: z.string(),
  type: EvidenceTypeSchema,
  uri: z.string().optional(),
  sha256: z.string(),
  trustLevel: EvidenceTrustSchema,
  revision: z.number().int().nonnegative(),
  verifiedAt: z.string().optional(),
  retentionDays: z.number().int().positive().optional(),
  excerpt: z.string().optional(),
  createdAt: z.string(),
})
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>

export const ClaimSchema = z.object({
  id: z.string(),
  memoryId: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  polarity: z.enum(['affirm', 'negate', 'unknown']),
  qualifiers: z.record(z.string(), z.string()),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
})
export type Claim = z.infer<typeof ClaimSchema>

export const CodeBindingSchema = z.object({
  id: z.string(),
  memoryId: z.string(),
  workspaceId: z.string(),
  branch: z.string().optional(),
  baseCommit: z.string().optional(),
  headCommit: z.string().optional(),
  filePath: z.string().optional(),
  symbol: z.string().optional(),
  signatureHash: z.string().optional(),
  patchHash: z.string().optional(),
  createdAt: z.string(),
})
export type CodeBinding = z.infer<typeof CodeBindingSchema>

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

export const SearchModeSchema = z.enum(['hybrid', 'keyword', 'semantic'])
export type SearchMode = z.infer<typeof SearchModeSchema>

export const SearchQuerySchema = z.object({
  query: z.string().max(4000),
  mode: SearchModeSchema.default('hybrid'),
  scene: SceneSchema.optional(),
  projectId: z.string(),
  workspaceId: z.string().optional(),
  branch: z.string().optional(),
  agentId: z.string(),
  principalId: z.string(),
  sessionId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  includeStatuses: z.array(MemoryStatusSchema).optional(),
  semantic: z.boolean().default(true),
})
export type SearchQuery = z.infer<typeof SearchQuerySchema>

export const ClueSchema = z.object({
  memoryId: z.string(),
  title: z.string(),
  status: MemoryStatusSchema,
  scope: ScopeSchema,
  appliesTo: z.string(),
  evidenceCount: z.number().int().nonnegative(),
  text: z.string(),
  score: z.number(),
})
export type Clue = z.infer<typeof ClueSchema>

/* ------------------------------------------------------------------ */
/* Settings (persisted, revisioned)                                    */
/* ------------------------------------------------------------------ */

export const RecallSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['clue-first', 'tool-only']).default('clue-first'),
  trigger: z.enum(['task-boundary', 'every-step']).default('task-boundary'),
  candidateLimit: z.number().int().min(1).max(200).default(40),
  clueLimit: z.number().int().min(0).max(10).default(4),
  maxInjectionTokens: z.number().int().min(0).max(4000).default(600),
  maxSingleClueTokens: z.number().int().min(20).max(1000).default(150),
  searchTimeoutMs: z.number().int().min(50).max(30000).default(2500),
  cacheTtlSeconds: z.number().int().min(0).max(3600).default(180),
  allowUnverifiedAsFact: z.boolean().default(false),
  staleGuidance: z.enum(['clue-only', 'hide']).default('clue-only'),
  skipStaleTechFacts: z.boolean().default(true),
  fallback: z.enum(['no-memory']).default('no-memory'),
})
export type RecallSettings = z.infer<typeof RecallSettingsSchema>

export const CaptureSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  enableChat: z.boolean().default(true),
  enableWorking: z.boolean().default(true),
  enableCoding: z.boolean().default(true),
  async: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  historicalImport: z.boolean().default(false),
  secretScrubbing: z.enum(['strict', 'off']).default('strict'),
  evidenceRetentionDays: z.number().int().min(1).max(3650).default(90),
  rawTracePolicy: z.enum(['metadata-only', 'redacted-excerpt']).default('metadata-only'),
  excludeToolOutputOverKb: z.number().int().min(1).max(1024).default(32),
  persistRawToolOutput: z.boolean().default(false),
  offlineQueueMaxMib: z.number().int().min(1).max(4096).default(128),
  maxWriteCostPerDayUsd: z.number().min(0).max(1000).default(1),
  maxBatchEvents: z.number().int().min(1).max(500).default(60),
})
export type CaptureSettings = z.infer<typeof CaptureSettingsSchema>

export const ModelSettingsSchema = z.object({
  mode: z.enum(['pro', 'ultra', 'lite']).default('pro'),
  extractionEndpointEnv: z.string().default('MEMORY_LLM_BASE_URL'),
  embeddingEndpointEnv: z.string().default('MEMORY_EMBEDDER_BASE_URL'),
  externalEgress: z.enum(['ask-first', 'deny', 'allow-configured']).default('ask-first'),
  localOnly: z.boolean().default(true),
})
export type ModelSettings = z.infer<typeof ModelSettingsSchema>

export const SecuritySettingsSchema = z.object({
  denyCrossProjectByDefault: z.boolean().default(true),
  keyStorage: z.enum(['os-keyring-or-0600-env']).default('os-keyring-or-0600-env'),
  auditLog: z.boolean().default(true),
  exportConfirmation: z.boolean().default(true),
  autoPromoteModelClaims: z.literal(false).default(false),
})
export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>

const DEFAULT_MODELS: ModelSettings = ModelSettingsSchema.parse({})
const DEFAULT_CAPTURE: CaptureSettings = CaptureSettingsSchema.parse({})
const DEFAULT_RECALL: RecallSettings = RecallSettingsSchema.parse({})
const DEFAULT_SECURITY: SecuritySettings = SecuritySettingsSchema.parse({})
const DEFAULT_UI = { enabled: true, locale: 'zh-CN' as const, followHostTheme: true, port: 48731, token: '' }
const DEFAULT_AGENTS = { defaultScope: 'workspace' as const, sharedMemory: 'explicit-grants-only' as const, concurrency: 2, mergePolicy: 'optimistic-revision' as const }
export const PluginSettingsSchema = z.object({
  version: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  backend: z.enum(['sdk', 'memhub']).default('sdk'),
  dataDir: z.string().default(''),
  safeMode: z.boolean().default(true),
  profileScope: z.enum(['current', 'isolated', 'all']).default('current'),
  models: ModelSettingsSchema.default(DEFAULT_MODELS),
  capture: CaptureSettingsSchema.default(DEFAULT_CAPTURE),
  recall: RecallSettingsSchema.default(DEFAULT_RECALL),
  security: SecuritySettingsSchema.default(DEFAULT_SECURITY),
  ui: z
    .object({
      enabled: z.boolean().default(true),
      locale: z.enum(['en', 'zh-CN']).default('zh-CN'),
      followHostTheme: z.boolean().default(true),
      port: z.number().int().min(1024).max(65535).default(48731),
      token: z.string().default(''),
    })
    .default(DEFAULT_UI),
  agents: z
    .object({
      defaultScope: ScopeSchema.default('workspace'),
      sharedMemory: z.literal('explicit-grants-only').default('explicit-grants-only'),
      concurrency: z.number().int().min(1).max(16).default(2),
      mergePolicy: z.literal('optimistic-revision').default('optimistic-revision'),
    })
    .default(DEFAULT_AGENTS),
})
export type PluginSettings = z.infer<typeof PluginSettingsSchema>

export const DEFAULT_SETTINGS: PluginSettings = PluginSettingsSchema.parse({})

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export const ErrorCode = {
  UNAUTHORIZED: 'E_UNAUTHORIZED',
  FORBIDDEN: 'E_FORBIDDEN',
  NOT_FOUND: 'E_NOT_FOUND',
  CONFLICT: 'E_CONFLICT',
  VALIDATION: 'E_VALIDATION',
  RATE_LIMITED: 'E_RATE_LIMITED',
  BACKEND_UNAVAILABLE: 'E_BACKEND_UNAVAILABLE',
  BACKEND_TIMEOUT: 'E_BACKEND_TIMEOUT',
  SECRET_DETECTED: 'E_SECRET_DETECTED',
  INJECTION_SUSPECTED: 'E_INJECTION_SUSPECTED',
  ECHO_REJECTED: 'E_ECHO_REJECTED',
  STALE_EVIDENCE: 'E_STALE_EVIDENCE',
  REVISION_MISMATCH: 'E_REVISION_MISMATCH',
  BUDGET_EXCEEDED: 'E_BUDGET_EXCEEDED',
  NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
} as const
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export class HyMemoryError extends Error {
  readonly code: ErrorCodeValue
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCodeValue, message: string, status = 400, details?: Record<string, unknown>) {
    super(message)
    this.name = 'HyMemoryError'
    this.code = code
    this.status = status
    if (details) this.details = details
  }
}

/**
 * Structured JSON error body shared by the Host API and the Python worker.
 * @param error - thrown value to normalize.
 * @returns serializable error payload with a stable code.
 */
export function errorPayload(error: unknown): { error: { code: string; message: string; details?: Record<string, unknown> } } {
  if (error instanceof HyMemoryError) {
    return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
  }
  return { error: { code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) } }
}

/* ------------------------------------------------------------------ */
/* Prompt-injection / echo markers                                     */
/* ------------------------------------------------------------------ */

export const MEMORY_CONTEXT_OPEN = '<memory_clues'
export const MEMORY_CONTEXT_CLOSE = '</memory_clues>'

/**
 * Escape text for the data container used during injection. The container is
 * plain data: angle brackets, ampersands and backticks are entity-escaped and
 * instruction-like control characters are removed.
 * @param text - untrusted memory text.
 * @returns escaped text safe to embed between the clue tags.
 */
export function escapeForPrompt(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '&#96;')
    // eslint-disable-next-line no-control-regex -- stripping C0 controls is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** Markers that prove a text originated from a recall payload (anti-echo gate). */
export const ECHO_MARKERS: readonly string[] = [
  MEMORY_CONTEXT_OPEN,
  MEMORY_CONTEXT_CLOSE,
  '[memory_clues',
  'memory_search',
  'memory_get',
]

/**
 * Estimate whether a message is only recalled material (and therefore must not
 * become new evidence).
 * @param text - candidate text.
 * @returns true when the text is dominated by recall output.
 */
export function looksLikeEcho(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith(MEMORY_CONTEXT_OPEN)) return true
  if (/^\[M-[A-Za-z0-9-]+\]/.test(trimmed)) return true
  return ECHO_MARKERS.some(marker => trimmed.includes(marker) && trimmed.length < 4000)
}

/** Random URL-safe token for loopback API authentication. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Default unique id for an unknown principal is never generated here: identities come from the host. */
export const UNTRUSTED_MODEL_IDENTITY = 'model-supplied-identity' as const

/** Convenience re-export for callers that only need UUID generation. */
export const newUuid = randomUUID

