import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export function summarizeResults(results) {
  const passed = results.filter(item => item.status === 'pass').length
  const skipped = results.filter(item => item.status === 'skipped' || item.status === 'missing').length
  const failed = results.length - passed - skipped

  return {
    passed,
    failed,
    skipped,
    ok: results.length > 0 && passed === results.length,
  }
}

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'HYMEM_BUNDLE_DIR',
])

export function isolatedChildEnv(source, { dataDir, studioUrl, python, bundleDir, workerPid, workerPort, workerTokenFile, studioPid }) {
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => SAFE_ENV_KEYS.has(key.toUpperCase()) && value !== undefined),
  )
  env.HYMEM_DATA_DIR = dataDir
  env.HYMEM_STUDIO_URL = studioUrl
  env.HYMEM_PYTHON = python
  if (bundleDir !== undefined) env.HYMEM_BUNDLE_DIR = bundleDir
  env.HYMEM_E2E_ISOLATED = '1'
  if (workerPid !== undefined) env.HYMEM_OWNED_WORKER_PID = String(workerPid)
  if (workerPort !== undefined) env.HYMEM_OWNED_WORKER_PORT = String(workerPort)
  if (workerTokenFile !== undefined) env.HYMEM_OWNED_WORKER_TOKEN_FILE = workerTokenFile
  if (studioPid !== undefined) env.HYMEM_OWNED_STUDIO_PID = String(studioPid)
  if (workerPid !== undefined) env.HYMEM_OWNED_WORKER_ENGINE = 'mock'
  return env
}

function defaultPython(root) {
  const local = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
  return existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3'
}

export function seedMockStudio(root, environment, run = spawnSync) {
  const dataDir = environment.HYMEM_DATA_DIR ?? ''
  if (environment.HYMEM_E2E_ISOLATED !== '1' || environment.HYMEM_OWNED_WORKER_ENGINE !== 'mock' || !basename(resolve(dataDir)).startsWith('hymem-e2e-')) {
    return { ok: false, reason: 'mock fixture seeding requires the runner-owned isolated data directory' }
  }
  const cliPath = join(environment.HYMEM_BUNDLE_DIR ?? join(root, 'dist', 'bundle'), 'cli.js')
  const child = run(process.execPath, [
    cliPath,
    'capture',
    '--text',
    'Please remember this repository uses the isolated mock E2E fixture for UI coverage.',
    '--session',
    'isolated-e2e-ui-fixture',
    '--json',
    '--engine',
    'mock',
    '--data-dir',
    dataDir,
  ], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  let payload
  try {
    payload = JSON.parse(child.stdout ?? '')
  } catch {
    payload = null
  }
  const ok = child.status === 0 && payload?.ok !== false && Array.isArray(payload?.created) && payload.created.length > 0
  return {
    ok,
    ...(ok ? {} : { reason: `fixture capture did not create a memory (exit ${child.status ?? child.error?.code ?? child.signal ?? 'unknown'})` }),
  }
}

function allocateFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => (error ? rejectPort(error) : resolvePort(port)))
    })
  })
}

function parseServePayload(output) {
  try {
    const payload = JSON.parse(output)
    if (payload?.command !== 'serve' || payload?.ok !== true) return null
    return {
      workerPid: Number.isSafeInteger(payload.workerPid) ? payload.workerPid : undefined,
      workerPort: Number.isSafeInteger(payload.workerPort) ? payload.workerPort : undefined,
      workerTokenFile: typeof payload.workerTokenFile === 'string' ? payload.workerTokenFile : undefined,
      engine: payload.engine,
    }
  } catch {
    return null
  }
}

