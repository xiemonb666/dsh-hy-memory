import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..', '..')
const DEFAULT_DSH_LAUNCHER = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd',
)
const DEFAULT_NODE = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
)
const DEFAULT_PNPM = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin',
)
const DEFAULT_PYTHON = join(root, '.venv', 'Scripts', 'python.exe')
const DEFAULT_BUNDLE = join(root, 'dist', 'bundle')
const DSH_SOURCE = join(root, '.upstream', 'dsh-src')
const EXPECTED_DSH_SOURCE_SHA = '687f282e8625c6b8d11ff58211a90524be2e4317'

export function redactUrlSecrets(value, secrets = []) {
  let safe = String(value)
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[REDACTED]')
  return safe
    .replace(/([?&]token=)[^&#\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
}

export function parseDshAuthenticatedUrl(line) {
  const match = /dsh web:\s+(https?:\/\/\S+)/i.exec(String(line))
  if (!match) return null
  const url = new URL(match[1])
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('DSH readiness URL must use loopback HTTP')
  }
  const token = url.searchParams.get('token')
  if (!token) throw new Error('DSH readiness URL did not include an in-memory authentication token')
  return { origin: url.origin, token }
}

export function isContainedPath(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertNoPercent(value, label) {
  if (String(value).includes('%')) throw new Error(`${label} contains a percent sign and cannot be passed through Windows cmd.exe`)
}

function sanitizeText(value, secrets = []) {
  return redactUrlSecrets(value, secrets)
    .replace(/\b(?:api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function nowTag() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function portIsReachable(port) {
  return new Promise(resolveReachable => {
    const socket = createServer()
    socket.once('error', () => resolveReachable(true))
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolveReachable(false)))
  })
}

async function chooseFreePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('could not determine a loopback port'))
        return
      }
      server.close(error => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

function verifyBundle(bundleDir) {
  const manifestPath = join(bundleDir, 'SHA256SUMS.json')
  if (!existsSync(manifestPath)) throw new Error('final bundle SHA256SUMS.json is missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.algorithm !== 'sha256' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('final bundle checksum manifest has an unsupported shape')
  }
  const files = Object.entries(manifest.files)
  for (const [relativePath, expected] of files) {
    const fullPath = resolve(bundleDir, ...String(relativePath).split('/'))
    if (!isContainedPath(bundleDir, fullPath) || !existsSync(fullPath)) throw new Error(`bundle manifest path is missing or escapes the bundle: ${relativePath}`)
    const actual = createHash('sha256').update(readFileSync(fullPath)).digest('hex')
    if (actual !== expected) throw new Error(`bundle checksum mismatch: ${relativePath}`)
  }
  return {
    manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    fileCount: files.length,
  }
}

function makeChildEnv(paths, config) {
  const env = Object.create(null)
  const allow = [
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  ]
  for (const name of allow) if (process.env[name] !== undefined) env[name] = process.env[name]
  const pathName = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'Path'
  const originalPath = process.env[pathName] ?? ''
  env[pathName] = [config.pnpmDir, originalPath].filter(Boolean).join(';')
  env.HOME = paths.home
  env.USERPROFILE = paths.home
  env.LOCALAPPDATA = paths.localAppData
  env.APPDATA = paths.appData
  env.TEMP = paths.tempDir
  env.TMP = paths.tempDir
  env.DSH_HOME = paths.dshHome
  env.DSH_AGENTS_HOME = paths.agentsHome
  env.DSH_LAUNCHER = config.dshLauncher
  env.HYMEM_PNPM_DIR = config.pnpmDir
  env.HYMEM_PYTHON = config.pythonPath
  env.HYMEM_DATA_DIR = paths.dataDir
  env.HYMEM_BUNDLE_DIR = config.bundleDir
  env.DSH_WEB_URL = config.webOrigin
  env.DSH_TELEMETRY_DISABLED = '1'
  env.DO_NOT_TRACK = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONPATH = paths.pythonBootstrap
  env.HYMEM_NATIVE_CHILD_PID_FILE = paths.workerPidFile
  env.HYMEM_NATIVE_CHILD_OWNERSHIP_NONCE = config.workerOwnershipNonce
  env.HYMEM_NATIVE_CONTROL_PORT = String(config.controlPort)
  env.HYMEM_NATIVE_CONTROL_NONCE = config.controlNonce
  env.npm_config_userconfig = paths.npmrc
  env.npm_config_cache = paths.npmCache
  env.npm_config_offline = 'true'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.npm_config_store_dir = paths.pnpmStore
  env.PNPM_HOME = paths.pnpmHome
  env.PNPM_STORE_DIR = paths.pnpmStore
  env.PNPM_CONFIG_OFFLINE = 'true'
  return env
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function terminateOwnedTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false, exitCode: null }
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
    return { attempted: true, exitCode: null }
  }
  const taskkill = join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  return await new Promise(resolveResult => {
    const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolveResult({ attempted: true, exitCode: null }))
    child.once('close', code => resolveResult({ attempted: true, exitCode: code }))
  })
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  return Boolean(await predicate())
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function startCapturedChild({ file, args, cwd, env, timeoutMs, artifactDir, label, secrets = [] }) {
  const commandRecord = { label, executable: file, argv: args, cwd, timeoutMs }
  writeJson(join(artifactDir, `command-${label}.json`), commandRecord)
  const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let killState = null
  const maxChars = 1_000_000
  child.stdout?.on('data', chunk => { if (stdout.length < maxChars) stdout += String(chunk).slice(0, maxChars - stdout.length) })
  child.stderr?.on('data', chunk => { if (stderr.length < maxChars) stderr += String(chunk).slice(0, maxChars - stderr.length) })
  const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })))
  const timer = setTimeout(() => {
    timedOut = true
    killState = terminateOwnedTree(child.pid)
  }, timeoutMs)
  const result = closed.then(async ({ code, signal }) => {
    clearTimeout(timer)
    if (killState) await killState
    const safeStdout = sanitizeText(stdout, secrets)
    const safeStderr = sanitizeText(stderr, secrets)
    writeFileSync(join(artifactDir, `stdout-${label}.log`), safeStdout, 'utf8')
    writeFileSync(join(artifactDir, `stderr-${label}.log`), safeStderr, 'utf8')
    const summary = { label, pid: child.pid ?? null, exitCode: code, signal, timedOut, killedOwnedTree: Boolean(killState) }
    writeJson(join(artifactDir, `exit-${label}.json`), summary)
    return { ...summary, stdout: safeStdout, stderr: safeStderr }
  })
  child.once('error', error => { stderr += `spawn error: ${error.message}\n` })
  return { child, pid: child.pid ?? null, closed, result }
}

