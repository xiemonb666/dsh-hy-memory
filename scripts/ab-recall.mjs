/**
 * Three-pair, synthetic retrieval smoke check. It compares the same model and
 * question with no memory and with the real Host semantic-recall clue. This is
 * a small reproducibility check, not an estimate of general model improvement.
 * It makes paid requests and is not part of the offline suites.
 *
 *   node scripts/ab-recall.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyModelRequestLimits,
  authorizeIsolatedDatabase,
  compileOnlineRuntimeModule,
  configurationHash,
  createIsolatedEnv,
  loadModelEnvFile,
  loadSafeSourceControls,
  makeBalancedPairOrder,
  redactSensitiveText,
  providerUsageFromMetrics,
  reportSafeError,
  requestChatCompletion,
  resolveTestPaths,
  runCommand,
  safeEffectiveModelConfig,
  searchHostSemantically,
  startIsolatedWorker,
  stopOwnedChild,
  scoreAnswer,
  validateModelEnv,
  writeJsonReport,
  writeModelEnvFile,
} from './online-test-support.mjs'

const SEED = 42
const PROJECT_CODE = 'HYMEM-TEST-ORBIT-7429'
const FACT = `Synthetic project ${PROJECT_CODE} uses CUDA 12.4 and pytest; its release codename is amber-kite-7319.`
const QUESTION = `For synthetic project ${PROJECT_CODE}, what CUDA runtime, test framework, and release codename are specified? Answer briefly. If you use a provided memory, cite its exact memory ID.`
const GOLD = ['12.4', 'pytest', 'amber-kite-7319']
const PAIR_ORDER = makeBalancedPairOrder(SEED)
const root = process.cwd()
const paths = resolveTestPaths(root)
const reportRoot = paths.reportRoot
const reportPath = join(reportRoot, `ab-harness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
const report = {
  task: 'synthetic-recall-paired-smoke',
  startedAt: new Date().toISOString(),
  status: 'running',
  seed: SEED,
  gold: GOLD,
  synthetic: { projectCode: PROJECT_CODE, fact: FACT, question: QUESTION },
  pairCount: 3,
  pairOrder: PAIR_ORDER,
  config: {},
  checks: [],
  arms: {
    noMemory: { factHits: 0, citationHits: 0, totalTokens: 0, reasoningTokens: 0, tokenUsageAvailable: true, reasoningTokenUsageAvailable: true, answers: [] },
    withRecall: { factHits: 0, citationHits: 0, totalTokens: 0, reasoningTokens: 0, tokenUsageAvailable: true, reasoningTokenUsageAvailable: true, answers: [] },
  },
  pairs: [],
  cleanup: { temporaryRunRemoved: false, ownedWorkersStarted: 0, ownedWorkersStopped: 0 },
  costUsd: null,
  costStatus: 'provider cost was not exposed by the provider response',
}

let modelEnv = Object.create(null)
let runDir
let exitCode = 1
let currentPhase = 'configuration'
let untrackedCleanupPending = false
const ownedWorkers = new Set()
const pendingChildren = new Set()
const check = (id, ok, detail = {}) => report.checks.push({ id, ok: Boolean(ok), ...detail })
const parseJson = text => {
  try { return JSON.parse(text) } catch { return null }
}

async function main() {
  try {
  mkdirSync(reportRoot, { recursive: true })
  const first = applyModelRequestLimits(validateModelEnv(loadModelEnvFile(paths.sourceEnvFile)))
  const second = applyModelRequestLimits(validateModelEnv(loadModelEnvFile(paths.sourceEnvFile)))
  const sourceBehaviorControls = loadSafeSourceControls(paths.sourceEnvFile)
  const hashRead1 = configurationHash(first)
  const hashRead2 = configurationHash(second)
  report.config = {
    hashRead1,
    hashRead2,
    unchangedBetweenReads: hashRead1 === hashRead2,
    sourceEnvValuesRecorded: false,
    sourceBehaviorControls,
    sourceBehaviorControlsPassedToChild: false,
    effectiveModelConfig: safeEffectiveModelConfig(first),
    directChatRequest: {
      model: first.MEMORY_LLM_MODEL,
      temperature: Number(first.MEMORY_LLM_TEMPERATURE ?? 0.1),
      maxTokens: 1024,
      timeoutMs: 60_000,
    },
  }
  modelEnv = first
  check('CONFIG-STABLE', report.config.unchangedBetweenReads)
  if (!report.config.unchangedBetweenReads) throw new Error('model configuration changed between the two startup reads')
  if (!existsSync(join(paths.bundleDir, 'cli.js')) || !existsSync(join(paths.bundleDir, 'python', 'hymem_worker'))) {
    throw new Error('configured bundle is incomplete')
  }
  if (!existsSync(paths.pythonPath)) throw new Error('configured SDK Python interpreter is unavailable')

  runDir = mkdtempSync(join(tmpdir(), 'hymem-ab-harness-'))
  const dataDir = join(runDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeModelEnvFile(join(dataDir, 'memory-engine.env'), modelEnv)
  const runtimeUrl = await compileOnlineRuntimeModule(root, runDir)
  const authorization = await authorizeIsolatedDatabase(runtimeUrl, join(dataDir, 'governance.db'))
  check('EGRESS-AUDIT', authorization.auditValid && authorization.models.externalEgress === 'allow-configured' && authorization.models.localOnly === false, {
    actor: authorization.actor,
    audited: authorization.auditValid,
  })

  const env = createIsolatedEnv(process.env, modelEnv, {
    dataDir,
    bundleDir: paths.bundleDir,
    pythonPath: paths.pythonPath,
  })
  currentPhase = 'runtime-check'
  const nodeVersion = await runCommand(paths.nodePath, ['--version'], { cwd: root, env, timeoutMs: 10_000 })
  const pythonVersion = await runCommand(paths.pythonPath, ['--version'], { cwd: paths.bundleDir, env, timeoutMs: 10_000 })
  report.runtime = {
    node: nodeVersion.stdout.trim().slice(0, 40),
    python: `${pythonVersion.stdout}${pythonVersion.stderr}`.trim().slice(0, 80),
  }
  check('RUNTIMES', nodeVersion.code === 0 && pythonVersion.code === 0 && !nodeVersion.spawnFailed && !pythonVersion.spawnFailed && !nodeVersion.timedOut && !pythonVersion.timedOut)

  currentPhase = 'cli-capture'
  const capture = await runCommand(paths.nodePath, [
    join(paths.bundleDir, 'cli.js'), 'capture', '--engine', 'hy', '--json', '--data-dir', dataDir,
    '--session', `ab-${PROJECT_CODE}`, '--text', FACT,
  ], { cwd: root, env, timeoutMs: 120_000 })
  const captured = capture.code === 0 && !capture.timedOut ? parseJson(capture.stdout) : null
  const created = captured?.created ?? []
  const createdIds = Array.isArray(created) ? created.filter(item => typeof item === 'string') : []
  report.capture = {
    exitCode: capture.code,
    timedOut: capture.timedOut,
    createdCount: createdIds.length,
    createdIds: createdIds.slice(0, 5),
    httpStatus: extractHttpStatus(capture.stderr),
  }
  check('CLI-CAPTURE', capture.code === 0 && !capture.timedOut && !capture.spawnFailed && createdIds.length > 0, {
    createdCount: report.capture.createdCount,
  })
  if (!(capture.code === 0 && !capture.timedOut && !capture.spawnFailed && createdIds.length > 0)) {
    throw new Error(commandFailure(capture, 'isolated CLI capture'))
  }

  currentPhase = 'sdk-probe'
  const activeWorker = await startIsolatedWorker({
    pythonPath: paths.pythonPath,
    bundleDir: paths.bundleDir,
    dataDir,
    env,
    modelPolicy: authorization.models,
  })
  ownedWorkers.add(activeWorker)
  report.cleanup.ownedWorkersStarted++
  const health = await activeWorker.request('/v1/health', undefined, 10_000)
  const expectedDims = Number(modelEnv.MEMORY_EMBEDDING_DIMS)
  check('SDK-HEALTH', health.ok === true && health.engine === 'hy-memory' && health.engineVersion === '2.0.4', {
    engine: health.engine,
    version: health.engineVersion,
  })
  check('SDK-DIMS', health.embeddingDims === expectedDims && health.embeddingDims > 0, {
    expected: expectedDims,
    actual: health.embeddingDims,
  })

  // Prove the SDK request path and collect what metrics it actually exposes.
  await activeWorker.request('/v1/ingest', {
    jobId: 'online-ab-sdk-probe',
    namespace: `project:probe:${PROJECT_CODE}`,
    workspaceId: `workspace:probe:${PROJECT_CODE}`,
    scene: 'chat',
    messages: [
      { role: 'user', content: FACT },
      { role: 'assistant', content: 'I recorded the synthetic project fact.' },
    ],
    toolOutcomes: [],
    observedAt: new Date().toISOString(),
  })
  await activeWorker.request('/v1/search', {
    namespace: `project:probe:${PROJECT_CODE}`,
    workspaceId: `workspace:probe:${PROJECT_CODE}`,
    query: `What runtime and test runner does ${PROJECT_CODE} use?`,
    limit: 3,
  })
  currentPhase = 'host-semantic-only'
  const semantic = await searchHostSemantically(runtimeUrl, {
    root,
    dataDir,
    worker: activeWorker,
    query: QUESTION,
    timeoutMs: authorization.recall.searchTimeoutMs,
  })
  report.recall = {
    mode: 'semantic',
    keywordChannelUsed: false,
    clues: semantic.clues.length,
    citationIds: semantic.clues.map(clue => clue.memoryId),
    degraded: semantic.degraded,
    tokenCount: semantic.tokenCount,
    elapsedMs: semantic.elapsedMs,
  }
  check('HOST-SEMANTIC-ONLY', semantic.clues.length > 0 && semantic.degraded === null && semantic.tokenCount <= 600 && semantic.elapsedMs < 2500, {
    clues: semantic.clues.length,
    degraded: semantic.degraded,
    tokenCount: semantic.tokenCount,
    elapsedMs: semantic.elapsedMs,
  })
  if (semantic.clues.length === 0 || semantic.degraded !== null) throw new Error('semantic-only Host retrieval returned no clue')

  const metrics = await activeWorker.request('/v1/metrics', undefined, 10_000)
  const chatCompletions = metricValue(metrics.calls?.chatCompletions)
  const embeddings = metricValue(metrics.calls?.embeddings)
  const errors = metricValue(metrics.errors)
  const providerTokenUsage = providerUsageFromMetrics(metrics)
  report.sdk = {
    engine: health.engine,
    version: health.engineVersion,
    embeddingDims: health.embeddingDims,
    metricKind: 'adapter_attempt_counters',
    chatCompletions,
    embeddings,
    errors,
    providerTokenUsage,
  }
  check('SDK-ADAPTER-COUNTERS', chatCompletions !== null && chatCompletions > 0 && embeddings !== null && embeddings > 0 && errors === 0, {
    chatCompletions: report.sdk.chatCompletions,
    embeddings: report.sdk.embeddings,
    errors: report.sdk.errors,
  })

  const schedule = PAIR_ORDER.map(pair => [...pair])
  report.pairs = schedule.map((order, index) => ({ index: index + 1, order }))
  currentPhase = 'paired-model-requests'
  for (let index = 0; index < schedule.length; index++) {
    const pair = report.pairs[index]
    for (const armName of schedule[index]) {
      const messages = armName === 'withRecall'
        ? [{ role: 'user', content: semantic.rendered }, { role: 'user', content: QUESTION }]
        : [{ role: 'user', content: QUESTION }]
      const completion = await requestChatCompletion({ env: modelEnv, messages, maxTokens: 1024, timeoutMs: 60_000 })
      const answer = redactSensitiveText(completion.content.trim(), modelEnv)
      const scored = scoreAnswer(answer, GOLD, semantic.clues.map(clue => clue.memoryId))
      const arm = report.arms[armName]
      arm.answers.push({ pair: index + 1, ...scored, usage: completion.usage, content: answer })
      if (scored.factHit) arm.factHits++
      if (scored.citationHit) arm.citationHits++
      if (completion.usage.total_tokens === null) {
        arm.totalTokens = null
        arm.tokenUsageAvailable = false
      } else if (arm.totalTokens !== null) {
        arm.totalTokens += completion.usage.total_tokens
      }
      if (completion.usage.reasoning_tokens === null) {
        arm.reasoningTokens = null
        arm.reasoningTokenUsageAvailable = false
      } else if (arm.reasoningTokens !== null) {
        arm.reasoningTokens += completion.usage.reasoning_tokens
      }
      pair[armName] = {
        ...scored,
        usage: completion.usage,
      }
    }
  }

  report.factHitRate = {
    noMemory: report.arms.noMemory.factHits / report.pairCount,
    withRecall: report.arms.withRecall.factHits / report.pairCount,
  }
  report.actualCitationRate = {
    noMemory: report.arms.noMemory.citationHits / report.pairCount,
    withRecall: report.arms.withRecall.citationHits / report.pairCount,
  }
  report.citationIds = report.recall.citationIds
  check('PAIRED-SCHEDULE', schedule.length === 3 && schedule.flat().length === 6 &&
    schedule.filter(pair => pair[0] === 'noMemory').length === 2 && schedule.filter(pair => pair[0] === 'withRecall').length === 1)
  exitCode = report.checks.every(item => item.ok) ? 0 : 1
  report.status = exitCode === 0 ? 'passed' : 'failed'
  if (exitCode !== 0) {
    report.failure = {
      phase: 'acceptance',
      errorType: 'ValidationFailure',
      detail: `failed checks: ${report.checks.filter(item => !item.ok).map(item => item.id).join(', ')}`,
    }
  }
} catch (error) {
  if (error?.cleanupPending) {
    if (error.ownedChild) pendingChildren.add(error.ownedChild)
    else if (ownedWorkers.size === 0) untrackedCleanupPending = true
  }
  report.status = 'failed'
  report.failure = safeFailure(error, currentPhase, modelEnv)
  exitCode = 1
} finally {
  for (const worker of ownedWorkers) {
    try {
      if (await worker.stop()) {
        report.cleanup.ownedWorkersStopped++
        ownedWorkers.delete(worker)
      }
    } catch { /* keep the run directory if process closure is unknown */ }
  }
  for (const child of pendingChildren) {
    try {
      if (await stopOwnedChild(child)) pendingChildren.delete(child)
    } catch { /* keep the run directory if process closure is unknown */ }
  }
  const preserveRunDir = untrackedCleanupPending || ownedWorkers.size > 0 || pendingChildren.size > 0
  report.cleanup.unclosedWorkerPids = [...ownedWorkers].map(worker => worker.pid).filter(Number.isInteger)
  report.cleanup.unclosedChildPids = [...pendingChildren].map(child => child.pid).filter(Number.isInteger)
  report.cleanup.ownershipUnknown = untrackedCleanupPending
  if (runDir) {
    if (!preserveRunDir) {
      try {
        rmSync(runDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      } catch (error) {
        report.cleanup.temporaryRunCleanupError = {
          code: typeof error?.code === 'string' ? error.code : null,
          path: runDir,
        }
      }
      report.cleanup.temporaryRunRemoved = !existsSync(runDir)
      if (!report.cleanup.temporaryRunRemoved && !report.cleanup.temporaryRunCleanupError) {
        report.cleanup.temporaryRunCleanupError = { code: 'STILL_EXISTS', path: runDir }
      }
    }
  }
  report.cleanup.preservedForUnclosedChild = preserveRunDir
  const workersClean = report.cleanup.ownedWorkersStarted === report.cleanup.ownedWorkersStopped
  if (!workersClean || !report.cleanup.temporaryRunRemoved) {
    report.status = 'failed'
    exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  report.ok = report.status === 'passed' && report.checks.every(item => item.ok) && workersClean && report.cleanup.temporaryRunRemoved
  try {
    mkdirSync(reportRoot, { recursive: true })
    writeJsonReport(reportPath, report)
  } catch (error) {
    report.ok = false
    report.status = 'failed'
    report.failure = {
      phase: 'report-write',
      errorType: 'ReportWriteError',
      code: typeof error?.code === 'string' ? error.code : null,
      path: typeof error?.path === 'string' ? error.path : reportPath,
      detail: 'report could not be saved',
    }
    exitCode = 1
  }
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
}
}

await main()
process.exitCode = exitCode

function metricValue(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function extractHttpStatus(value) {
  return String(value).match(/\bHTTP\s+(\d{3})\b/i)?.[1] ?? null
}

function commandFailure(result, label) {
  const status = extractHttpStatus(result.stderr)
  return `${label} failed${result.spawnFailed ? ' to start' : ` (exit ${result.code ?? 'unknown'}${result.timedOut ? ', timed out' : ''}${status ? `, HTTP ${status}` : ''})`}`
}

function safeFailure(error, phase, env) {
  const detail = reportSafeError(error, env)
  const status = extractHttpStatus(detail)
  return {
    phase,
    errorType: error instanceof Error ? error.name : 'UnknownError',
    ...(status ? { httpStatus: status } : {}),
    detail,
  }
}
