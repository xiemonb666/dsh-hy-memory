/**
 * Isolated, opt-in validation of the real HyMemory SDK path. This script makes
 * paid model requests; it is intentionally outside the normal E2E suite.
 *
 *   node tests/e2e/online-engine.mjs
 *
 * Only synthetic facts are sent. Every run gets fresh governance and SDK data
 * directories. The source env file is parsed through a model-parameter
 * allowlist and is never copied verbatim or printed.
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
  providerUsageFromMetrics,
  reportSafeError,
  resolveTestPaths,
  runCommand,
  safeEffectiveModelConfig,
  searchHostSemantically,
  startIsolatedWorker,
  stopOwnedChild,
  validateModelEnv,
  writeJsonReport,
  writeModelEnvFile,
} from '../../scripts/online-test-support.mjs'

const PROJECT_CODE = 'HYMEM-TEST-ORBIT-7429'
const FACT = `Synthetic project ${PROJECT_CODE} pins CUDA 12.4 and uses pytest for kernel validation.`
const QUESTION = `For synthetic project ${PROJECT_CODE}, what CUDA runtime and test framework validate the kernels?`
const root = process.cwd()
const paths = resolveTestPaths(root)
const reportRoot = paths.reportRoot
const reportPath = join(reportRoot, `online-harness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
const report = {
  task: 'online-engine-isolated-smoke',
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
  config: {},
  sdk: {},
  cli: {},
  cleanup: { temporaryRunRemoved: false, ownedWorkersStarted: 0, ownedWorkersStopped: 0 },
}

let runDir
let modelEnv = Object.create(null)
let exitCode = 1
let currentPhase = 'configuration'
let preserveRunDir = false
let untrackedCleanupPending = false
const ownedWorkers = new Set()
const pendingChildren = new Set()
const check = (id, ok, detail = {}) => report.checks.push({ id, ok: Boolean(ok), ...detail })

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

async function runSdkProbe(dataDir, settings) {
  const env = createIsolatedEnv(process.env, modelEnv, {
    dataDir,
    bundleDir: paths.bundleDir,
    pythonPath: paths.pythonPath,
  })
  const worker = await startIsolatedWorker({
    pythonPath: paths.pythonPath,
    bundleDir: paths.bundleDir,
    dataDir,
    env,
    modelPolicy: settings.models,
  })
  ownedWorkers.add(worker)
  report.cleanup.ownedWorkersStarted++
  let workerStopped = false
  try {
    const health = await worker.request('/v1/health', undefined, 10_000)
    const expectedDims = Number(modelEnv.MEMORY_EMBEDDING_DIMS)
    check('SDK-HEALTH', health.ok === true && health.engine === 'hy-memory' && health.engineVersion === '2.0.4', {
      engine: health.engine,
      version: health.engineVersion,
      ready: health.ok === true,
    })
    check('SDK-DIMS', health.embeddingDims === expectedDims && health.embeddingDims > 0, {
      expected: expectedDims,
      actual: health.embeddingDims,
    })
    await worker.request('/v1/ingest', {
      jobId: 'online-harness-sdk-probe',
      namespace: `project:${PROJECT_CODE}`,
      workspaceId: `workspace:${PROJECT_CODE}`,
      scene: 'chat',
      messages: [
        { role: 'user', content: FACT },
        { role: 'assistant', content: 'I recorded the synthetic project fact.' },
      ],
      toolOutcomes: [],
      observedAt: new Date().toISOString(),
    })
    await worker.request('/v1/search', {
      namespace: `project:${PROJECT_CODE}`,
      workspaceId: `workspace:${PROJECT_CODE}`,
      query: `What CUDA runtime and test framework validate project ${PROJECT_CODE} kernels?`,
      limit: 3,
    })
    const metrics = await worker.request('/v1/metrics', undefined, 10_000)
    const calls = metrics.calls ?? {}
    const chatCompletions = metricValue(calls.chatCompletions)
    const embeddings = metricValue(calls.embeddings)
    const errors = metricValue(metrics.errors)
    const providerTokenUsage = providerUsageFromMetrics(metrics)
    report.sdk = {
      engine: health.engine,
      version: health.engineVersion,
      embeddingDims: health.embeddingDims,
      metrics: {
        metricKind: 'adapter_attempt_counters',
        chatCompletions,
        embeddings,
        errors,
        providerTokenUsage,
      },
    }
    check('SDK-ADAPTER-COUNTERS', chatCompletions !== null && chatCompletions > 0 && embeddings !== null && embeddings > 0 && errors === 0, {
      chatCompletions: report.sdk.metrics.chatCompletions,
      embeddings: report.sdk.metrics.embeddings,
      errors: report.sdk.metrics.errors,
    })
  } finally {
    workerStopped = await worker.stop()
    if (workerStopped) {
      report.cleanup.ownedWorkersStopped++
      ownedWorkers.delete(worker)
    }
  }
  if (!workerStopped) {
    const error = new Error('owned SDK worker could not be stopped')
    error.cleanupPending = true
    throw error
  }
}

async function semanticOnlySearch(moduleUrl, dataDir, settings) {
  const env = createIsolatedEnv(process.env, modelEnv, {
    dataDir,
    bundleDir: paths.bundleDir,
    pythonPath: paths.pythonPath,
  })
  const worker = await startIsolatedWorker({
    pythonPath: paths.pythonPath,
    bundleDir: paths.bundleDir,
    dataDir,
    env,
    modelPolicy: settings.models,
  })
  ownedWorkers.add(worker)
  report.cleanup.ownedWorkersStarted++
  let workerStopped = false
  let outcome
  let failure
  try {
    outcome = await searchHostSemantically(moduleUrl, { root, dataDir, worker, query: QUESTION, timeoutMs: 2500 })
  } catch (error) {
    failure = error
  } finally {
    workerStopped = await worker.stop()
    if (workerStopped) {
      report.cleanup.ownedWorkersStopped++
      ownedWorkers.delete(worker)
    }
  }
  if (!workerStopped) {
    const error = new Error('owned semantic worker could not be stopped')
    error.cleanupPending = true
    throw error
  }
  if (failure) throw failure
  return outcome
}

async function main() {
  try {
  mkdirSync(reportRoot, { recursive: true })
  const firstConfig = applyModelRequestLimits(validateModelEnv(loadModelEnvFile(paths.sourceEnvFile)))
  const secondConfig = applyModelRequestLimits(validateModelEnv(loadModelEnvFile(paths.sourceEnvFile)))
  const sourceBehaviorControls = loadSafeSourceControls(paths.sourceEnvFile)
  const configHashRead1 = configurationHash(firstConfig)
  const configHashRead2 = configurationHash(secondConfig)
  modelEnv = firstConfig
  report.config = {
    hashRead1: configHashRead1,
    hashRead2: configHashRead2,
    unchangedBetweenReads: configHashRead1 === configHashRead2,
    sourceEnvValuesRecorded: false,
    sourceBehaviorControls,
    sourceBehaviorControlsPassedToChild: false,
    effectiveModelConfig: safeEffectiveModelConfig(firstConfig),
  }
  check('CONFIG-STABLE', report.config.unchangedBetweenReads)
  if (!report.config.unchangedBetweenReads) throw new Error('model configuration changed between the two startup reads')

  if (!existsSync(join(paths.bundleDir, 'cli.js')) || !existsSync(join(paths.bundleDir, 'python', 'hymem_worker'))) {
    throw new Error('configured bundle is incomplete')
  }
  if (!existsSync(paths.pythonPath)) throw new Error('configured SDK Python interpreter is unavailable')
  const runDirPrefix = join(tmpdir(), 'hymem-online-harness-')
  runDir = mkdtempSync(runDirPrefix)
  const cliDataDir = join(runDir, 'cli-data')
  const probeDataDir = join(runDir, 'sdk-probe-data')
  mkdirSync(cliDataDir, { recursive: true })
  mkdirSync(probeDataDir, { recursive: true })
  writeModelEnvFile(join(cliDataDir, 'memory-engine.env'), modelEnv)
  writeModelEnvFile(join(probeDataDir, 'memory-engine.env'), modelEnv)

  const runtimeUrl = await compileOnlineRuntimeModule(root, runDir)
  const cliSettings = await authorizeIsolatedDatabase(runtimeUrl, join(cliDataDir, 'governance.db'))
  const probeSettings = await authorizeIsolatedDatabase(runtimeUrl, join(probeDataDir, 'governance.db'))
  check('EGRESS-AUDIT', cliSettings.auditValid && probeSettings.auditValid &&
    cliSettings.models.externalEgress === 'allow-configured' && cliSettings.models.localOnly === false &&
    probeSettings.models.externalEgress === 'allow-configured' && probeSettings.models.localOnly === false,
  { actor: cliSettings.actor, audited: true })

  const isolatedEnv = createIsolatedEnv(process.env, modelEnv, {
    dataDir: cliDataDir,
    bundleDir: paths.bundleDir,
    pythonPath: paths.pythonPath,
  })
  const nodeVersion = await runCommand(paths.nodePath, ['--version'], { cwd: root, env: isolatedEnv, timeoutMs: 10_000 })
  const pythonVersion = await runCommand(paths.pythonPath, ['--version'], { cwd: paths.bundleDir, env: isolatedEnv, timeoutMs: 10_000 })
  report.runtime = {
    node: nodeVersion.stdout.trim().slice(0, 40),
    python: `${pythonVersion.stdout}${pythonVersion.stderr}`.trim().slice(0, 80),
  }
  check('RUNTIMES', nodeVersion.code === 0 && pythonVersion.code === 0 && !nodeVersion.timedOut && !pythonVersion.timedOut)

  currentPhase = 'sdk-probe'
  await runSdkProbe(probeDataDir, probeSettings)

  currentPhase = 'cli-capture'
  const cliPath = join(paths.bundleDir, 'cli.js')
  const capture = await runCommand(paths.nodePath, [cliPath, 'capture', '--engine', 'hy', '--json', '--data-dir', cliDataDir, '--session', 'online-harness-capture', '--text', FACT], {
    cwd: root,
    env: isolatedEnv,
    timeoutMs: 120_000,
  })
  const captured = capture.code === 0 && !capture.timedOut ? parseJson(capture.stdout) : null
  const created = captured?.created ?? []
  const createdIds = Array.isArray(created) ? created.filter(item => typeof item === 'string') : []
  report.cli.capture = {
    exitCode: capture.code,
    timedOut: capture.timedOut,
    createdCount: createdIds.length,
    createdIds: createdIds.slice(0, 5),
    httpStatus: extractHttpStatus(capture.stderr),
  }
  check('CLI-CAPTURE', capture.code === 0 && !capture.timedOut && !capture.spawnFailed && createdIds.length > 0, {
    createdCount: report.cli.capture.createdCount,
  })
  if (!(capture.code === 0 && !capture.timedOut && !capture.spawnFailed && createdIds.length > 0)) {
    throw new Error(commandFailure(capture, 'isolated CLI capture'))
  }

  currentPhase = 'cli-search'
  const search = await runCommand(paths.nodePath, [cliPath, 'search', '--engine', 'hy', '--json', '--data-dir', cliDataDir, '--query', QUESTION], {
    cwd: root,
    env: isolatedEnv,
    timeoutMs: 120_000,
  })
  const searched = search.code === 0 && !search.timedOut ? parseJson(search.stdout) : null
  report.cli.search = {
    exitCode: search.code,
    timedOut: search.timedOut,
    httpStatus: extractHttpStatus(search.stderr),
    clues: searched?.clues?.length ?? 0,
    degraded: searched?.degraded ?? null,
    tokenCount: searched?.tokenCount ?? 0,
    elapsedMs: searched?.elapsedMs ?? null,
    clueStatuses: (searched?.clues ?? []).map(clue => ({ status: clue.status, evidenceCount: clue.evidenceCount })),
    wrapperPresent: String(searched?.rendered ?? '').startsWith('<memory_clues provenance="untrusted-retrieved-data"'),
  }
  check('CLI-RECALL', search.code === 0 && !search.timedOut && !search.spawnFailed && report.cli.search.clues > 0, { clues: report.cli.search.clues })
  check('CLI-NONDEGRADED', searched?.degraded === null || searched?.degraded === undefined, { degraded: searched?.degraded ?? null })
  check('CLI-BUDGET', report.cli.search.tokenCount > 0 && report.cli.search.tokenCount <= 600, { tokenCount: report.cli.search.tokenCount })
  check('CLI-LATENCY', typeof report.cli.search.elapsedMs === 'number' && report.cli.search.elapsedMs < 2500, { elapsedMs: report.cli.search.elapsedMs })
  check('CLI-EVIDENCE-GATE', report.cli.search.clueStatuses.length > 0 &&
    report.cli.search.clueStatuses.every(item => item.status !== 'verified') &&
    report.cli.search.clueStatuses.some(item => item.evidenceCount >= 1), { clueStatuses: report.cli.search.clueStatuses })
  check('CLI-SAFETY-WRAPPER', report.cli.search.wrapperPresent)

  currentPhase = 'cli-status'
  const status = await runCommand(paths.nodePath, [cliPath, 'status', '--json', '--data-dir', cliDataDir], {
    cwd: root,
    env: isolatedEnv,
    timeoutMs: 30_000,
  })
  const statusJson = status.code === 0 ? parseJson(status.stdout) : null
  check('CLI-AUDIT', status.code === 0 && !status.spawnFailed && statusJson?.audit?.valid === true, { valid: statusJson?.audit?.valid === true, httpStatus: extractHttpStatus(status.stderr) })

  currentPhase = 'host-semantic-only'
  const semantic = await semanticOnlySearch(runtimeUrl, cliDataDir, cliSettings)
  report.semanticOnly = {
    mode: 'semantic',
    keywordChannelUsed: false,
    clues: semantic.clues.length,
    citationIds: semantic.clues.map(clue => clue.memoryId),
    degraded: semantic.degraded,
    tokenCount: semantic.tokenCount,
    elapsedMs: semantic.elapsedMs,
  }
  check('HOST-SEMANTIC-ONLY', semantic.clues.length > 0 && semantic.degraded === null && semantic.tokenCount <= 600, {
    clues: semantic.clues.length,
    degraded: semantic.degraded,
    tokenCount: semantic.tokenCount,
  })

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
    } catch { /* final cleanup evidence is evaluated below */ }
  }
  for (const child of pendingChildren) {
    try {
      if (await stopOwnedChild(child)) pendingChildren.delete(child)
    } catch { /* keep the run directory if process closure is unknown */ }
  }
  preserveRunDir = untrackedCleanupPending || ownedWorkers.size > 0 || pendingChildren.size > 0
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