async function chooseBrowserPath() {
  const { chromium } = await import('playwright')
  const executable = chromium.executablePath()
  if (!existsSync(executable)) throw new Error('Playwright Chromium executable is not installed; refusing to download it')
  const cache = dirname(dirname(executable))
  return { executable, cache }
}

function writeSitecustomize(path) {
  const source = [
    'import json, os, sys',
    'record = os.environ.get("HYMEM_NATIVE_CHILD_PID_FILE")',
    'if record:',
    '    payload = {"pid": os.getpid(), "parentPid": os.getppid(), "executable": os.path.realpath(sys.executable), "ownershipNonce": os.environ.get("HYMEM_NATIVE_CHILD_OWNERSHIP_NONCE")}',
    '    temp = record + ".tmp"',
    '    with open(temp, "w", encoding="utf-8") as out: json.dump(payload, out)',
    '    os.replace(temp, record)',
    '',
  ].join('\n')
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx' })
}

function writeShutdownPlugin(path) {
  const source = [
    "import { createServer } from 'node:http'",
    "export const name = 'native-preview-shutdown'",
    'export function apply(ctx) {',
    "  const exit = ctx.get('appExit')",
    "  const port = Number(process.env.HYMEM_NATIVE_CONTROL_PORT)",
    "  const nonce = process.env.HYMEM_NATIVE_CONTROL_NONCE ?? ''",
    "  if (typeof exit !== 'function' || !Number.isInteger(port) || port < 1024 || !nonce) throw new Error('native preview control is not configured')",
    '  const server = createServer((request, response) => {',
    "    const local = request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::ffff:127.0.0.1'",
    "    if (local && request.method === 'POST' && request.url === '/__native-preview-stop' && request.headers['x-native-preview-nonce'] === nonce) {",
    "      response.writeHead(202, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })",
    "      response.end('accepted')",
    '      setTimeout(() => { exit(0) }, 50).unref()',
    '      return',
    '    }',
    "    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })",
    "    response.end('not found')",
    '  })',
    "  server.listen(port, '127.0.0.1')",
    "  ctx.effect(() => () => new Promise(resolve => { if (!server.listening) return resolve(); server.close(() => resolve()) }), 'native-preview-control-server')",
    '}',
    '',
  ].join('\n')
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx' })
}

