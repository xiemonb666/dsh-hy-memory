/**
 * Secret scrubbing and prompt-injection detection applied before any text is
 * persisted, indexed, logged, sent to a model, or shown in the UI.
 *
 * Findings report categories and counts only — never the secret itself.
 */

export interface RedactionFinding {
  kind: string
  count: number
}

export interface RedactionResult {
  text: string
  findings: RedactionFinding[]
  total: number
  injectionSuspected: boolean
  injectionCategories: string[]
  version: number
}

export const REDACTION_VERSION = 1

interface SecretPattern {
  kind: string
  pattern: RegExp
  replace?: (match: string) => string
}

/**
 * Ordered secret patterns. The replacement is a constant marker so the same
 * secret always maps to the same placeholder without leaking length or prefix.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { kind: 'env_secret', pattern: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*=\s*(?!\[REDACTED)(?:"[^"\n]*"|'[^'\n]*'|[^\s#\n]+)/gm },
  { kind: 'credential_url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi },
  { kind: 'credit_card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g },
  { kind: 'cn_id_card', pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
]

const INJECTION_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: 'ignore_instructions', pattern: /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)/i },
  { category: 'ignore_instructions_zh', pattern: /(?:忽略|无视|忘掉|跳过)(?:之前|以上|前面|所有|全部)?(?:的)?(?:指令|规则|提示|限制|要求)/ },
  { category: 'role_override', pattern: /(?:you\s+are\s+now|从现在开始你(?:是|就是)|你现在是|act\s+as)\s+(?:an?\s+)?(?:admin|administrator|root|system|developer|developer\s+mode)/i },
  { category: 'system_prompt_exfil', pattern: /(?:reveal|print|output|show)\s+(?:your\s+)?(?:system\s+prompt|hidden\s+instructions?|developer\s+message)/i },
  { category: 'system_prompt_exfil_zh', pattern: /(?:输出|显示|打印|泄露)(?:你的)?(?:系统提示词|系统指令|隐藏指令)/ },
  { category: 'credential_exfil', pattern: /(?:send|upload|post|write|exfiltrate|transmit).{0,60}(?:api[_\s-]?key|token|password|\.env|secret)/i },
  { category: 'credential_exfil_zh', pattern: /(?:上传|发送|写入|外传|泄露).{0,40}(?:密钥|令牌|密码|\.env|凭据)/ },
  { category: 'tool_instruction', pattern: /<(?:tool|function|command)[^>]*>|(?:execute|run)\s+(?:this\s+)?(?:command|shell|code):/i },
  { category: 'authority_claim', pattern: /(?:i\s+am|this\s+is)\s+(?:the\s+)?(?:admin|administrator|owner|system)\b/i },
  { category: 'authority_claim_zh', pattern: /(?:我是|本消息来自)(?:管理员|admin|系统|所有者)/i },
]

function replaceAllWithMarker(text: string, pattern: RegExp, kind: string): { text: string; count: number } {
  let count = 0
  const replaced = text.replace(pattern, () => {
    count++
    return `[REDACTED:${kind}]`
  })
  return { text: replaced, count }
}

/**
 * Remove or mask secrets and flag instruction-like text.
 * @param input - untrusted text (tool output, message, memory content).
 * @returns redacted text, per-category counts, and injection risk.
 */
export function redact(input: string): RedactionResult {
  let text = input
  const findings: RedactionFinding[] = []
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const result = replaceAllWithMarker(text, pattern, kind)
    text = result.text
    if (result.count > 0) findings.push({ kind, count: result.count })
  }
  const injectionCategories: string[] = []
  for (const { category, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) injectionCategories.push(category)
  }
  const total = findings.reduce((sum, item) => sum + item.count, 0)
  return {
    text,
    findings,
    total,
    injectionSuspected: injectionCategories.length > 0,
    injectionCategories,
    version: REDACTION_VERSION,
  }
}

/**
 * Redact a structured value by walking strings and object keys. Used for
 * evidence excerpts, job payloads and logs; the returned value never contains a
 * detected secret.
 * @param value - JSON-compatible value.
 * @returns a redacted deep copy.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value).text as T
  if (Array.isArray(value)) return value.map(item => redactValue(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item)
    }
    return out as T
  }
  return value
}

/**
 * Detect instruction-like content in untrusted text without executing it.
 * @param input - untrusted text.
 * @returns whether injection is suspected and the matched categories.
 */
export function detectPromptInjection(input: string): { suspected: boolean; categories: string[] } {
  const categories: string[] = []
  for (const { category, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(input)) categories.push(category)
  }
  return { suspected: categories.length > 0, categories }
}

/**
 * True when a command string or file path targets a secret-bearing file that
 * must never be captured (`.env`, private keys, credential stores).
 * @param pathOrCommand - path or shell command.
 * @returns true when the target is a secret store.
 */
export function isSecretPath(pathOrCommand: string): boolean {
  const normalized = pathOrCommand.replaceAll('\\', '/')
  return (
    /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc|credentials\.json|secrets?\.ya?ml)$/i.test(normalized) ||
    /\.pem$|\.key$|\.p12$|\.pfx$/i.test(normalized) ||
    /(?:^|\s)(?:cat|type|more|Get-Content)\s+[^\s]*\.env\b/i.test(pathOrCommand)
  )
}