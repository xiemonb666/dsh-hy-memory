#!/usr/bin/env node
/**
 * dsh-hy-memory operator CLI.
 *
 * Commands: doctor, status, serve, install, uninstall, backup, restore, export,
 * reindex, migrate. Every command prints machine-readable JSON with `--json`
 * and never writes outside the plugin data directory or an explicitly named
 * destination.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ErrorCode, HyMemoryError, errorPayload } from '../packages/contracts/src/index.js'
import { GovernanceStore } from '../packages/governance/src/index.js'
import { redact } from '../packages/governance/src/redact.js'
import { normalizeConfig } from '../packages/host-plugin/src/config.js'
import { CapturePipeline } from '../packages/host-plugin/src/capture.js'
import { RecallController } from '../packages/host-plugin/src/recall.js'
import { StudioServer, resolveStudioDir, resolveUiToken } from '../packages/host-plugin/src/studio.js'
import { startWorker } from '../packages/host-plugin/src/worker.js'
import { resolveWorkspaceIdentity } from '../packages/host-plugin/src/identity.js'
import { inspectDatabase, migrateDatabase, reindexDatabase, restoreDatabase } from './maintenance.js'
import { installTransaction, resolveProfilePaths } from './install-transaction.js'

const bundleRoot = resolve(import.meta.dirname)
const repoRoot = resolve(join(bundleRoot, '..', '..'))

interface Output {
  ok: boolean
  [key: string]: unknown
}

function emit(payload: Output, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'object') process.stdout.write(`${key}: ${JSON.stringify(value)}\n`)
    else process.stdout.write(`${key}: ${String(value)}\n`)
  }
}

function pythonExe(): string {
  if (process.env.HYMEM_PYTHON) return process.env.HYMEM_PYTHON
  const venv = process.platform === 'win32' ? join(repoRoot, '.venv', 'Scripts', 'python.exe') : join(repoRoot, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python'
}

function dataDirOf(flag: string | undefined): string {
  if (flag) return resolve(flag)
  if (process.env.HYMEM_DATA_DIR) return resolve(process.env.HYMEM_DATA_DIR)
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-hy-memory')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dsh-hy-memory')
}

/** Quote one argument for a cmd.exe /c command line. */
function quoteForCmd(value: string): string {
  if (!/[\s"&|<>^()]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function assertWindowsDshShellSafe(cmd: string, args: readonly string[]): void {
  if (process.platform !== 'win32') return
  // cmd.exe expands %NAME% even inside quotes, so do not guess at an escaping scheme.
  if ([cmd, ...args].some(value => value.includes('%'))) {
    throw new HyMemoryError(ErrorCode.VALIDATION, 'Windows DSH launcher and arguments cannot contain percent signs')
  }
}

function dshLauncher(): { cmd: string; env: NodeJS.ProcessEnv } {
  const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    process.env.DSH_LAUNCHER,
    join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const launcher = candidates.find(candidate => existsSync(candidate))
  if (!launcher) throw new Error('dsh launcher not found; set DSH_LAUNCHER to the dsh.cmd path')
  const desktopExe = resolve(dirname(launcher), '..', '..', '..', '..', 'DeepSeek Harness.exe')
  const env = { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? desktopExe }
  return { cmd: launcher, env }
}

function runDsh(args: string[], extraPath: string[]): { code: number; output: string } {
  const { cmd, env } = dshLauncher()
  assertWindowsDshShellSafe(cmd, args)
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const merged = { ...env, [pathKey]: [...extraPath, env[pathKey] ?? ''].join(process.platform === 'win32' ? ';' : ':') }
  try {
    // A `.cmd` launcher needs cmd.exe, and cmd.exe parses its own command line:
    // the launcher path must be quoted and the whole line handed to the shell.
    const output =
      process.platform === 'win32'
        ? execFileSync([quoteForCmd(cmd), ...args.map(quoteForCmd)].join(' '), {
            shell: true,
            encoding: 'utf8',
            env: merged,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 300_000,
            windowsHide: true,
          })
        : execFileSync(cmd, args, { encoding: 'utf8', env: merged, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { code: 0, output }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/** Locate the pnpm shipped with the DSH runtime so `dsh plugin` can forward to it. */
function bundledPnpmDir(): string[] {
  const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    process.env.HYMEM_PNPM_DIR,
    join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin'),
    join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.filter(candidate => existsSync(candidate))
}

function profilePaths(profile: string): { dir: string; packageJson: string; patch: string } {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const paths = resolveProfilePaths(home, profile)
  return { dir: paths.profileDir, packageJson: paths.packageJson, patch: paths.patch }
}

function commandDoctor(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const checks: Array<{ id: string; ok: boolean; detail: string }> = []
  checks.push({ id: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version })
  let pythonVersion = 'missing'
  try {
    pythonVersion = execFileSync(pythonExe(), ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    // Python is optional for the mock engine; reported as a failing check.
  }
  checks.push({ id: 'python', ok: pythonVersion !== 'missing', detail: pythonVersion })
  checks.push({ id: 'dataDir', ok: existsSync(dataDir), detail: dataDir })
  let sdk = 'not installed'
  try {
    sdk = execFileSync(pythonExe(), ['-c', 'import hy_memory; print(hy_memory.__version__)'], { encoding: 'utf8' }).trim()
  } catch {
    // Reported below as an unavailable engine; the mock engine keeps working.
  }
  checks.push({ id: 'hyMemorySdk', ok: !sdk.startsWith('not'), detail: sdk })
  const dsh = existsSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles'))
  checks.push({ id: 'dshProfiles', ok: dsh, detail: process.env.DSH_HOME ?? join(homedir(), '.dsh') })
  const studio = resolveStudioDir(bundleRoot)
  checks.push({ id: 'studioAssets', ok: existsSync(join(studio, 'index.html')), detail: studio })
  const database = inspectDatabase(join(dataDir, 'governance.db'))
  checks.push({ id: 'sqliteIntegrity', ok: database.integrity === 'ok', detail: database.integrity === 'ok' ? 'ok' : database.reasons.join('; ') })
  checks.push({ id: 'schema', ok: database.schemaSupported, detail: database.schemaVersion === null ? 'not initialized' : `version ${database.schemaVersion}${database.schemaSupported ? '' : ' (unsupported)'}` })
  checks.push({ id: 'auditChain', ok: database.auditValid === true, detail: database.auditValid === true ? `valid (${database.auditEvents ?? 0} events)` : database.reasons.join('; ') || 'not initialized or broken' })
  const ok = checks.every(check => check.ok || check.id === 'hyMemorySdk')
  emit({ ok, command: 'doctor', checks, database, dataDir, bundleRoot }, json)
  return ok ? 0 : 1
}

function commandStatus(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const dbPath = join(dataDir, 'governance.db')
  if (!existsSync(dbPath)) {
    emit({ ok: false, command: 'status', error: 'governance database not initialized; run `install` or `serve` once', dataDir }, json)
    return 1
  }
  const store = new GovernanceStore(dbPath)
  const workspace = resolveWorkspaceIdentity(process.cwd())
  const overview = store.overview(workspace.projectId, workspace.workspaceId)
  const jobs = store.jobStats()
  const settings = store.getSettings()
  const audit = store.verifyAuditChain()
  store.close()
  emit(
    {
      ok: true,
      command: 'status',
      workspace,
      counts: {
        total: overview.total,
        verified: overview.verified,
        supported: overview.supported,
        needsReview: overview.needsReview,
        conflicted: overview.conflicted,
        stale: overview.stale,
      },
      jobs,
      capture: settings.settings.capture,
      recall: settings.settings.recall,
      audit,
      dataDir,
    },
    json,
  )
  return 0
}

async function commandServe(args: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  mkdirSync(dataDir, { recursive: true })
  const config = normalizeConfig({
    dataDir,
    worker: {
      engine: typeof args.engine === 'string' ? args.engine : 'auto',
      python: pythonExe(),
      autoSpawn: true,
      port: 0,
    },
    ui: { enabled: true, host: '127.0.0.1', port: Number(args['ui-port'] ?? 48731) },
    capture: { enabled: args['no-capture'] !== true },
  })
  const store = new GovernanceStore(join(dataDir, 'governance.db'))
  store.ensureOwner()
  const logger = {
    info: (message: string) => process.stderr.write(`[info] ${message}\n`),
    warn: (message: string) => process.stderr.write(`[warn] ${message}\n`),
    error: (message: string) => process.stderr.write(`[error] ${message}\n`),
  }
  const worker = await startWorker(config, bundleRoot, logger, { modelPolicy: () => store.getSettings().settings.models })
  const identity = resolveWorkspaceIdentity(process.cwd())
  store.ensureWorkspace({
    id: identity.workspaceId,
    projectId: identity.projectId,
    repoFingerprint: identity.repoFingerprint,
    rootAlias: identity.rootAlias,
    ...(identity.remote ? { remote: identity.remote } : {}),
  })
  const capture = new CapturePipeline({
    store,
    engine: worker.client,
    config,
    logger,
    cwd: () => process.cwd(),
    enqueue: envelope => {
      const { job } = store.enqueueJob(envelope, envelope.sourceKey)
      logger.info(`queued capture job ${job.id}`)
    },
  })
  const recall = new RecallController({ store, engine: worker.client, config, workspace: () => identity })
  const runtime = {
    config,
    store,
    engine: worker.client,
    recall,
    capture,
    logger,
    workspace: () => identity,
    identityOf: (agent: { session: { id: string } }) => ({
      principalId: `agent:${agent.session.id}`,
      agentId: agent.session.id,
      sessionId: agent.session.id,
    }),
    engineHealth: async () => {
      try {
        const health = await worker.client.health()
        return { ok: health.ok, degraded: health.degraded, reason: health.reason, engine: health.engine, version: health.engineVersion }
      } catch (error) {
        return { ok: false, degraded: true, reason: error instanceof Error ? error.message : String(error), engine: 'unavailable', version: 'unknown' }
      }
    },
  }
  const { token } = resolveUiToken(dataDir, null)
  const studio = new StudioServer({
    runtime,
    host: '127.0.0.1',
    port: Number(args['ui-port'] ?? 48731),
    token,
    studioDir: resolveStudioDir(bundleRoot),
    frameOrigins: [
      process.env.DSH_WEB_URL ?? 'http://127.0.0.1:58094',
      'http://localhost:58094',
      'http://127.0.0.1:58231',
      'http://localhost:58231',
    ],
    cookieSecret: token,
  })
  const port = await studio.start()
  emit({ ok: true, command: 'serve', studio: `http://127.0.0.1:${port}/studio/`, token, workerPort: worker.port, workerPid: worker.pid, workerTokenFile: worker.tokenFile, engine: await runtime.engineHealth(), workspace: identity }, json)
  const shutdown = async (): Promise<void> => {
    await studio.close()
    await worker.stop()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  await new Promise<void>(() => undefined)
  return 0
}

function commandInstall(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const profile = String(args.profile ?? '')
  if (!profile) throw new Error('install requires --profile <name>')
  const paths = profilePaths(profile)
  if (!existsSync(paths.packageJson)) {
    emit({ ok: false, command: 'install', error: `profile ${profile} does not exist at ${paths.dir}`, hint: 'create it with: dsh --profile ' + profile + ' --from-default-profile web --dump-config' }, json)
    return 1
  }
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const port = Number(args['ui-port'] ?? 48731)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ui-port must be an integer in [1024, 65535]')
  if (args['dry-run'] === true) {
    emit({ ok: true, command: 'install', dryRun: true, profile, bundleRoot, dataDir, studio: `http://127.0.0.1:${port}/studio/` }, json)
    return 0
  }
  const launcher = dshLauncher().cmd
  const prospectivePrivateBundle = join(dataDir, 'installed-bundles', profile, 'bundle')
  assertWindowsDshShellSafe(launcher, ['plugin', '--profile', profile, 'add', prospectivePrivateBundle])
  const result = installTransaction({
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    profileName: profile,
    dataDir,
    sourceBundle: bundleRoot,
    uiPort: port,
    uiToken: () => resolveUiToken(dataDir, null).token,
    runner: ({ profileName, privateBundleDir }) => runDsh(
      ['plugin', '--profile', profileName, 'add', privateBundleDir],
      bundledPnpmDir(),
    ),
  })
  if (result.ok) {
    emit({ ok: true, command: 'install', profile, privateBundleDir: result.privateBundleDir, backupDir: result.backupDir, output: result.output.slice(-4000), studio: `http://127.0.0.1:${port}/studio/` }, json)
    return 0
  }
  emit({ ok: false, command: 'install', profile, error: result.error, exitCode: result.exitCode, output: result.output.slice(-4000), backupDir: result.backupDir, privateBundleDir: result.privateBundleDir, rollback: result.rollback }, json)
  return result.exitCode
}

function commandUninstall(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const profile = String(args.profile ?? '')
  if (!profile) throw new Error('uninstall requires --profile <name>')
  profilePaths(profile)
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const result = runDsh(['plugin', '--profile', profile, 'remove', 'dsh-hy-memory'], bundledPnpmDir())
  emit(
    {
      ok: result.code === 0,
      command: 'uninstall',
      profile,
      exitCode: result.code,
      output: result.output.slice(-4000),
      memoryDataRetained: true,
      dataDir,
      cleanupHint: `memory data stays at ${dataDir}; delete it manually only after confirming with the user`,
    },
    json,
  )
  return result.code
}

function commandBackup(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const dbPath = join(dataDir, 'governance.db')
  if (!existsSync(dbPath)) throw new Error('no governance database to back up')
  const store = new GovernanceStore(dbPath)
  const destination = String(args.destination ?? join(dataDir, 'backups', `hymem-${Date.now()}.db`))
  const result = store.backup(destination)
  store.close()
  emit({ ok: true, command: 'backup', ...result }, json)
  return 0
}

function commandExport(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const store = new GovernanceStore(join(dataDir, 'governance.db'))
  const workspace = resolveWorkspaceIdentity(process.cwd())
  const projectId = String(args.project ?? workspace.projectId)
  const payload = store.exportProject(projectId, args.redacted !== false)
  store.close()
  const destination = typeof args.out === 'string' ? resolve(args.out) : null
  if (destination) {
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`)
  }
  emit({ ok: true, command: 'export', projectId, redacted: args.redacted !== false, destination, bytes: JSON.stringify(payload).length }, json)
  return 0
}

async function commandCapture(args: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  mkdirSync(dataDir, { recursive: true })
  const text = String(args.text ?? '')
  if (!text) throw new Error('capture requires --text <session text>')
  const sessionId = String(args.session ?? `cli-${Date.now()}`)
  const toolOutput = typeof args['tool-output'] === 'string' ? args['tool-output'] : null
  const toolExit = typeof args['tool-exit'] === 'string' ? Number(args['tool-exit']) : 0
  const config = normalizeConfig({
    dataDir,
    worker: { engine: typeof args.engine === 'string' ? args.engine : 'auto', python: pythonExe(), autoSpawn: true, port: 0 },
    ui: { enabled: false },
  })
  const store = new GovernanceStore(join(dataDir, 'governance.db'))
  store.ensureOwner()
  const logger = { info: () => undefined, warn: (m: string) => process.stderr.write(`[warn] ${m}\n`), error: (m: string) => process.stderr.write(`[error] ${m}\n`) }
  const worker = await startWorker(config, bundleRoot, logger, { modelPolicy: () => store.getSettings().settings.models })
  try {
    const identity = resolveWorkspaceIdentity(process.cwd())
    store.ensureWorkspace({
      id: identity.workspaceId,
      projectId: identity.projectId,
      repoFingerprint: identity.repoFingerprint,
      rootAlias: identity.rootAlias,
      ...(identity.remote ? { remote: identity.remote } : {}),
    })
    const capture = new CapturePipeline({ store, engine: worker.client, config, logger, cwd: () => process.cwd(), enqueue: () => undefined })
    const evidence = store.appendSourceEvent({
      sourceKey: `cli:${sessionId}`,
      checksum: createHash('sha256').update(text).digest('hex'),
      eventType: 'user/message',
      payload: { text },
      sessionId,
      workspaceId: identity.workspaceId,
    })
    const userEvidence = store.addEvidence({ sourceEventId: evidence.id, type: 'user_message', payload: text, trustLevel: 'user_explicit' })
    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolName?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }> = [
      { role: 'user', content: redact(text).text },
    ]
    const toolOutcomes: Array<{ callId: string; name: string; exitCode?: number; success?: boolean }> = []
    let toolEvidence: string | null = null
    if (toolOutput) {
      const toolEvent = store.appendSourceEvent({
        sourceKey: `cli:${sessionId}:tool`,
        checksum: createHash('sha256').update(toolOutput).digest('hex'),
        eventType: 'tool/result',
        payload: { text: toolOutput, exitCode: toolExit },
        sessionId,
        workspaceId: identity.workspaceId,
      })
      const added = store.addEvidence({
        sourceEventId: toolEvent.id,
        type: toolExit === 0 ? 'test_result' : 'tool_result',
        payload: toolOutput,
        trustLevel: toolExit === 0 ? 'test_verified' : 'tool_observed',
      })
      toolEvidence = added.id
      messages.push({ role: 'assistant', content: 'Running the check.', toolCalls: [{ id: 'call_1', name: 'pwsh', arguments: '{}' }] })
      messages.push({ role: 'tool', content: toolOutput, toolCallId: 'call_1', toolName: 'pwsh' })
      toolOutcomes.push({ callId: 'call_1', name: 'pwsh', exitCode: toolExit, success: toolExit === 0 })
    }
    const envelope = {
      schemaVersion: 1 as const,
      sourceKey: `cli:${sessionId}`,
      principalId: 'agent:cli',
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      agentId: 'cli',
      sessionId,
      sceneCandidate: (toolOutput ? 'coding' : 'chat') as 'chat' | 'coding',
      messages,
      toolOutcomes,
      sourceEventIds: [evidence.id],
      observedAt: new Date().toISOString(),
      ...(identity.headCommit
        ? { git: { root: identity.rootAlias, ...(identity.branch ? { branch: identity.branch } : {}), headCommit: identity.headCommit, ...(identity.remote ? { remote: identity.remote } : {}) } }
        : {}),
    }
    const { job } = store.enqueueJob(envelope, envelope.sourceKey)
    const result = await capture.process(envelope, job.idempotency_key)
    store.completeJob(job.id, result)
    emit({ ok: true, command: 'capture', sessionId, jobId: job.id, evidenceIds: [userEvidence.id, ...(toolEvidence ? [toolEvidence] : [])], ...result, projectId: identity.projectId }, json)
    return 0
  } finally {
    await worker.stop()
    store.close()
  }
}

async function commandSearch(args: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const query = String(args.query ?? '')
  if (!query) throw new Error('search requires --query <text>')
  const config = normalizeConfig({
    dataDir,
    worker: { engine: typeof args.engine === 'string' ? args.engine : 'auto', python: pythonExe(), autoSpawn: true, port: 0 },
    ui: { enabled: false },
  })
  const store = new GovernanceStore(join(dataDir, 'governance.db'))
  store.ensureOwner()
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const worker = await startWorker(config, bundleRoot, logger, { modelPolicy: () => store.getSettings().settings.models })
  try {
    const identity = resolveWorkspaceIdentity(process.cwd())
    store.ensureWorkspace({
      id: identity.workspaceId,
      projectId: identity.projectId,
      repoFingerprint: identity.repoFingerprint,
      rootAlias: identity.rootAlias,
    })
    const recall = new RecallController({ store, engine: worker.client, config, workspace: () => identity })
    const outcome = await recall.search({ principalId: 'owner', agentId: 'cli', sessionId: 'cli', query })
    emit({ ok: true, command: 'search', query, clues: outcome.clues, rendered: outcome.rendered, tokenCount: outcome.tokenCount, degraded: outcome.degraded, elapsedMs: outcome.elapsedMs }, json)
    return 0
  } finally {
    await worker.stop()
    store.close()
  }
}

function commandReindex(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const result = reindexDatabase(join(dataDir, 'governance.db'), args['dry-run'] === true)
  emit({ ok: true, command: 'reindex', ...result, note: 'tombstoned memories are never resurrected' }, json)
  return 0
}

function commandMigrate(args: Record<string, string | boolean | undefined>, json: boolean): number {
  const dataDir = dataDirOf(typeof args['data-dir'] === 'string' ? args['data-dir'] : undefined)
  const dbPath = join(dataDir, 'governance.db')
  const result = migrateDatabase(dbPath, args['dry-run'] === true)
  emit({ ok: true, command: 'migrate', ...result, dataDir }, json)
  return 0
}

async function commandRestore(args: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const source = typeof args.source === 'string' ? args.source : ''
  const target = typeof args['data-dir'] === 'string' ? args['data-dir'] : ''
  if (!target) throw new Error('restore requires an explicit --data-dir <new target directory>')
  const result = await restoreDatabase(source, target)
  emit({ ok: true, command: 'restore', ...result }, json)
  return 0
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      profile: { type: 'string' },
      'data-dir': { type: 'string' },
      destination: { type: 'string' },
      source: { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      engine: { type: 'string' },
      'ui-port': { type: 'string' },
      'dry-run': { type: 'boolean' },
      redacted: { type: 'boolean' },
      'no-capture': { type: 'boolean' },
      text: { type: 'string' },
      session: { type: 'string' },
      query: { type: 'string' },
      'tool-output': { type: 'string' },
      'tool-exit': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0] ?? 'help'
  const json = Boolean(values.json)
  if (values.help || command === 'help') {
    process.stdout.write(`dsh-hy-memory <command> [options]

  doctor                 dependency, environment, SQLite and schema checks
  status                 counts, queue, settings and audit chain
  serve                  run worker + Studio (headless)
  install --profile P    install the bundle into a DSH profile
  uninstall --profile P  remove the bundle, keep memory data
  backup [--destination] snapshot the governance database
  restore --source PATH --data-dir NEW_DIR
                           restore a validated database into an empty target
  export [--project] [--out] redacted JSON export
  capture --text T       run one synthetic capture through the real pipeline
  search --query Q       run one recall pass and print the clue container
  reindex [--dry-run]    rebuild the keyword index (dry-run previews only)
  migrate [--dry-run]    apply or preview pending schema migrations

Options: --json --data-dir <path> --engine mock|hy|auto --ui-port <n> --dry-run
`)
    return 0
  }
  switch (command) {
    case 'doctor':
      return commandDoctor(values, json)
    case 'status':
      return commandStatus(values, json)
    case 'serve':
      return await commandServe(values, json)
    case 'install':
      return commandInstall(values, json)
    case 'uninstall':
      return commandUninstall(values, json)
    case 'backup':
      return commandBackup(values, json)
    case 'export':
      return commandExport(values, json)
    case 'capture':
      return await commandCapture(values, json)
    case 'search':
      return await commandSearch(values, json)
    case 'reindex':
      return commandReindex(values, json)
    case 'migrate':
      return commandMigrate(values, json)
    case 'restore':
      return await commandRestore(values, json)
    default:
      if (json) emit({ ok: false, command, error: { code: 'E_VALIDATION', message: `unknown command: ${command}` } }, true)
      else process.stderr.write(`unknown command: ${command}\n`)
      return 2
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    if (process.argv.includes('--json')) emit({ ok: false, ...errorPayload(error) }, true)
    else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })






