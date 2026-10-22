import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ALLOWED_MODEL_KEYS = new Set([
  'MEMORY_LLM_PROVIDER',
  'MEMORY_LLM_BASE_URL',
  'MEMORY_LLM_MODEL',
  'MEMORY_LLM_API_KEY',
  'MEMORY_LLM_TIMEOUT',
  'MEMORY_LLM_MAX_RETRIES',
  'MEMORY_LLM_RETRY_DELAY',
  'MEMORY_LLM_TEMPERATURE',
  'MEMORY_LLM_MAX_TOKENS',
  'MEMORY_LLM_EXTRA_BODY',
  'MEMORY_AGENT_MAX_TOKENS',
  'MEMORY_EMBEDDER_PROVIDER',
  'MEMORY_EMBEDDER_BASE_URL',
  'MEMORY_EMBEDDER_MODEL',
  'MEMORY_EMBEDDER_API_KEY',
  'MEMORY_EMBEDDER_TIMEOUT',
  'MEMORY_EMBEDDER_MAX_RETRIES',
  'MEMORY_EMBEDDER_RETRY_DELAY',
  'MEMORY_EMBEDDING_DIMS',
  'MEMORY_MODE',
])
const SAFE_SOURCE_BEHAVIOR_KEYS = new Set([
  'MEMORY_CODING_ENABLED',
  'MEMORY_HISTORY_ENABLE',
  'MEMORY_METRICS',
])

const RESERVED_EXTRA_BODY_KEYS = new Set(['model', 'messages', 'max_tokens', 'temperature', 'stream'])
const REPORT_MAX_BYTES = 2 * 1024 * 1024
const childLifecycles = new WeakMap()

/** Parse a KEY=VALUE file, retaining only model parameters explicitly allowed for this test. */
export function parseModelEnv(contents) {
  if (typeof contents !== 'string') throw new TypeError('model environment file must be text')
  const result = Object.create(null)
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !ALLOWED_MODEL_KEYS.has(key)) continue
    if (Object.hasOwn(result, key)) throw new Error(`duplicate model setting ${key}`)
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (/[\r\n\0]/.test(value)) throw new Error(`invalid value for model setting ${key}`)
    result[key] = value
  }
  return result
}

export function loadModelEnvFile(path) {
  return parseModelEnv(readFileSync(path, 'utf8'))
}

/** Read only the explicitly non-sensitive SDK behavior toggles needed to document config drift. */
export function loadSafeSourceControls(path) {
  const result = Object.create(null)
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (!SAFE_SOURCE_BEHAVIOR_KEYS.has(key)) continue
    const value = trimmed.slice(separator + 1).trim()
    result[key] = value === '0' || value === '1' ? value : 'present'
  }
  return result
}