function isOwnedWorkerTokenPath(dataDir, tokenPath) {
  if (typeof dataDir !== 'string' || typeof tokenPath !== 'string' || tokenPath.length === 0) return false
  const normalizedDataDir = resolve(dataDir)
  const normalizedTokenPath = resolve(tokenPath)
  const uuidTokenName = /^worker-token-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return dirname(normalizedTokenPath) === normalizedDataDir && uuidTokenName.test(basename(normalizedTokenPath))
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

export async function waitForStudioReady(child, studioUrl, dataDir, {
  timeoutMs = 45_000,
  fetchImpl = fetch,
  onReadiness,
} = {}) {
  let stdout = ''
  let stderr = ''
  let spawnError
  child.once('error', error => {
    spawnError = error
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => {
    stdout = `${stdout}${chunk}`.slice(-64_000)
  })
  child.stderr?.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-16_000)
  })
  const tokenPath = join(dataDir, 'ui-token')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`could not start mock Studio: ${spawnError.code ?? spawnError.message}`)
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`mock Studio exited before readiness (${child.exitCode ?? child.signalCode}): ${stderr.slice(-2000)}`)
    }
    const payload = parseServePayload(stdout)
    if (payload) {
      if (
        !payload.workerPid ||
        !payload.workerPort ||
        payload.engine?.engine !== 'mock' ||
        !isOwnedWorkerTokenPath(dataDir, payload.workerTokenFile)
      ) {
        throw new Error('mock Studio readiness did not include an owned mock worker PID, port, and token-file path')
      }
      onReadiness?.(payload)
      let uiToken = ''
      try {
        uiToken = readFileSync(tokenPath, 'utf8').trim()
      } catch {
        // The UI token is created during startup; retry until it is ready.
      }
      if (!uiToken) {
        await delay(100)
        continue
      }
      let health
      try {
        const login = await fetchImpl(`${studioUrl}/studio/?token=${encodeURIComponent(uiToken)}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(1500),
        })
        const session = login.headers?.get('set-cookie')?.split(';')[0]
        if (login.status === 302 && session) {
          const response = await fetchImpl(`${studioUrl}/api/health`, {
            headers: { cookie: session },
            signal: AbortSignal.timeout(1500),
          })
          if (response.status === 200) health = await response.json()
        }
      } catch {
        // The server can emit its startup record just before the socket is reachable.
      }
      if (health) {
        const expectedDataDir = resolve(dataDir)
        const reportedDataDir = typeof health.plugin?.dataDir === 'string' ? resolve(health.plugin.dataDir) : ''
        const sameDataDir = process.platform === 'win32'
          ? reportedDataDir.toLowerCase() === expectedDataDir.toLowerCase()
          : reportedDataDir === expectedDataDir
        if (!sameDataDir || health.worker?.engine !== 'mock') {
          throw new Error('Studio health did not confirm the runner-owned data directory and mock engine')
        }
        return payload
      }
    }
    await delay(100)
  }

  throw new Error(`mock Studio did not become ready within ${timeoutMs} ms: ${stderr.slice(-2000)}`)
}

function waitForClose(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolveClose => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      resolveClose(false)
    }, milliseconds)
    const onClose = () => {
      clearTimeout(timer)
      resolveClose(true)
    }
    child.once('close', onClose)
  })
}

export async function stopOwnedStudioTree(child, { platform = process.platform, kill = process.kill, runTaskkill = execFileSync } = {}) {
  if (!child || child.pid === undefined) return

  if (platform === 'win32') {
    try {
      runTaskkill('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      if (await waitForClose(child, 500)) return
      throw error
    }
    if (!(await waitForClose(child, 5000))) throw new Error('runner-owned Studio process tree did not close after taskkill')
    return
  }

  const groupAlive = () => {
    try {
      kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      throw error
    }
  }
  try {
    kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  const gracefulDeadline = Date.now() + 5000
  while (groupAlive() && Date.now() < gracefulDeadline) await delay(50)
  if (groupAlive()) {
    try {
      kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
    const forceDeadline = Date.now() + 2000
    while (groupAlive() && Date.now() < forceDeadline) await delay(50)
    if (groupAlive()) throw new Error('runner-owned Studio process group did not close after SIGKILL')
  }
  if (!(await waitForClose(child, 2000))) throw new Error('runner-owned Studio process did not close after termination')
}

export async function stopOwnedMockWorker({
  isolated,
  engine,
  dataDir,
  workerPid: workerPidValue,
  workerPort: workerPortValue,
  studioPid: studioPidValue,
  currentPid = process.pid,
  tokenPath,
  kill = process.kill,
  fetchImpl = fetch,
  allowAlreadyExited = false,
  timeoutMs = 5000,
  pollIntervalMs = 50,
}) {
  const normalizedDataDir = typeof dataDir === 'string' ? resolve(dataDir) : ''
  const workerPid = Number(workerPidValue)
  const workerPort = Number(workerPortValue)
  const studioPid = Number(studioPidValue)
  if (isolated !== '1' || !basename(normalizedDataDir).startsWith('hymem-e2e-')) {
    return { ok: false, reason: 'worker fault injection requires a runner-owned temporary data directory' }
  }
  if (engine !== 'mock') return { ok: false, reason: 'worker fault injection requires the mock engine' }
  if (!Number.isSafeInteger(workerPid) || workerPid <= 1 || workerPid === studioPid || workerPid === currentPid) {
    return { ok: false, reason: 'runner did not provide a distinct positive worker PID' }
  }
  if (!Number.isSafeInteger(workerPort) || workerPort <= 0 || workerPort > 65535) {
    return { ok: false, reason: 'runner did not provide the owned worker port' }
  }
  if (!Number.isSafeInteger(studioPid) || studioPid <= 1) {
    return { ok: false, reason: 'runner did not provide a positive Studio PID' }
  }
  if (!isOwnedWorkerTokenPath(normalizedDataDir, tokenPath)) {
    return { ok: false, reason: 'worker token path must be a worker-token UUID file directly inside the runner-owned data directory' }
  }

  let token
  try {
    const tokenStat = lstatSync(tokenPath)
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink()) {
      return { ok: false, reason: 'runner-owned worker token path is not a regular file' }
    }
    token = readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return { ok: false, reason: 'runner-owned worker token file is unavailable' }
  }
  if (!token) return { ok: false, reason: 'runner-owned worker token file is empty' }

  const evidence = {
    workerPid,
    workerPort,
    studioPid,
    engine,
    dataDir: normalizedDataDir,
    tokenFile: resolve(tokenPath),
    tokenSha256: createHash('sha256').update(token).digest('hex'),
  }
  try {
    kill(workerPid, 0)
  } catch (error) {
    if (allowAlreadyExited && error?.code === 'ESRCH') return { ok: true, alreadyExited: true, evidence: { ...evidence, exited: true } }
    return { ok: false, reason: 'runner-reported worker PID is no longer alive', evidence }
  }

  try {
    const response = await fetchImpl(`http://127.0.0.1:${workerPort}/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    })
    const health = await response.json()
    if (response.status !== 200 || health?.engine !== 'mock') {
      return { ok: false, reason: 'worker token and port did not identify the runner-owned mock service', evidence }
    }
  } catch {
    return { ok: false, reason: 'worker token and port could not verify the runner-owned mock service', evidence }
  }

  let signal = 'SIGTERM'
  try {
    kill(workerPid, signal)
  } catch (error) {
    return { ok: false, reason: `could not stop runner-owned mock worker (${error?.code ?? 'kill failed'})`, evidence }
  }

  const hasExited = () => {
    try {
      kill(workerPid, 0)
      return false
    } catch (error) {
      if (error?.code === 'ESRCH') return true
      throw error
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasExited()) return { ok: true, evidence: { ...evidence, signal, exited: true } }
    await delay(pollIntervalMs)
  }

  signal = 'SIGKILL'
  try {
    kill(workerPid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      return { ok: false, reason: `could not force-stop runner-owned mock worker (${error?.code ?? 'kill failed'})`, evidence }
    }
  }
  const forceDeadline = Date.now() + Math.max(100, Math.min(timeoutMs, 2000))
  while (Date.now() < forceDeadline) {
    if (hasExited()) return { ok: true, evidence: { ...evidence, signal, exited: true } }
    await delay(pollIntervalMs)
  }
  return { ok: false, reason: 'runner-owned mock worker did not exit after termination', evidence: { ...evidence, signal } }
}

export async function withIsolatedStudio(options, run) {
  const {
    root,
    environment = process.env,
    python = environment.HYMEM_PYTHON ?? defaultPython(root),
    bundleDir = environment.HYMEM_BUNDLE_DIR ?? join(root, 'dist', 'bundle'),
    createTempDir = prefix => mkdtempSync(join(tmpdir(), prefix)),
    removeTempDir = path => rmSync(path, { recursive: true, force: true }),
    getPort = allocateFreePort,
    spawnProcess = spawn,
    waitForReady = waitForStudioReady,
    stopWorker = stopOwnedMockWorker,
    stopProcess = stopOwnedStudioTree,
  } = options

  const dataDir = createTempDir('hymem-e2e-')
  let child
  let readiness
  let result
  let runError
  try {
    const port = await getPort()
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ephemeral Studio port: ${port}`)
    const studioUrl = `http://127.0.0.1:${port}`
    const cliPath = join(bundleDir, 'cli.js')
    const childEnv = isolatedChildEnv(environment, { dataDir, studioUrl, python, bundleDir })
    child = spawnProcess(process.execPath, [cliPath, 'serve', '--engine', 'mock', '--ui-port', String(port), '--data-dir', dataDir, '--json'], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const ready = await waitForReady(child, studioUrl, dataDir, {
      onReadiness: payload => { readiness = payload },
    })
    readiness ??= ready
    if (
      !readiness?.workerPid ||
      !readiness?.workerPort ||
      readiness.engine?.engine !== 'mock' ||
      !isOwnedWorkerTokenPath(dataDir, readiness.workerTokenFile)
    ) {
      throw new Error('mock Studio did not report an owned mock worker PID, port, and token-file path')
    }
    const suiteEnv = isolatedChildEnv(environment, {
      dataDir,
      studioUrl,
      python,
      bundleDir,
      workerPid: readiness.workerPid,
      workerPort: readiness.workerPort,
      workerTokenFile: readiness.workerTokenFile,
      studioPid: child.pid,
    })
    result = await run({
      dataDir,
      studioUrl,
      workerPid: readiness.workerPid,
      workerPort: readiness.workerPort,
      workerTokenFile: readiness.workerTokenFile,
      studioPid: child.pid,
      env: suiteEnv,
    })
  } catch (error) {
    runError = error
  }

  let cleanupError
  try {
    if (child && readiness) {
      const cleanup = await stopWorker({
        isolated: '1',
        engine: 'mock',
        dataDir,
        workerPid: readiness.workerPid,
        workerPort: readiness.workerPort,
        tokenPath: readiness.workerTokenFile,
        studioPid: child.pid,
        allowAlreadyExited: true,
      })
      if (!cleanup.ok) throw new Error(cleanup.reason ?? 'could not clean up runner-owned mock worker')
    }
  } catch (error) {
    cleanupError = error
  }
  try {
    if (child) await stopProcess(child)
  } catch (error) {
    cleanupError ??= error
  }
  try {
    removeTempDir(dataDir)
  } catch (error) {
    cleanupError ??= error
  }
  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], 'isolated Studio run and cleanup both failed')
  }
  if (runError) throw runError
  if (cleanupError) throw cleanupError
  return result
}
