/**
 * Deterministic evidence verification for the pollution chain.
 *
 * The gate answers one question: may this candidate claim be stored as
 * `supported`, `needs_review`, or rejected? It never promotes a model claim to
 * `verified`; verification additionally requires a real validation record.
 */
import type { EvidenceTrust } from '@dsh-hy-memory/contracts'

const NEGATION_TOKENS = [
  'not',
  'no',
  'never',
  'failed',
  'failure',
  'unverified',
  'unproven',
  'inconclusive',
  'not established',
  'no significant',
  'crosses zero',
  'cannot',
  "doesn't",
  'does not',
  'did not',
  'is not',
  'passes with failures',
]

const NEGATION_CJK = ['未', '不', '没有', '无法', '失败', '未证明', '未验证', '不显著', '未确立', '否定', '并非']

const SUCCESS_TOKENS = ['pass', 'passed', 'passes', 'passing', 'success', 'succeeded', 'green', 'ok', 'works', 'fixed', 'fixed the', 'verified']
const SUCCESS_CJK = ['通过', '成功', '修复', '已验证', '已解决']

const FAILURE_TOKENS = ['failed', 'failure', 'failing', 'error', 'errors', 'exit code 1', 'exit_code=1', 'non-zero', 'nonzero', 'broken', 'regression']
const FAILURE_CJK = ['失败', '报错', '未通过', '回归']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Word-boundary token match. A plain substring test would treat "now" as "no"
 * and "pass" as "passed", which is exactly how a pollution guard fails open.
 * @param text - text to search.
 * @param tokens - lowercase ASCII tokens.
 * @returns true when any token occurs as a whole word/phrase.
 */