export function validateModelEnv(env) {
  for (const key of ['MEMORY_LLM_BASE_URL', 'MEMORY_LLM_MODEL', 'MEMORY_LLM_API_KEY', 'MEMORY_EMBEDDER_BASE_URL', 'MEMORY_EMBEDDER_MODEL', 'MEMORY_EMBEDDER_API_KEY']) {
    if (typeof env?.[key] !== 'string' || env[key].trim() === '') throw new Error(`required model setting is missing: ${key}`)
  }
  for (const key of ['MEMORY_LLM_BASE_URL', 'MEMORY_EMBEDDER_BASE_URL']) {
    let url
    try {
      url = new URL(env[key])
    } catch {
      throw new Error(`${key} must be an HTTP(S) URL`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
      throw new Error(`${key} must be an HTTP(S) URL without embedded credentials`)
    }
  }
  const dims = Number(env.MEMORY_EMBEDDING_DIMS)
  if (!Number.isInteger(dims) || dims < 1 || dims > 65536) throw new Error('a positive embedding dimension is required')
  if (env.MEMORY_LLM_EXTRA_BODY !== undefined) {
    let extra
    try {
      extra = JSON.parse(env.MEMORY_LLM_EXTRA_BODY)
    } catch {
      throw new Error('MEMORY_LLM_EXTRA_BODY must be valid JSON')
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('MEMORY_LLM_EXTRA_BODY must be a JSON object')
    if (Object.keys(extra).some(key => RESERVED_EXTRA_BODY_KEYS.has(key))) throw new Error('MEMORY_LLM_EXTRA_BODY contains a reserved request field')
  }
  return env
}

/** Apply bounded requests: HyMemory LLM max_retries is total attempts, while the embedder's value is retries after its first attempt. */
export function applyModelRequestLimits(env, { timeoutSeconds = 60 } = {}) {
  const bounded = Object.create(null)
  for (const [key, value] of Object.entries(env)) if (ALLOWED_MODEL_KEYS.has(key)) bounded[key] = String(value)
  for (const prefix of ['MEMORY_LLM', 'MEMORY_EMBEDDER']) {
    const key = `${prefix}_TIMEOUT`
    const configured = Number(bounded[key] ?? timeoutSeconds)
    const safeTimeout = Number.isFinite(configured) && configured > 0 ? Math.min(configured, timeoutSeconds) : timeoutSeconds
    bounded[key] = String(safeTimeout)
  }
  bounded.MEMORY_LLM_MAX_RETRIES = '1'
  bounded.MEMORY_EMBEDDER_MAX_RETRIES = '0'
  bounded.MEMORY_ENABLE_GRAPH = '0'
  return bounded
}

export function serializeModelEnv(env) {
  const entries = Object.entries(env)
    .filter(([key]) => ALLOWED_MODEL_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error(`invalid value for model setting ${key}`)
  }
  return entries.map(([key, value]) => `${key}=${value}`).join('\n') + (entries.length > 0 ? '\n' : '')
}

export function writeModelEnvFile(path, env) {
  writeFileSync(path, serializeModelEnv(env), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

/** Persist a machine-readable validation report, retaining safe filesystem diagnostics on failure. */
export function writeJsonReport(path, report) {
  try {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (cause) {
    const error = new Error('report could not be saved')
    error.name = 'ReportWriteError'
    error.code = typeof cause?.code === 'string' ? cause.code : null
    error.path = path
    throw error
  }
}

/** Fingerprint the effective allowlisted configuration; never return its values. */
export function configurationHash(env) {
  const canonical = Object.entries(env)
    .filter(([key]) => ALLOWED_MODEL_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${String(value)}`)
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Keep missing provider usage distinct from a measured zero. */
export function normalizeUsage(usage) {
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : null
  }
  const totalTokens = numberOrNull(usage?.total_tokens)
  return {
    available: totalTokens !== null,
    total_tokens: totalTokens,
    prompt_tokens: numberOrNull(usage?.prompt_tokens),
    completion_tokens: numberOrNull(usage?.completion_tokens),
    reasoning_tokens: numberOrNull(usage?.completion_tokens_details?.reasoning_tokens),
  }
}

/** Adapter metrics are counters, not provider token usage; only an explicit providerUsage payload is evidence. */
export function providerUsageFromMetrics(metrics) {
  const usage = metrics?.providerUsage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return {
      available: false,
      total_tokens: null,
      prompt_tokens: null,
      completion_tokens: null,
      reasoning_tokens: null,
      source: 'UNKNOWN',
    }
  }
  return {
    ...normalizeUsage(usage),
    source: 'provider-response',
  }
}

/** Summarize only approved, non-secret model settings for reproducibility reports. */
export function safeEffectiveModelConfig(env) {
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  const extraBodyText = typeof env?.MEMORY_LLM_EXTRA_BODY === 'string' ? env.MEMORY_LLM_EXTRA_BODY : ''
  let extraBodyBooleans = null
  if (extraBodyText) {
    try {
      const parsed = JSON.parse(extraBodyText)
      const allowedBooleanKeys = new Set(['enable_thinking'])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          Object.keys(parsed).every(key => allowedBooleanKeys.has(key) && typeof parsed[key] === 'boolean')) {
        extraBodyBooleans = parsed
      }
    } catch { /* the allowlisted hash still records an opaque configured body */ }
  }
  const optional = value => typeof value === 'string' && value.length > 0 ? value : null
  return {
    memoryMode: optional(env?.MEMORY_MODE),
    llm: {
      model: optional(env?.MEMORY_LLM_MODEL),
      temperature: numberOrNull(env?.MEMORY_LLM_TEMPERATURE),
      maxTokens: numberOrNull(env?.MEMORY_LLM_MAX_TOKENS),
      agentMaxTokens: numberOrNull(env?.MEMORY_AGENT_MAX_TOKENS),
      timeoutSeconds: numberOrNull(env?.MEMORY_LLM_TIMEOUT),
      maxRetries: numberOrNull(env?.MEMORY_LLM_MAX_RETRIES),
      extraBodyBooleans,
      extraBodyHash: extraBodyText ? createHash('sha256').update(extraBodyText).digest('hex') : null,
    },
    embedder: {
      model: optional(env?.MEMORY_EMBEDDER_MODEL),
      embeddingDims: numberOrNull(env?.MEMORY_EMBEDDING_DIMS),
      timeoutSeconds: numberOrNull(env?.MEMORY_EMBEDDER_TIMEOUT),
      maxRetries: numberOrNull(env?.MEMORY_EMBEDDER_MAX_RETRIES),
    },
  }
}

/** Score fact recall and answer citations independently. */
export function scoreAnswer(answer, gold, citationIds = []) {
  const normalized = String(answer).toLowerCase()
  const factHit = gold.every(value => normalized.includes(String(value).toLowerCase()))
  const citedIds = citationIds.filter(id => {
    const value = String(id)
    return value.length > 0 && normalized.includes(value.toLowerCase())
  })
  return { factHit, citationHit: citedIds.length > 0, citedIds }
}

const STRIPPED_ENV_NAME = /^(?:OPENAI_|MEMORY_|LLM_|EMBEDDING_|HYMEM_|DSH_|PYTHONPATH$|PYTHONHOME$|VIRTUAL_ENV$|NODE_OPTIONS$)/i

/** Keep only ordinary process plumbing from the caller and then set explicit run-owned paths. */
export function createIsolatedEnv(parentEnv, modelEnv, { dataDir, bundleDir, pythonPath }) {
  const env = Object.create(null)
  for (const [key, value] of Object.entries(parentEnv ?? {})) {
    if (value !== undefined && !STRIPPED_ENV_NAME.test(key)) env[key] = value
  }
  for (const [key, value] of Object.entries(modelEnv ?? {})) {
    if (ALLOWED_MODEL_KEYS.has(key)) env[key] = String(value)
  }
  env.HYMEM_DATA_DIR = dataDir
  env.HYMEM_BUNDLE_DIR = bundleDir
  env.HYMEM_PYTHON = pythonPath
  env.MEMORY_ENABLE_GRAPH = '0'
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONUTF8 = '1'
  return env
}

export function resolveTestPaths(root, env = process.env) {
  const bundleDir = env.HYMEM_BUNDLE_DIR || join(root, 'dist', 'bundle')
  const sourceEnvFile = env.HYMEM_TEST_ENV_FILE || join(root, 'artifacts', 'e2e-data', 'memory-engine.env')
  const reportRoot = env.HYMEM_ONLINE_REPORT_DIR || join(root, 'artifacts', 'validation-20261021')
  const isWindows = process.platform === 'win32'
  const defaultPython = join(root, '.venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python')
  const pythonPath = env.HYMEM_PYTHON || defaultPython
  const nodePath = env.HYMEM_TEST_NODE || process.execPath
  return { root, bundleDir, sourceEnvFile, reportRoot, pythonPath, nodePath }
}

/** Three paired smoke checks, with seeded ordering and balanced arm positions. */
export function makeBalancedPairOrder(seed = 42) {
  let state = Number(seed) >>> 0
  const random = () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  const slots = ['noMemory-first', 'withRecall-first', 'noMemory-first']
  for (let index = slots.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[slots[index], slots[other]] = [slots[other], slots[index]]
  }
  return slots.map(order => order === 'noMemory-first' ? ['noMemory', 'withRecall'] : ['withRecall', 'noMemory'])
}

/** Create the small source bundle used only to run real Host semantic retrieval against the isolated DB. */
export async function compileOnlineRuntimeModule(root, outputDir) {
  const { build } = await import('esbuild')
  const outfile = join(outputDir, 'online-runtime.mjs')
  const source = [
    "export { GovernanceStore } from './packages/governance/src/index.ts'",
    "export { buildCandidateSource } from './packages/host-plugin/src/sources.ts'",
    "export { EngineClient } from './packages/host-plugin/src/engine.ts'",
    "export { resolveWorkspaceIdentity } from './packages/host-plugin/src/identity.ts'",
    "export { RetrievalController } from './packages/retrieval/src/index.ts'",
  ].join('\n')
  await build({
    stdin: { contents: source, resolveDir: root, sourcefile: 'online-runtime-entry.ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    logLevel: 'silent',
  })
  return pathToFileURL(outfile).href
}

/** Record an explicit test-only egress grant in this run's own governance DB. */
export async function authorizeIsolatedDatabase(moduleUrl, dbPath, actor = 'online-test:user-authorized') {
  const { GovernanceStore } = await import(moduleUrl)
  const store = new GovernanceStore(dbPath)
  try {
    const { revision } = store.getSettings()
    const updated = store.updateSettings({
      models: { externalEgress: 'allow-configured', localOnly: false },
      recall: { maxInjectionTokens: 600, searchTimeoutMs: 2500 },
    }, revision, actor)
    const audit = store.verifyAuditChain()
    return {
      models: updated.settings.models,
      recall: updated.settings.recall,
      auditValid: audit.valid,
      actor,
    }
  } finally {
    store.close()
  }
}

/** Start one exact run-owned Python worker and expose only its loopback API. */
export async function startIsolatedWorker({
  pythonPath,
  bundleDir,
  dataDir,
  env,
  modelPolicy,
  startupTimeoutMs = 30_000,
  requestTimeoutSeconds = 60,
}) {
  mkdirSync(dataDir, { recursive: true })
  const tokenPath = join(dataDir, 'owned-worker-token')
  const portPath = join(dataDir, 'owned-worker-port')
  const token = randomBytes(32).toString('base64url')
  writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const childEnv = { ...env, PYTHONPATH: join(bundleDir, 'python'), HYMEM_MODEL_POLICY: JSON.stringify(modelPolicy) }
  let child
  try {
    child = spawn(pythonPath, [
      '-m', 'hymem_worker', '--port', '0', '--port-file', portPath,
      '--token-file', tokenPath, '--engine', 'hy', '--data-dir', dataDir,
      '--env-file', join(dataDir, 'memory-engine.env'), '--request-timeout', String(requestTimeoutSeconds),
    ], { cwd: bundleDir, env: childEnv, windowsHide: true, stdio: 'ignore' })
  } catch {
    rmSync(tokenPath, { force: true })
    throw new Error('owned SDK worker failed to start')
  }
  watchChild(child)
  let port
  try {
    port = await waitForOwnedWorker(child, portPath, startupTimeoutMs)
  } catch {
    const closed = await stopOwnedChild(child)
    if (!closed) {
      const failure = new Error('owned SDK worker startup failed and shutdown could not be confirmed')
      failure.cleanupPending = true
      failure.ownedPid = child.pid ?? null
      failure.ownedChild = child
      throw failure
    }
    rmSync(tokenPath, { force: true })
    rmSync(portPath, { force: true })
    throw new Error('owned SDK worker failed to start or reach readiness')
  }
  let stopped = false
  let stopResult
  let stopping = false
  return {
    pid: child.pid ?? null,
    port,
    token,
    async request(route, body, timeoutMs = 60_000) {
      if (stopped) throw new Error('owned worker is stopped')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(`owned worker HTTP ${response.status}`)
        }
        try { return await response.json() } catch { throw new Error('owned worker returned invalid JSON') }
      } catch (error) {
        if (controller.signal.aborted) throw new Error('owned worker request timeout')
        if (error instanceof Error && error.message.startsWith('owned worker ')) throw error
        throw new Error('owned worker request failed')
      } finally {
        clearTimeout(timer)
      }
    },
    async stop() {
      if (stopped && stopResult === true) return true
      if (stopping) return false
      stopping = true
      const closed = await stopOwnedChild(child)
      stopping = false
      stopped = closed
      stopResult = closed
      if (closed) {
        rmSync(tokenPath, { force: true })
        rmSync(portPath, { force: true })
      }
      return closed
    },
  }
}

async function waitForOwnedWorker(child, portPath, timeoutMs) {
  const lifecycle = watchChild(child)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (lifecycle.error) throw new Error('owned SDK worker executable failed')
    if (lifecycle.closed) throw new Error('owned SDK worker exited before readiness')
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('owned SDK worker exited before readiness')
    if (existsSync(portPath)) {
      try {
        const port = Number.parseInt(readFileSync(portPath, 'utf8').trim(), 10)
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port
      } catch { /* port file may be in the middle of a write */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('owned SDK worker startup timeout')
}

/** Exercise the real Host semantic-only path and return its governed clues. */
export async function searchHostSemantically(moduleUrl, { root, dataDir, worker, query, timeoutMs = 2500 }) {
  const { GovernanceStore, EngineClient, RetrievalController, buildCandidateSource, resolveWorkspaceIdentity } = await import(moduleUrl)
  const store = new GovernanceStore(join(dataDir, 'governance.db'))
  try {
    const identity = resolveWorkspaceIdentity(root)
    const { settings, revision } = store.getSettings()
    const engine = new EngineClient({
      baseUrl: `http://127.0.0.1:${worker.port}`,
      token: worker.token,
      timeoutMs,
      modelPolicy: () => store.getSettings().settings.models,
      startupModelPolicy: settings.models,
      managedWorker: true,
    })
    const source = buildCandidateSource({
      store,
      engine: () => engine,
      workspaceOf: searchQuery => ({ projectId: searchQuery.projectId, ...(searchQuery.workspaceId ? { workspaceId: searchQuery.workspaceId } : {}) }),
      timeoutMs,
    })
    const controller = new RetrievalController({ store, source, settings: settings.recall, settingsRevision: revision })
    return await controller.searchWithTimeout({
      query,
      mode: 'semantic',
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      agentId: 'online-test',
      principalId: 'owner',
      sessionId: 'online-test-semantic',
      limit: 40,
      semantic: true,
    }, timeoutMs)
  } finally {
    store.close()
  }
}

/** A/B order is fixed-size; this function makes changing it explicit in test code. */
export function reportSafeError(error, env = {}) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  let safe = raw
  for (const key of ['MEMORY_LLM_API_KEY', 'MEMORY_EMBEDDER_API_KEY']) {
    const secret = env[key]
    if (typeof secret === 'string' && secret) safe = safe.split(secret).join('[redacted]')
  }
  safe = safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
  safe = safe.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, '[redacted]@')
  return safe.slice(0, 500)
}

export function redactSensitiveText(value, env = {}) {
  let safe = String(value)
  for (const key of ['MEMORY_LLM_API_KEY', 'MEMORY_EMBEDDER_API_KEY']) {
    const secret = env[key]
    if (typeof secret === 'string' && secret) safe = safe.split(secret).join('[redacted]')
  }
  safe = safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
  safe = safe.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, '[redacted]@')
  return safe.slice(0, 1000)
}