function writeProfilePatch(path, paths, config) {
  const patch = [
    '- id: hy-memory',
    '  config:',
    `    dataDir: ${JSON.stringify(paths.dataDir)}`,
    '    worker:',
    '      autoSpawn: true',
    '      engine: mock',
    `      python: ${JSON.stringify(config.pythonPath)}`,
    '    ui:',
    '      enabled: true',
    '      host: 127.0.0.1',
    `      port: ${config.studioPort}`,
    '      allowedFrameOrigins:',
    `        - ${JSON.stringify(config.webOrigin)}`,
    '- insert:',
    '    - id: native-preview-shutdown',
    '      name: "./native-preview-shutdown.mjs"',
    '',
  ].join('\n')
  writeFileSync(path, patch, { encoding: 'utf8' })
}

function verifyWorkerIdentity(worker, hostPid, expectedPython, expectedOwnershipNonce) {
  if (!worker || !Number.isInteger(worker.pid) || worker.pid <= 0) return { ok: false, reason: 'worker PID record missing' }
  const executableMatches = resolve(String(worker.executable)).toLowerCase() === resolve(expectedPython).toLowerCase()
  const ownershipNonceMatches = typeof expectedOwnershipNonce === 'string'
    && expectedOwnershipNonce.length > 0
    && worker.ownershipNonce === expectedOwnershipNonce
  const parentPidReported = Number.isInteger(Number(worker.parentPid)) && Number(worker.parentPid) > 0
  return {
    ok: executableMatches && ownershipNonceMatches && parentPidReported,
    executableMatches,
    ownershipNonceMatches,
    parentPidReported,
    parentPid: worker.parentPid,
    parentDiffersFromCliPid: Number(worker.parentPid) !== Number(hostPid),
    pid: worker.pid,
  }
}

function browserStopped(browserStarted, browserClosed, browserPid, isRunning = pidIsRunning) {
  if (browserStarted === false) return null
  if (browserStarted !== true || browserClosed !== true || !Number.isInteger(browserPid) || browserPid <= 0) return false
  return !isRunning(browserPid)
}

async function waitForHttp(origin, timeoutMs) {
  return await waitFor(async () => {
    try {
      const response = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
      return response.status >= 200 && response.status < 500
    } catch { return false }
  }, timeoutMs)
}

async function waitForPortClosed(port, timeoutMs = 10_000) {
  return await waitFor(async () => !(await portIsReachable(port)), timeoutMs)
}

function safeRemoveTempRoot(tempRoot) {
  const real = realpathSync(tempRoot)
  const expectedParent = realpathSync(dirname(tempRoot))
  if (dirname(real) !== expectedParent || !basenameStartsWith(real, 'hymem-native-host-')) {
    throw new Error('refusing to remove a temp path outside this harness-owned root')
  }
  rmSync(real, { recursive: true, force: true })
}

function basenameStartsWith(path, prefix) {
  return path.slice(path.lastIndexOf(sep) + 1).startsWith(prefix)
}

