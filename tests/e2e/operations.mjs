/**
 * Operational E2E against the runner-owned mock Studio: backup/restore,
 * tombstone preservation, and memory reads while the owned worker is down.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, relative, isAbsolute } from 'node:path'
import { stopOwnedMockWorker } from '../../scripts/e2e-runner.mjs'

const base = process.env.HYMEM_STUDIO_URL ?? ''
const dataDir = process.env.HYMEM_DATA_DIR ?? ''
const bundleDir = process.env.HYMEM_BUNDLE_DIR ?? join(process.cwd(), 'dist', 'bundle')
const workerTokenFile = process.env.HYMEM_OWNED_WORKER_TOKEN_FILE ?? ''
const cli = join(bundleDir, 'cli.js')
const node = process.execPath

function runnerConfigurationError() {
  if (process.env.HYMEM_E2E_ISOLATED !== '1') return 'operations requires the isolated E2E runner'
  if (!dataDir || !basename(resolve(dataDir)).startsWith('hymem-e2e-')) return 'operations requires a runner-owned temporary data directory'
  if (process.env.HYMEM_OWNED_WORKER_ENGINE !== 'mock') return 'operations requires the runner-owned mock worker'
  if (!Number.isSafeInteger(Number(process.env.HYMEM_OWNED_WORKER_PID))) return 'operations requires the runner-reported worker PID'
  if (!Number.isSafeInteger(Number(process.env.HYMEM_OWNED_WORKER_PORT))) return 'operations requires the runner-reported worker port'
  if (!Number.isSafeInteger(Number(process.env.HYMEM_OWNED_STUDIO_PID))) return 'operations requires the runner-reported Studio PID'
  try {
    const url = new URL(base)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return 'operations only accepts the runner-owned loopback Studio URL'
  } catch {
    return 'operations requires the runner-owned loopback Studio URL'
  }
  if (!existsSync(join(dataDir, 'ui-token')) || !workerTokenFile || !existsSync(workerTokenFile)) return 'runner-owned UI and worker token files are missing'
  return null
}

const configError = runnerConfigurationError()
if (configError) {
  const results = [{ id: 'RUNNER', name: 'isolated runner ownership is required', ok: false, detail: configError }]
  console.log(JSON.stringify({ ok: false, total: results.length, failed: results.length, results }, null, 2))
  process.exit(1)
}

const token = readFileSync(join(dataDir, 'ui-token'), 'utf8').trim()
let cookie = ''
async function call(path, options = {}) {
  const headers = { ...options.headers }
  if (cookie) headers.cookie = cookie
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.method && options.method !== 'GET') headers['x-hymemory-csrf'] = token
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, ok: Boolean(ok), detail })
  if (!ok) process.stderr.write(`FAIL ${id} ${name}: ${String(JSON.stringify(detail ?? '')).slice(0, 300)}\n`)
}

function runCli(args, timeout = 120_000) {
  const child = spawnSync(node, [cli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  let payload = null
  try {
    payload = JSON.parse(child.stdout ?? '')
  } catch {
    payload = null
  }
  return { status: child.status, signal: child.signal, error: child.error, stdout: child.stdout ?? '', stderr: child.stderr ?? '', payload }
}

function isWithin(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

await call(`/studio/?token=${encodeURIComponent(token)}`)

// Establish one tombstone in this private store so restore/reindex have a real
// deleted record to preserve rather than trusting a dry-run message.
const capture = runCli([
  'capture',
  '--text',
  'Please remember this repo pins CUDA 12.4 and uses pytest for the kernel tests.',
  '--session',
  'operations-tombstone-seed',
  '--json',
  '--engine',
  'mock',
  '--data-dir',
  dataDir,
])
const tombstoneId = capture.payload?.created?.[0]
check('E2E-18seed', 'a mock capture creates a memory for the tombstone round trip', capture.status === 0 && typeof tombstoneId === 'string', {
  exit: capture.status,
  created: capture.payload?.created?.length,
  error: capture.error?.code,
  stderr: capture.stderr.slice(-300),
})

let tombstoneCreated = false
if (typeof tombstoneId === 'string') {
  const detail = await call(`/api/memories/${encodeURIComponent(tombstoneId)}`)
  const revision = detail.body?.memory?.revision
  const deleted = await call(`/api/memories/${encodeURIComponent(tombstoneId)}/transition`, {
    method: 'POST',
    body: { to: 'deleted', reason: 'isolated E2E tombstone preservation', expectedRevision: revision },
  })
  tombstoneCreated = detail.status === 200 && deleted.status === 200 && deleted.body?.memory?.status === 'deleted'
  check('E2E-18delete', 'the seeded memory becomes a tombstone in the isolated store', tombstoneCreated, {
    detail: detail.status,
    transition: deleted.status,
    status: deleted.body?.memory?.status,
  })
}

const before = await call('/api/overview')
const backup = await call('/api/backup', { method: 'POST', body: {} })
const backupPath = typeof backup.body?.path === 'string' ? backup.body.path : ''
const backupIsOwned = backupPath !== '' && isWithin(dataDir, backupPath)
let backupHashMatches = false
if (backupIsOwned && existsSync(backupPath)) {
  const digest = createHash('sha256').update(readFileSync(backupPath)).digest('hex')
  backupHashMatches = typeof backup.body.sha256 === 'string' && digest === backup.body.sha256
}
check('E2E-18a', 'backup is written inside the isolated data directory with a matching SHA-256',
  backup.status === 200 && backupIsOwned && backupHashMatches,
  { status: backup.status, owned: backupIsOwned, hashMatches: backupHashMatches },
)

const restored = mkdtempSync(join(tmpdir(), 'hymem-restore-'))
try {
  const target = join(restored, 'governance.db')
  const restore = backupIsOwned
    ? runCli(['restore', '--source', backupPath, '--data-dir', restored, '--json'])
    : { status: 1, payload: null, stdout: '', stderr: 'backup is outside the isolated data directory' }
  const status = runCli(['status', '--json', '--data-dir', restored])
  const parsed = status.payload
  check(
    'E2E-18b',
    'restore creates the explicit absent database and preserves counts and the audit chain',
    restore.status === 0 && restore.payload?.ok === true && existsSync(target) && status.status === 0 &&
      parsed?.counts?.total === before.body.counts?.total && parsed?.audit?.valid === true,
    { restoreExit: restore.status, statusExit: status.status, databaseCreated: existsSync(target), restored: parsed?.counts?.total, original: before.body.counts?.total, audit: parsed?.audit?.valid },
  )

  const reindex = runCli(['reindex', '--json', '--data-dir', restored])
  const afterReindex = runCli(['status', '--json', '--data-dir', restored])
  check(
    'E2E-18c',
    'a real reindex keeps the deleted record tombstoned and excluded from live counts',
    tombstoneCreated && reindex.status === 0 && reindex.payload?.ok === true && reindex.payload?.dryRun === false &&
      reindex.payload?.tombstones === 1 && reindex.payload?.memories === before.body.counts?.total &&
      afterReindex.status === 0 && afterReindex.payload?.counts?.total === before.body.counts?.total &&
      afterReindex.payload?.audit?.valid === true,
    {
      exit: reindex.status,
      dryRun: reindex.payload?.dryRun,
      memories: reindex.payload?.memories,
      tombstones: reindex.payload?.tombstones,
      finalCount: afterReindex.payload?.counts?.total,
      audit: afterReindex.payload?.audit?.valid,
    },
  )
} finally {
  rmSync(restored, { recursive: true, force: true })
}

// E2E-17: this runner always starts the isolated mock backend, and the API
// reports its actual engine and health state.
const health = await call('/api/health')
const worker = health.body?.worker ?? {}
check(
  'E2E-17',
  'health identifies the isolated mock engine',
  health.status === 200 && worker.engine === 'mock' && worker.ok === true,
  { engine: worker.engine, ok: worker.ok, degraded: worker.degraded },
)

// E2E-08: stop only the PID returned by this runner's serve process. The
// worker token hash and isolated directory are retained as ownership evidence.
const fault = await stopOwnedMockWorker({
  isolated: process.env.HYMEM_E2E_ISOLATED,
  engine: process.env.HYMEM_OWNED_WORKER_ENGINE,
  dataDir,
  tokenPath: workerTokenFile,
  workerPid: process.env.HYMEM_OWNED_WORKER_PID,
  workerPort: process.env.HYMEM_OWNED_WORKER_PORT,
  studioPid: process.env.HYMEM_OWNED_STUDIO_PID,
})
check('E2E-08p', 'worker fault injection stops only the runner-owned mock PID', fault.ok, fault.evidence ?? { reason: fault.reason })

if (fault.ok) {
  const observations = []
  for (let attempt = 0; attempt < 12; attempt++) {
    const probe = await call('/api/health')
    observations.push({
      status: probe.status,
      degraded: probe.body?.degraded,
      workerOk: probe.body?.worker?.ok,
      engine: probe.body?.worker?.engine,
    })
    if (observations.some(item => item.status === 200 && item.workerOk === false)) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  const failedHealth = observations.find(item => item.status === 200 && item.workerOk === false)
  const stillReadable = await call('/api/memories?pageSize=5')
  const stillOverview = await call('/api/overview')
  check(
    'E2E-08a',
    'the Studio remains available and reports its stopped worker as unhealthy',
    Boolean(failedHealth),
    { fault: fault.evidence, first: observations[0], last: observations[observations.length - 1] },
  )
  check(
    'E2E-08b',
    'memory list and overview reads continue while the worker is down',
    stillReadable.status === 200 && stillOverview.status === 200,
    { read: stillReadable.status, overview: stillOverview.status },
  )
}

const failed = results.filter(item => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2))
process.exitCode = failed.length === 0 ? 0 : 1