/** One bounded OpenAI-compatible chat request. Redirects and retries are disabled. */
export async function requestChatCompletion({ env, messages, maxTokens = 1024, timeoutMs = 60_000 }) {
  validateModelEnv(env)
  const base = env.MEMORY_LLM_BASE_URL.endsWith('/') ? env.MEMORY_LLM_BASE_URL : `${env.MEMORY_LLM_BASE_URL}/`
  const url = new URL('chat/completions', base)
  const extraBody = env.MEMORY_LLM_EXTRA_BODY ? JSON.parse(env.MEMORY_LLM_EXTRA_BODY) : {}
  const payload = JSON.stringify({
    ...extraBody,
    model: env.MEMORY_LLM_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: Number(env.MEMORY_LLM_TEMPERATURE ?? 0.1),
  })
  const controller = new AbortController()
  let timer
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.MEMORY_LLM_API_KEY}`,
          'content-type': 'application/json',
        },
        body: payload,
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('provider request timeout')
      if (error instanceof Error && error.name === 'TypeError') throw new Error('provider request failed')
      throw new Error('provider request failed')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`provider HTTP ${response.status}`)
    }
    let text
    try {
      text = await response.text()
    } catch {
      throw new Error('provider response read failed')
    }
    if (Buffer.byteLength(text, 'utf8') > REPORT_MAX_BYTES) throw new Error('provider response exceeded the size limit')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('provider returned invalid JSON')
    }
    const content = parsed?.choices?.[0]?.message?.content
    const normalizedContent = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(item => typeof item?.text === 'string' ? item.text : '').join('')
        : ''
    return {
      content: normalizedContent,
      usage: normalizeUsage(parsed?.usage),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Run a child with a strict wall-clock timeout and bounded captured output. */
export async function runCommand(executable, args, { cwd, env, timeoutMs = 120_000, maxOutputBytes = 1024 * 1024 } = {}) {
  const child = spawn(executable, args, {
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lifecycle = watchChild(child)
  const stdout = []
  const stderr = []
  let size = 0
  let timedOut = false
  const capture = (target, chunk) => {
    if (size >= maxOutputBytes) return
    const data = Buffer.from(chunk)
    const kept = data.subarray(0, Math.max(0, maxOutputBytes - size))
    target.push(kept)
    size += kept.length
  }
  child.stdout.on('data', chunk => capture(stdout, chunk))
  child.stderr.on('data', chunk => capture(stderr, chunk))
  if (!await waitForChildClose(child, timeoutMs)) {
    timedOut = true
    const stopped = await terminateOwnedProcessTree(child)
    if (!stopped) {
      const failure = new Error('owned child process did not close after timeout')
      failure.cleanupPending = true
      failure.ownedPid = child.pid ?? null
      failure.ownedChild = child
      throw failure
    }
  }
  return {
    code: typeof lifecycle.code === 'number' ? lifecycle.code : null,
    signal: lifecycle.signal ?? null,
    timedOut,
    spawnFailed: Boolean(lifecycle.error),
    processStopped: lifecycle.closed,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

async function terminateOwnedProcessTree(child) {
  const lifecycle = watchChild(child)
  if (lifecycle.closed) return true
  if (process.platform === 'win32') {
    if (child.pid) {
      let killer
      try {
        killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        watchChild(killer)
      } catch { /* Fall through to a direct signal for this exact child. */ }
      if (killer && !await waitForChildClose(killer, 5000)) {
        try { killer.kill('SIGKILL') } catch { /* already exited */ }
        await waitForChildClose(killer, 1000)
      }
      if (await waitForChildClose(child, 1000)) return true
    }
  } else {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM')
      else child.kill('SIGTERM')
    } catch {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    }
    if (await waitForChildClose(child, 1000)) return true
  }
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already exited */ }
  }
  return waitForChildClose(child, 1000)
}

/** Stop one exact directly-owned child; it never searches for processes by name or path. */
export async function stopOwnedChild(child, timeoutMs = 3000) {
  const lifecycle = watchChild(child)
  if (lifecycle.closed) return true
  try { child.kill('SIGTERM') } catch { /* process may have exited between checks */ }
  const closed = await waitForChildClose(child, timeoutMs)
  if (closed) return true
  try { child.kill('SIGKILL') } catch { /* already exited */ }
  return waitForChildClose(child, timeoutMs)
}

function watchChild(child) {
  let lifecycle = childLifecycles.get(child)
  if (lifecycle) return lifecycle
  lifecycle = {
    error: null,
    closed: child.exitCode !== null || child.signalCode !== null,
    code: child.exitCode,
    signal: child.signalCode,
    closePromise: undefined,
    resolveClose: undefined,
  }
  lifecycle.closePromise = new Promise(resolve => { lifecycle.resolveClose = resolve })
  if (lifecycle.closed) lifecycle.resolveClose(true)
  child.on('error', error => { lifecycle.error = error })
  child.once('close', (code, signal) => {
    lifecycle.closed = true
    lifecycle.code = code
    lifecycle.signal = signal
    lifecycle.resolveClose(true)
  })
  childLifecycles.set(child, lifecycle)
  return lifecycle
}

function waitForChildClose(child, timeoutMs) {
  const lifecycle = watchChild(child)
  if (lifecycle.closed) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
    lifecycle.closePromise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** Small helper for callers that keep temp output under an OS temp directory. */
export function osTempDirectory() {
  return tmpdir()
}

export function parentDirectory(path) {
  return dirname(path)
}