async function main() {
  const tag = nowTag()
  const artifactDir = join(root, 'artifacts', 'validation-20261021', `native-host-${tag}`)
  mkdirSync(artifactDir, { recursive: true })
  const screenshotsDir = join(artifactDir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })
  const report = {
    task: 'isolated-native-dsh-host-studio-preview',
    startedAt: new Date().toISOString(),
    workerStatus: 'DONE',
    validation: 'NOT_VERIFIED',
    status: 'running',
    checks: [],
    evidence: { artifactDir, screenshotsDir },
    isolation: { temporaryRoot: null, dshHome: null, agentsHome: null, dataDir: null, workspace: null, browserProfileInTemp: true, envFilePresent: false, modelCredentialsInherited: false },
    source: { bundle: null, dshSourceSha256: null, dshSourceExpectedSha256: EXPECTED_DSH_SOURCE_SHA },
    runtime: { profile: null, ports: {}, hostPid: null, workerPid: null, browserPid: null },
    studio: { authenticatedHealth: 'NOT_RUN', routes: [], pluginsPanel: 'NOT_RUN' },
    nativeAgentRoundTrip: { status: 'NOT_RUN', reason: 'This gate validates the real DSH Host and browser iframe without an Agent turn; no model or adapter was invoked.' },
    cleanup: { gracefulShutdownRequested: false, hostStopped: false, workerStopped: false, browserStarted: false, browserStopped: null, portsStopped: false, temporaryRootRemoved: false, forcedTermination: false },
  }
  let tempRoot
  let paths
  let config
  let host
  let hostExit = null
  let hostAuth = null
  let hostLogBuffer = ''
  let workerIdentity = null
  let webResult = null
  let controlRequested = false
  let bundleStart = null
  let bundleEnd = null
  const safeCheck = (id, ok, details = {}) => report.checks.push({ id, ok: Boolean(ok), ...details })

  try {
    const dshLauncher = resolve(process.env.DSH_LAUNCHER ?? DEFAULT_DSH_LAUNCHER)
    const nodePath = resolve(process.env.HYMEM_TEST_NODE ?? DEFAULT_NODE)
    const electronFromLauncher = resolve(dirname(dshLauncher), '..', '..', '..', '..', 'DeepSeek Harness.exe')
    const electronPath = resolve(process.env.DSH_ELECTRON_EXE ?? electronFromLauncher)
    const pythonPath = resolve(process.env.HYMEM_PYTHON ?? DEFAULT_PYTHON)
    const pnpmDir = resolve(process.env.HYMEM_PNPM_DIR ?? DEFAULT_PNPM)
    const bundleDir = resolve(process.env.HYMEM_BUNDLE_DIR ?? DEFAULT_BUNDLE)
    const webTestNode = resolve(process.env.HYMEM_TEST_NODE ?? DEFAULT_NODE)
    const browser = await chooseBrowserPath()
    const requiredPaths = [dshLauncher, nodePath, electronPath, pythonPath, pnpmDir, bundleDir]
    for (const path of requiredPaths) if (!existsSync(path)) throw new Error(`required isolated preview dependency is unavailable: ${path}`)
    if (!dshLauncher.toLowerCase().endsWith('.cmd')) throw new Error('DSH_LAUNCHER must refer to the installed dsh.cmd wrapper')
    assertNoPercent(dshLauncher, 'DSH_LAUNCHER')
    const officialSha = execFileSync('git', ['-C', DSH_SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (officialSha !== EXPECTED_DSH_SOURCE_SHA) throw new Error(`local DSH source SHA differs from the pinned source: ${officialSha}`)
    bundleStart = verifyBundle(bundleDir)
    report.source.bundle = { path: bundleDir, ...bundleStart }
    report.source.dshSourceSha256 = officialSha
    safeCheck('dependenciesAndSourcePin', true, { dshLauncherFound: true, nodeFound: true, electronFound: true, pythonFound: true, pnpmFound: true, browserFound: true, dshSourceSha256: officialSha })

    tempRoot = mkdtempSync(join(tmpdir(), 'hymem-native-host-'))
    const resolvedTempRoot = realpathSync(tempRoot)
    const pathsRoot = {
      tempRoot: resolvedTempRoot,
      workspace: join(resolvedTempRoot, 'workspace'),
      home: join(resolvedTempRoot, 'user-home'),
      localAppData: join(resolvedTempRoot, 'local-app-data'),
      appData: join(resolvedTempRoot, 'app-data'),
      tempDir: join(resolvedTempRoot, 'tmp'),
      dshHome: join(resolvedTempRoot, 'dsh-home'),
      agentsHome: join(resolvedTempRoot, 'dsh-agents-home'),
      dataDir: join(resolvedTempRoot, 'memory-data'),
      pythonBootstrap: join(resolvedTempRoot, 'python-bootstrap'),
      npmCache: join(resolvedTempRoot, 'npm-cache'),
      pnpmHome: join(resolvedTempRoot, 'pnpm-home'),
      pnpmStore: join(resolvedTempRoot, 'pnpm-store'),
      workerPidFile: join(resolvedTempRoot, 'worker-owned.json'),
      npmrc: join(resolvedTempRoot, 'npmrc'),
      controlPlugin: null,
      profilePatch: null,
      bootstrapScript: join(resolvedTempRoot, 'bootstrap-profile.ps1'),
    }
    for (const path of [pathsRoot.workspace, pathsRoot.home, pathsRoot.localAppData, pathsRoot.appData, pathsRoot.tempDir, pathsRoot.dshHome, pathsRoot.agentsHome, pathsRoot.dataDir, pathsRoot.pythonBootstrap, pathsRoot.npmCache, pathsRoot.pnpmHome, pathsRoot.pnpmStore]) mkdirSync(path, { recursive: true })
    paths = pathsRoot
    report.isolation.temporaryRoot = resolvedTempRoot
    report.isolation.dshHome = paths.dshHome
    report.isolation.agentsHome = paths.agentsHome
    report.isolation.dataDir = paths.dataDir
    report.isolation.workspace = paths.workspace
    const profile = `hymem-preview-${randomUUID().slice(0, 8)}`
    const controlNonce = randomBytes(32).toString('base64url')
    const webPort = await chooseFreePort()
    const studioPort = await chooseFreePort()
    const controlPort = await chooseFreePort()
    const webOrigin = `http://127.0.0.1:${webPort}`
    const workerOwnershipNonce = randomBytes(32).toString('base64url')
    config = { dshLauncher, nodePath, electronPath, pythonPath, pnpmDir, bundleDir, webTestNode, webOrigin, webPort, studioPort, controlPort, controlNonce, workerOwnershipNonce, profile, browserCache: browser.cache, browserExecutable: browser.executable }
    report.runtime.profile = profile
    report.runtime.ports = { web: webPort, studio: studioPort, control: controlPort }
    if (await portIsReachable(webPort) || await portIsReachable(studioPort) || await portIsReachable(controlPort)) {
      throw new Error('a selected loopback port became occupied before startup; refusing a retry')
    }
    writeFileSync(paths.npmrc, `offline=true\ncache=${paths.npmCache.replaceAll('\\', '/')}\nfund=false\naudit=false\n`, { encoding: 'utf8', flag: 'wx' })
    writeSitecustomize(join(paths.pythonBootstrap, 'sitecustomize.py'))
    const env = makeChildEnv(paths, config)
    const modelEnvNames = Object.keys(process.env).filter(name => /^(?:OPENAI_|MEMORY_LLM_|MEMORY_EMBEDDER_|DEEPSEEK_API_KEY|HYMEM_TEST_ENV_FILE|HYMEM_PROFILE)/i.test(name))
    report.isolation = { ...report.isolation, environmentAllowlisted: true, modelCredentialVariableNamesExcluded: modelEnvNames.length, envFilePresent: existsSync(join(paths.dataDir, 'memory-engine.env')), playwrightBrowserCache: config.browserCache, playwrightChromiumExecutable: config.browserExecutable }
    if (existsSync(join(paths.dataDir, 'memory-engine.env'))) throw new Error('isolated engine env-file unexpectedly exists before Host start')
    safeCheck('isolatedEnvironment', true, { modelCredentialVariableNamesExcluded: modelEnvNames.length, separateNpmConfig: true, offlinePackageManager: true, explicitPythonAndPnpm: true, noEngineEnvFile: true })

    const bootstrapScript = [
      `$launcher = ${powershellQuote(dshLauncher)}`,
      `& $launcher '--profile' ${powershellQuote(profile)} '--from-default-profile' 'web' '--dump-config'`,
      'exit $LASTEXITCODE',
      '',
    ].join('\n')
    writeFileSync(paths.bootstrapScript, bootstrapScript, { encoding: 'utf8', flag: 'wx' })
    const bootstrap = startCapturedChild({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.bootstrapScript],
      cwd: paths.workspace,
      env,
      timeoutMs: 150_000,
      artifactDir,
      label: 'profile-bootstrap',
    })
    const bootstrapResult = await bootstrap.result
    safeCheck('temporaryProfileBootstrap', bootstrapResult.exitCode === 0 && !bootstrapResult.timedOut, { exitCode: bootstrapResult.exitCode, timedOut: bootstrapResult.timedOut })
    if (bootstrapResult.exitCode !== 0 || bootstrapResult.timedOut) throw new Error(`temporary profile bootstrap failed with exit ${bootstrapResult.exitCode}`)

    const installArgs = [join(bundleDir, 'cli.js'), 'install', '--profile', profile, '--data-dir', paths.dataDir, '--ui-port', String(studioPort), '--json']
    const install = startCapturedChild({ file: nodePath, args: installArgs, cwd: paths.workspace, env, timeoutMs: 300_000, artifactDir, label: 'private-bundle-install' })
    const installResult = await install.result
    let installJson = null
    try { installJson = JSON.parse(installResult.stdout) } catch { /* detailed sanitized stdout is retained in the evidence log */ }
    const privateBundleDir = typeof installJson?.privateBundleDir === 'string' ? resolve(installJson.privateBundleDir) : null
    const installOk = installResult.exitCode === 0 && !installResult.timedOut && installJson?.ok === true && privateBundleDir !== null && isContainedPath(paths.dataDir, privateBundleDir)
    safeCheck('privateBundleInstall', installOk, { exitCode: installResult.exitCode, timedOut: installResult.timedOut, privateBundleInsideTempDataDir: Boolean(privateBundleDir && isContainedPath(paths.dataDir, privateBundleDir)), packageName: installJson?.packageName ?? 'dsh-hy-memory' })
    if (!installOk) throw new Error(`isolated private bundle install failed with exit ${installResult.exitCode}`)

    const profileDir = join(paths.dshHome, 'profiles', profile)
    paths.profilePatch = join(profileDir, 'cordis.patch.yml')
    paths.controlPlugin = join(profileDir, 'native-preview-shutdown.mjs')
    if (!existsSync(paths.profilePatch) || !isContainedPath(paths.dshHome, paths.profilePatch)) throw new Error('isolated DSH profile patch was not created in the temp DSH_HOME')
    writeShutdownPlugin(paths.controlPlugin)
    writeProfilePatch(paths.profilePatch, paths, config)
    if (existsSync(join(paths.dataDir, 'memory-engine.env'))) throw new Error('engine env-file appeared before mock worker startup')
    safeCheck('mockProfilePatch', true, { engine: 'mock', allowedFrameOrigin: webOrigin, dataDirInsideTemp: isContainedPath(tempRoot, paths.dataDir), controlPluginInsideTempProfile: isContainedPath(tempRoot, paths.controlPlugin) })

    const launcherDir = dirname(dshLauncher)
    const appResourceDir = resolve(launcherDir, '..', '..', '..')
    const asarCli = join(appResourceDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    const hostArgs = ['--expose-internals', asarCli, '--profile', profile, '--host', '127.0.0.1', '--port', String(webPort), '--no-open']
    const hostEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    const hostLogPath = join(artifactDir, 'host.log')
    host = spawn(electronPath, hostArgs, { cwd: paths.workspace, env: hostEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    report.runtime.hostPid = host.pid ?? null
    report.evidence.hostLog = hostLogPath
    host.once('close', (code, signal) => {
      hostExit = { code, signal }
    })
    const authBuffers = { stdout: '', stderr: '' }
    const appendHost = (stream, chunk) => {
      const text = String(chunk)
      authBuffers[stream] += text
      const parts = authBuffers[stream].split(/\r?\n/)
      authBuffers[stream] = parts.pop() ?? ''
      for (const line of parts) {
        if (!hostAuth) {
          try { hostAuth = parseDshAuthenticatedUrl(line) } catch { /* invalid auth lines are caught by failed readiness */ }
        }
        const safeLine = sanitizeText(line)
        hostLogBuffer += `${safeLine}\n`
      }
      writeFileSync(hostLogPath, hostLogBuffer, 'utf8')
    }
    host.stdout?.on('data', chunk => appendHost('stdout', chunk))
    host.stderr?.on('data', chunk => appendHost('stderr', chunk))
    host.once('error', error => { hostLogBuffer += `${sanitizeText(`host spawn error: ${error.message}`)}\n`; writeFileSync(hostLogPath, hostLogBuffer, 'utf8') })
    const hostReady = await waitFor(async () => {
      if (hostExit) return false
      const httpReady = await waitForHttp(webOrigin, 800)
      const controlReady = await portIsReachable(controlPort)
      return httpReady && controlReady && hostAuth !== null
    }, 120_000)
    if (hostExit) throw new Error(`isolated DSH Host exited during startup (${hostExit.code ?? hostExit.signal ?? 'unknown'})`)
    if (!hostReady || !hostAuth) throw new Error('isolated DSH Host did not reach web, control, and authenticated-readiness checks before timeout')
    const workerRaw = await waitFor(() => existsSync(paths.workerPidFile), 20_000) ? readJsonIfPresent(paths.workerPidFile) : null
    workerIdentity = verifyWorkerIdentity(workerRaw, host.pid, pythonPath, config.workerOwnershipNonce)
    report.runtime.workerPid = workerIdentity.pid ?? null
    safeCheck('realDshHostReady', true, { hostPid: host.pid ?? null, workerOwnershipProvenByRunNonce: workerIdentity.ok, workerParentPid: workerIdentity.parentPid ?? null, engine: 'mock', origin: webOrigin })
    if (!workerIdentity.ok) throw new Error('mock worker ownership could not be proven from its isolated Python bootstrap record')
    if (existsSync(join(paths.dataDir, 'memory-engine.env'))) throw new Error('engine env-file unexpectedly exists while mock worker is running')

    const webEnv = { ...env, DSH_WEB_URL: hostAuth.origin, HYMEM_STUDIO_URL: `http://127.0.0.1:${config.studioPort}`, DSH_WEB_TOKEN: hostAuth.token, DSH_E2E_OUTPUT_DIR: screenshotsDir, DSH_E2E_BROWSER_PID_FILE: join(paths.tempRoot, 'browser-owned.pid'), DSH_E2E_CHROMIUM_PATH: config.browserExecutable, PLAYWRIGHT_BROWSERS_PATH: config.browserCache }
    report.cleanup.browserStarted = null
    const webTest = startCapturedChild({
      file: webTestNode,
      args: [join(root, 'tests', 'e2e', 'dsh-integration.mjs')],
      cwd: paths.workspace,
      env: webEnv,
      timeoutMs: 210_000,
      artifactDir,
      label: 'browser-studio-e2e',
      secrets: [hostAuth.token],
    })
    report.runtime.browserPid = null
    webResult = await webTest.result
    const browserPidFile = join(paths.tempRoot, 'browser-owned.pid')
    const browserPidFromFile = existsSync(browserPidFile) ? Number(readFileSync(browserPidFile, 'utf8').trim()) : null
    report.runtime.browserPid = Number.isInteger(browserPidFromFile) ? browserPidFromFile : null
    let webJson = null
    try { webJson = JSON.parse(webResult.stdout.trim()) } catch { /* sanitized test stdout is retained as evidence */ }
    report.studio = webJson?.studio ?? report.studio
    report.studio.routes = webJson?.routes ?? []
    report.studio.pluginsPanel = webJson?.pluginsPanel ?? 'NOT_RUN'
    report.evidence.browserReport = join(artifactDir, 'browser-studio-report.json')
    if (webJson) writeJson(report.evidence.browserReport, webJson)
    report.cleanup.browserStarted = webJson?.cleanup?.browserStarted ?? null
    report.cleanup.browserStopped = browserStopped(report.cleanup.browserStarted, webJson?.cleanup?.browserClosed, report.runtime.browserPid)
    safeCheck('browserAndStudioE2E', webResult.exitCode === 0 && !webResult.timedOut && webJson?.ok === true, {
      exitCode: webResult.exitCode,
      timedOut: webResult.timedOut,
      authenticatedHealth: webJson?.studio?.authenticatedHealth ?? 'NOT_RUN',
      routeCount: Array.isArray(webJson?.routes) ? webJson.routes.filter(item => item.ok).length : 0,
      pluginPanel: webJson?.pluginsPanel ?? 'NOT_RUN',
      browserClosed: report.cleanup.browserStopped,
    })

    const safeHostLines = hostLogBuffer.split(/\r?\n/).filter(Boolean)
    const substantiveHostErrors = safeHostLines.filter(line => /\b(?:error|failed|exception)\b/i.test(line) && /(?:hy-memory|hymem|native-preview|plugin|loader)/i.test(line))
    report.evidence.hostErrorCount = substantiveHostErrors.length
    if (substantiveHostErrors.length) report.evidence.hostErrorLogLines = substantiveHostErrors.slice(0, 10)
    safeCheck('pluginHostLogs', substantiveHostErrors.length === 0, { substantiveErrorCount: substantiveHostErrors.length })
    if (webResult.exitCode !== 0 || !webJson?.ok) throw new Error(`browser/Studio E2E failed with exit ${webResult.exitCode}`)
  } catch (error) {
    report.status = 'FAILED'
    report.failure = sanitizeText(error instanceof Error ? error.message : String(error), [config?.controlNonce, hostAuth?.token].filter(Boolean))
  } finally {
    if (host && !hostExit) {
      if (hostAuth && config?.controlNonce) {
        try {
          const response = await fetch(`http://127.0.0.1:${config.controlPort}/__native-preview-stop`, {
            method: 'POST',
            headers: { 'x-native-preview-nonce': config.controlNonce },
            signal: AbortSignal.timeout(3000),
          })
          controlRequested = response.status === 202
        } catch { controlRequested = false }
      }
      report.cleanup.gracefulShutdownRequested = controlRequested
      if (controlRequested) {
        const graceful = await Promise.race([hostExit ? Promise.resolve(hostExit) : new Promise(resolveClose => host.once('close', (code, signal) => resolveClose({ code, signal }))), new Promise(resolveTimeout => setTimeout(() => resolveTimeout(null), 20_000))])
        if (graceful) hostExit = graceful
      }
      if (!hostExit && host.pid) {
        report.cleanup.forcedTermination = true
        report.cleanup.hostForce = await terminateOwnedTree(host.pid)
        const forcedExit = await Promise.race([new Promise(resolveClose => host.once('close', (code, signal) => resolveClose({ code, signal }))), new Promise(resolveTimeout => setTimeout(() => resolveTimeout(null), 15_000))])
        if (forcedExit) hostExit = forcedExit
      }
    }
    if (workerIdentity?.ok === true && workerIdentity.pid && pidIsRunning(workerIdentity.pid)) {
      report.cleanup.forcedTermination = true
      report.cleanup.workerForce = await terminateOwnedTree(workerIdentity.pid)
      await waitFor(() => !pidIsRunning(workerIdentity.pid), 10_000)
    }
    if (host && host.pid) report.cleanup.hostStopped = !pidIsRunning(host.pid) && hostExit !== null
    if (workerIdentity?.pid) report.cleanup.workerStopped = !pidIsRunning(workerIdentity.pid)
    if (config) {
      const portChecks = await Promise.all([config.webPort, config.studioPort, config.controlPort].map(port => waitForPortClosed(port, 10_000)))
      report.cleanup.portsStopped = portChecks.every(Boolean)
      report.cleanup.gracefulShutdownRequested = controlRequested
    }
    if (host && hostExit) {
      report.runtime.hostExit = hostExit
      writeJson(join(artifactDir, 'exit-host.json'), { pid: host.pid ?? null, ...hostExit, gracefulShutdownRequested: controlRequested, forcedTermination: report.cleanup.forcedTermination })
    }
    if (paths?.workerPidFile) {
      const pidRecord = readJsonIfPresent(paths.workerPidFile)
      if (pidRecord && report.runtime.workerPid === null) report.runtime.workerPid = pidRecord.pid
      writeJson(join(artifactDir, 'worker-ownership.json'), { recordFound: Boolean(pidRecord), ...workerIdentity, stopped: report.cleanup.workerStopped })
    }
    try { bundleEnd = config ? verifyBundle(config.bundleDir) : null } catch (error) { report.source.bundleEndError = sanitizeText(error.message) }
    report.source.bundleEnd = bundleEnd
    report.source.bundleUnchanged = Boolean(bundleStart && bundleEnd && bundleStart.manifestSha256 === bundleEnd.manifestSha256 && bundleStart.fileCount === bundleEnd.fileCount)
    if (tempRoot) {
      const browserCleanupSafe = report.cleanup.browserStarted === false || report.cleanup.browserStopped === true
      const hostCleanupSafe = report.cleanup.hostStopped === true
      const workerCleanupSafe = report.cleanup.workerStopped === true
      const noOwnedProcesses = hostCleanupSafe && workerCleanupSafe && browserCleanupSafe
      if (noOwnedProcesses && report.cleanup.portsStopped !== false) {
        try {
          safeRemoveTempRoot(tempRoot)
          report.cleanup.temporaryRootRemoved = true
        } catch (error) {
          report.cleanup.tempRemovalError = sanitizeText(error.message)
        }
      } else {
        report.cleanup.tempRootPreservedForLiveOwnedProcess = true
      }
    }
    const acceptanceChecks = [
      'dependenciesAndSourcePin', 'isolatedEnvironment', 'temporaryProfileBootstrap', 'privateBundleInstall',
      'mockProfilePatch', 'realDshHostReady', 'browserAndStudioE2E', 'pluginHostLogs',
    ]
    const allChecks = acceptanceChecks.every(id => report.checks.find(check => check.id === id)?.ok === true)
      && report.source.bundleUnchanged === true
      && report.cleanup.hostStopped === true
      && report.cleanup.workerStopped === true
      && report.cleanup.browserStopped === true
      && report.cleanup.portsStopped === true
      && report.cleanup.temporaryRootRemoved === true
      && report.cleanup.forcedTermination === false
    report.status = allChecks ? 'PASSED' : 'FAILED'
    report.validation = allChecks ? 'VERIFIED' : 'NOT_VERIFIED'
    report.finishedAt = new Date().toISOString()
    writeJson(join(artifactDir, 'native-host-report.json'), report)
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, validation: report.validation, artifactDir }, null, 2)}\n`)
  process.exitCode = report.validation === 'VERIFIED' ? 0 : 1
}

if (process.argv[2] === '--self-test') {
  assert.equal(
    redactUrlSecrets('dsh web: http://127.0.0.1:58231/?token=secret-value&source=launch'),
    'dsh web: http://127.0.0.1:58231/?token=[REDACTED]&source=launch',
  )
  assert.deepEqual(parseDshAuthenticatedUrl('dsh web: http://127.0.0.1:58231/?token=secret-value'), {
    origin: 'http://127.0.0.1:58231', token: 'secret-value',
  })
  assert.throws(() => parseDshAuthenticatedUrl('dsh web: https://public.example/?token=x'), /loopback HTTP/)
  assert.equal(isContainedPath('C:\\temp\\run', 'C:\\temp\\run\\profile'), true)
  assert.equal(isContainedPath('C:\\temp\\run', 'C:\\temp\\run-elsewhere'), false)
  const workerFixture = {
    pid: 20,
    parentPid: 30,
    executable: 'C:\\temp\\python.exe',
    ownershipNonce: 'run-specific-nonce',
  }
  assert.equal(verifyWorkerIdentity(workerFixture, 10, 'C:\\temp\\python.exe', 'run-specific-nonce').ok, true)
  assert.equal(verifyWorkerIdentity(workerFixture, 10, 'C:\\temp\\python.exe', 'different-run-nonce').ok, false)
  assert.equal(browserStopped(false, null, null, () => false), null)
  assert.equal(browserStopped(true, true, 40, () => false), true)
  assert.equal(browserStopped(true, true, 40, () => true), false)
  assert.equal(browserStopped(true, false, 40, () => false), false)
  console.log('native-host helper self-test passed (redacted auth, loopback-only readiness, contained temp paths)')
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