function hasAsciiToken(text: string, tokens: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return tokens.some(token => new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(token)}(?:$|[^a-z0-9_])`, 'i').test(lower))
}

function hasCjkToken(text: string, tokens: readonly string[]): boolean {
  return tokens.some(token => text.includes(token))
}

function tokenizeNumbers(text: string): string[] {
  return [...text.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)].map(match => match[0])
}

function tokenizePaths(text: string): string[] {
  return [...text.matchAll(/[\w./-]+\.(?:py|ts|tsx|js|mjs|c|cc|cpp|cu|h|hpp|rs|go|java|json|ya?ml|toml|md)\b/g)].map(match => match[0])
}

function hasNegation(text: string): boolean {
  return hasAsciiToken(text, NEGATION_TOKENS) || hasCjkToken(text, NEGATION_CJK)
}

function hasSuccess(text: string): boolean {
  return hasAsciiToken(text, SUCCESS_TOKENS) || hasCjkToken(text, SUCCESS_CJK)
}

function hasFailure(text: string): boolean {
  return hasAsciiToken(text, FAILURE_TOKENS) || hasCjkToken(text, FAILURE_CJK)
}

export interface AnchorInput {
  candidate: string
  evidenceTexts: string[]
  toolOutcomes: Array<{ exitCode?: number; success?: boolean; name: string }>
  trustLevels: EvidenceTrust[]
  userExplicit: boolean
}

export interface AnchorResult {
  decision: 'supported' | 'needs_review' | 'rejected'
  reasons: string[]
  trustCeiling: EvidenceTrust
  negationPreserved: boolean
  evidenceCount: number
  /** True when the candidate may be shown as a factual verified statement. */
  verifiedEligible: boolean
}

const TRUST_RANK: Record<EvidenceTrust, number> = {
  model_generated: 0,
  external_cited: 1,
  user_explicit: 2,
  repository_observed: 3,
  tool_observed: 4,
  test_verified: 5,
}

/**
 * Anchor a candidate claim against its real evidence.
 *
 * Rules enforced here:
 * - zero evidence → rejected;
 * - only model-generated evidence → needs_review (never supported as fact);
 * - dropped negation, success claimed over a failing tool exit, or invented
 *   numbers/paths → needs_review with explicit reasons;
 * - a real passing test on the tested commit is the only trust level that is
 *   `verified`-eligible, and even then the state machine still requires a
 *   validation record.
 * @param input - candidate and evidence observations.
 * @returns anchor decision, reasons, and the highest evidence trust.
 */
export function anchorClaim(input: AnchorInput): AnchorResult {
  const reasons: string[] = []
  if (input.evidenceTexts.length === 0) {
    return {
      decision: 'rejected',
      reasons: ['no_evidence'],
      trustCeiling: 'model_generated',
      negationPreserved: false,
      evidenceCount: 0,
      verifiedEligible: false,
    }
  }
  const ceiling = input.trustLevels.reduce<EvidenceTrust>(
    (best, level) => (TRUST_RANK[level] > TRUST_RANK[best] ? level : best),
    'model_generated',
  )
  const evidenceJoined = input.evidenceTexts.join('\n')
  const evidenceNegated = hasNegation(evidenceJoined)
  const candidateNegated = hasNegation(input.candidate)
  let negationPreserved = true
  if (evidenceNegated && !candidateNegated) {
    negationPreserved = false
    reasons.push('negation_dropped')
  }
  if (candidateNegated && !evidenceNegated) {
    reasons.push('negation_added')
  }
  const failing = input.toolOutcomes.some(outcome => outcome.exitCode !== undefined && outcome.exitCode !== 0) ||
    input.toolOutcomes.some(outcome => outcome.success === false)
  if (failing && hasSuccess(input.candidate) && !candidateNegated) {
    reasons.push('success_claim_against_failed_tool')
  }
  const evidenceNumbers = new Set(tokenizeNumbers(evidenceJoined))
  const invented = tokenizeNumbers(input.candidate).filter(number => !evidenceNumbers.has(number))
  if (invented.length > 0) reasons.push(`numbers_not_in_evidence:${invented.slice(0, 5).join(',')}`)
  const evidencePaths = new Set(tokenizePaths(evidenceJoined))
  const inventedPaths = tokenizePaths(input.candidate).filter(path => !evidencePaths.has(path))
  if (inventedPaths.length > 0) reasons.push(`paths_not_in_evidence:${inventedPaths.slice(0, 5).join(',')}`)

  if (ceiling === 'model_generated') reasons.push('model_generated_only')

  let decision: AnchorResult['decision'] = 'supported'
  if (ceiling === 'model_generated') decision = 'needs_review'
  if (reasons.includes('negation_dropped') || reasons.includes('success_claim_against_failed_tool')) decision = 'needs_review'
  if (input.trustLevels.length === 0) decision = 'rejected'
  if (input.userExplicit && ceiling === 'user_explicit') {
    decision = 'supported'
    reasons.push('user_explicit_statement')
  }
  if (failing && hasFailure(input.candidate) && !hasSuccess(input.candidate)) {
    decision = 'supported'
    reasons.push('failure_matches_evidence')
  }

  const verifiedEligible = decision === 'supported' && ceiling === 'test_verified'
  return {
    decision,
    reasons,
    trustCeiling: ceiling,
    negationPreserved,
    evidenceCount: input.evidenceTexts.length,
    verifiedEligible,
  }
}

export interface ClaimParts {
  subject: string
  predicate: string
  object: string
  polarity: 'affirm' | 'negate' | 'unknown'
  claimKey: string
}

const PREDICATES: Array<[RegExp, string]> = [
  [/\b(uses?|using|depends on|requires?)\b|(?:使用|依赖|需要)/i, 'uses'],
  [/\b(fix(?:ed|es)?|resolve[sd]?|repair(?:ed|s)?)\b|(?:修复|解决)/i, 'fixes'],
  [/\b(fail(?:ed|s|ure)?|error|regression)\b|(?:失败|报错|回归)/i, 'fails'],
  [/\b(prefer(?:s|red)?|decision|decided|choose|chose)\b|(?:偏好|决定|选择)/i, 'prefers'],
  [/\b(default|set to|configured?)\b|(?:默认|配置为)/i, 'defaults_to'],
  [/\b(version|toolchain|cuda|python|node)\b|(?:版本|工具链)/i, 'version'],
]

/**
 * Derive a stable claim triple from text. Deliberately conservative: when no
 * predicate is recognized the claim is stored under `states` so conflicting
 * restatements still collide on the same subject.
 * @param text - claim text.
 * @param fallbackSubject - subject used when no identifier/path is found.
 * @returns claim parts and a grouping key (subject|predicate|branch scope).
 */
export function deriveClaim(text: string, fallbackSubject: string): ClaimParts {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const path = tokenizePaths(normalized)[0]
  const identifier = normalized.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/)?.[0]
  const subject = (path ?? identifier ?? fallbackSubject).toLowerCase()
  const predicate = PREDICATES.find(([pattern]) => pattern.test(normalized))?.[1] ?? 'states'
  const object = normalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._/:+-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  const polarity = hasNegation(normalized) ? 'negate' : 'affirm'
  const claimKey = `${subject}|${predicate}|${polarity}`
  return { subject, predicate, object, polarity, claimKey }
}

/**
 * Decide whether two claims conflict. Claims conflict when they share a
 * subject and predicate but assert different objects, including a polarity
 * flip. Identical objects and subset restatements do not conflict.
 * @param left - existing claim.
 * @param right - new claim.
 * @returns a conflict reason or null.
 */
export function claimsConflict(
  left: { subject: string; predicate: string; object: string; polarity: string },
  right: { subject: string; predicate: string; object: string; polarity: string },
): string | null {
  if (left.subject !== right.subject || left.predicate !== right.predicate) return null
  if (left.polarity !== right.polarity) return 'polarity_conflict'
  if (left.object === right.object) return null
  if (left.object.includes(right.object) || right.object.includes(left.object)) return null
  return 'different_value'
}

/**
 * Whether a memory of this status may be injected as factual guidance.
 * `stale`, `conflicted`, `deleted`, `rejected`, and `superseded` never may.
 * @param status - memory status.
 * @returns true for verified/supported only.
 */
export function isFactualGuidance(status: string): boolean {
  return status === 'verified' || status === 'supported'
}

/**
 * Whether a memory needs explicit "unverified" labelling when injected.
 * @param status - memory status.
 * @returns true for proposed/hypothesis-style statuses.
 */
export function needsUnverifiedLabel(status: string): boolean {
  return status === 'proposed' || status === 'needs_review'
}
