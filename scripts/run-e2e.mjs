/**
 * Run the E2E suites against a private mock Studio and aggregate real results.
 * Every run owns its temporary data directory, server process tree and worker.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedChildEnv, seedMockStudio, summarizeResults, withIsolatedStudio } from './e2e-runner.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suiteDefinitions = [
  { name: 'cross-session', file: 'tests/e2e/cross-session.mjs', needsStudio: false },
  { name: 'api-e2e', file: 'tests/e2e/api-e2e.mjs', needsStudio: true },
  { name: 'ui-acceptance', file: 'tests/e2e/ui-acceptance.mjs', needsStudio: true },
  { name: 'ui-roundtrip', file: 'tests/e2e/ui-roundtrip.mjs', needsStudio: true },
  { name: 'operations', file: 'tests/e2e/operations.mjs', needsStudio: true },
]

function pythonFor(root, environment) {
  if (environment.HYMEM_PYTHON) return environment.HYMEM_PYTHON
  const local = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
  return existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3'
}

function parseSuiteReport(output) {
  const text = output.trim()
  if (!text) return null
  const starts = []
  for (let start = text.lastIndexOf('\n{'); start >= 0; start = text.lastIndexOf('\n{', start - 1)) {
    starts.push(start + 1)
  }
  starts.push(0)
  for (const start of starts) {
    try {
      const report = JSON.parse(text.slice(start))
      if (report && typeof report === 'object' && Array.isArray(report.results)) return report
    } catch {
      // Keep looking for the final JSON result after any human-readable logs.
    }
  }
  return null
}

function runSuite(root, suite, environment, { exists = existsSync, spawn = spawnSync } = {}) {
  const path = join(root, suite.file)
  if (!exists(path)) {
    console.error(`\n=== ${suite.name}: MISSING (${suite.file}) ===`)
    return { name: suite.name, status: 'missing' }
  }

  console.log(`\n=== ${suite.name} ===`)
  const started = Date.now()
  try {
    const child = spawn(process.execPath, [path], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 600_000,
      windowsHide: true,
    })
    if (child.stdout) process.stdout.write(child.stdout)
    if (child.stderr) process.stderr.write(child.stderr)
    const report = parseSuiteReport(child.stdout ?? '')
    if (child.status !== 0) {
      return { name: suite.name, status: `fail(${child.status ?? child.signal ?? child.error?.code ?? 'unknown'})`, ms: Date.now() - started }
    }
    if (!report || report.ok !== true) {
      return { name: suite.name, status: 'fail(invalid-or-failed-report)', ms: Date.now() - started }
    }
    const failedChecks = report.results.filter(item => item?.ok === false || item?.status === 'fail').length
    if (failedChecks > 0 || (typeof report.failed === 'number' && report.failed > 0)) {
      return { name: suite.name, status: `fail(${failedChecks || report.failed} checks)`, ms: Date.now() - started }
    }
    const skippedChecks = report.results.filter(item =>
      item?.status === 'skipped' || item?.skipped === true || item?.detail === 'skipped' || item?.detail?.status === 'skipped',
    ).length
    const status = skippedChecks > 0 ? 'skipped' : 'pass'
    return { name: suite.name, status, ms: Date.now() - started }
  } catch (error) {
    process.stderr.write(`${suite.name} could not start: ${error instanceof Error ? error.message : String(error)}\n`)
    return { name: suite.name, status: 'fail(spawn)', ms: Date.now() - started }
  }
}

function runSuites(root, suites, env, { studioReady, failureReason, exists, spawn } = {}) {
  const results = []
  for (const suite of suites) {
    const path = join(root, suite.file)
    if (!exists(path)) {
      console.error(`\n=== ${suite.name}: MISSING (${suite.file}) ===`)
      results.push({ name: suite.name, status: 'missing' })
      continue
    }
    if (suite.needsStudio && !studioReady) {
      console.error(`\n=== ${suite.name}: SKIPPED (${failureReason ?? 'isolated Studio unavailable'}) ===`)
      results.push({ name: suite.name, status: 'skipped' })
      continue
    }
    results.push(runSuite(root, suite, env, { exists, spawn }))
  }
  return results
}

function safeErrorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|token|secret)\s*[:=]\s*)["']?[^"' ,;\r\n]+/gi, '$1[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000)
}

function errorDescription(error) {
  const message = safeErrorText(error)
  if (!(error instanceof AggregateError) || error.errors.length === 0) return message
  const causes = error.errors.map((cause, index) => {
    return `[${index + 1}] ${safeErrorText(cause)}`
  })
  return `${message}: ${causes.join('; ')}`
}

export async function runE2E({
  root = repoRoot,
  environment = process.env,
  suites = suiteDefinitions,
  withStudio = withIsolatedStudio,
  prepareStudio = seedMockStudio,
  exists = existsSync,
  spawn = spawnSync,
} = {}) {
  const results = []
  let suitesStarted = false
  let runEnv
  const python = pythonFor(root, environment)
  const bundleDir = resolve(environment.HYMEM_BUNDLE_DIR ?? join(root, 'dist', 'bundle'))

  try {
    await withStudio({ root, environment, python, bundleDir }, async context => {
      runEnv = context.env
      if (suites.some(suite => suite.file === 'tests/e2e/ui-acceptance.mjs')) {
        const prepared = prepareStudio(root, runEnv, spawn)
        if (!prepared?.ok) throw new Error(prepared?.reason ?? 'mock UI fixture setup failed')
      }
      suitesStarted = true
      results.push(...runSuites(root, suites, runEnv, { studioReady: true, exists, spawn }))
    })
  } catch (error) {
    const detail = errorDescription(error)
    console.error(`\n=== mock-studio: FAIL (${detail}) ===`)
    results.unshift({ name: 'mock-studio', status: 'fail(startup-or-cleanup)' })
    if (suitesStarted) {
      // Suite results are retained; the isolated process cleanup failure makes the run fail.
    } else {
      const fallbackDir = mkdtempSync(join(tmpdir(), 'hymem-e2e-no-studio-'))
      try {
        runEnv = isolatedChildEnv(environment, {
          dataDir: fallbackDir,
          studioUrl: 'http://127.0.0.1:0',
          python,
          bundleDir,
        })
        results.push(...runSuites(root, suites, runEnv, {
          studioReady: false,
          failureReason: 'isolated mock Studio failed to start',
          exists,
          spawn,
        }))
      } finally {
        rmSync(fallbackDir, { recursive: true, force: true })
      }
    }
  }

  const summary = summarizeResults(results)
  console.log('\n=== summary ===')
  for (const item of results) console.log(`  ${item.name.padEnd(16)} ${item.status}${item.ms ? ` (${item.ms} ms)` : ''}`)
  console.log(`  ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (missing suites count as skipped)`)
  return { ...summary, results }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runE2E()
  process.exitCode = result.ok ? 0 : 1
}
