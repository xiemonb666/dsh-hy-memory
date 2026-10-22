/**
 * Worker supervisor: starts the local Python memory worker as a child process,
 * waits for its reported port, and guarantees it is terminated on disposal.
 * A configured URL bypasses spawning (used by tests and remote-loopback runs).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSettings } from '@dsh-hy-memory/contracts'
import type { HostConfig } from './config.js'
import { EngineClient, newWorkerToken } from './engine.js'
import { defaultModelPolicy, isStrictLoopbackHttpUrl } from './egress.js'

export interface WorkerHandle {
  client: EngineClient
  port: number
  token: string
  owned: boolean
  readonly pid?: number
  readonly tokenFile?: string
  readonly portFile?: string
  stop(): Promise<void>
}

export interface WorkerSpawnOptions {
  /** Called once when a spawned worker exits unexpectedly (not during stop). */
  onUnexpectedExit?: (code: number | null) => void
  /** Reads the trusted host model policy; child environment is derived from its startup snapshot. */
  modelPolicy?: () => ModelSettings
}

interface ChildCloseState {
  readonly promise: Promise<void>
  isClosed(): boolean
}

function trackChildClose(child: ChildProcess): ChildCloseState {
  let closed = false
  let resolveClose!: () => void
  const promise = new Promise<void>(resolveClosePromise => {
    resolveClose = resolveClosePromise
  })
  child.once('close', () => {
    closed = true
    resolveClose()
  })
  return { promise, isClosed: () => closed }
}

async function waitForChildClose(state: ChildCloseState, timeoutMs: number): Promise<boolean> {
  if (state.isClosed()) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      state.promise.then(() => true),
      new Promise<boolean>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function terminateOwnedChild(child: ChildProcess, closeState: ChildCloseState): Promise<void> {
  if (closeState.isClosed()) return
  let gracefulSignalError: unknown
  try {
    child.kill('SIGTERM')
  } catch (error) {
    gracefulSignalError = error
  }
  if (await waitForChildClose(closeState, 1500)) return

  let forceSignalError: unknown
  try {
    child.kill('SIGKILL')
  } catch (error) {
    forceSignalError = error
  }
  if (await waitForChildClose(closeState, 1500)) return

  const timeout = new Error('owned worker process did not close after SIGTERM and SIGKILL')
  const causes = [gracefulSignalError, forceSignalError].filter((error): error is Error => error instanceof Error)
  if (causes.length > 0) throw new AggregateError([timeout, ...causes], 'worker shutdown could not be confirmed')
  throw timeout
}

function cleanupOwnedFiles(tokenFile: string, portFile: string): void {
  try {
    rmSync(tokenFile, { force: true })
  } finally {
    rmSync(portFile, { force: true })
  }
}

function readPortFile(path: string, deadline: number, child: ChildProcess): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const finish = (error?: Error, port?: number): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearInterval(timer)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      if (error) rejectPort(error)
      else resolvePort(port!)
    }
    const onError = (error: Error): void => finish(new Error(`worker process failed to start: ${error.message}`))
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`worker exited before reporting a port (${code ?? signal ?? 'unknown'})`))
    }
    child.once('error', onError)
    child.once('close', onClose)
    timer = setInterval(() => {
      if (existsSync(path)) {
        try {
          const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
          if (Number.isFinite(value) && value > 0) {
            finish(undefined, value)
            return
          }
        } catch {
          // File may be mid-write; retry until the deadline.
        }
      }
      if (Date.now() > deadline) {
        finish(new Error('worker did not report a port before the startup timeout'))
      }
    }, 100)
  })
}

/**
 * Start or attach to the memory worker.
 * @param config - host configuration.
 * @param pluginRoot - directory containing the installed bundle (python/ lives here).
 * @param logger - host logger.
 * @returns a handle whose `stop` terminates only the child it started.
 */
export async function startWorker(
  config: HostConfig,
  pluginRoot: string,
  logger: { info(message: string): void; warn(message: string): void },
  options: WorkerSpawnOptions = {},
): Promise<WorkerHandle> {
  const dataDir = config.dataDir
  const modelPolicy = options.modelPolicy ?? defaultModelPolicy
  mkdirSync(dataDir, { recursive: true })
  if (config.worker.url) {
    if (!isStrictLoopbackHttpUrl(config.worker.url)) {
      throw new Error('hymem: worker.url must use HTTP(S) and an explicit loopback host (127.0.0.1, ::1, or localhost) without credentials')
    }
    const token = config.worker.token ?? process.env.HYMEM_WORKER_TOKEN ?? ''
    if (!token) throw new Error('hymem: worker.url is configured but no worker.token/HYMEM_WORKER_TOKEN is available')
    return {
      client: new EngineClient({
        baseUrl: config.worker.url,
        token,
        timeoutMs: config.worker.requestTimeoutMs,
        modelPolicy,
        managedWorker: false,
      }),
      port: Number.parseInt(new URL(config.worker.url).port || '0', 10),
      token,
      owned: false,
      stop: async () => undefined,
    }
  }
  if (!config.worker.autoSpawn) throw new Error('hymem: no worker.url and autoSpawn is disabled')
  const startupModelPolicy = modelPolicy()
  const token = config.worker.token ?? newWorkerToken()
  const workerInstanceId = randomUUID()
  const tokenFile = join(dataDir, `worker-token-${workerInstanceId}`)
  const portFile = join(dataDir, `worker-port-${workerInstanceId}`)
  writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const pythonPath = join(pluginRoot, 'python')
  // Model/embedding endpoints and their keys live in a 0600 file, never in argv
  // (argv is visible to any local process) and never in git.
  const envFile = join(dataDir, 'memory-engine.env')
  const argv = [
    '-m', 'hymem_worker',
    '--port', String(config.worker.port),
    '--port-file', portFile,
    '--token-file', tokenFile,
    '--engine', config.worker.engine,
    '--data-dir', dataDir,
  ]
  if (existsSync(envFile)) argv.push('--env-file', envFile)
  let child: ChildProcess
  try {
    child = spawn(
      config.worker.python,
      argv,
      {
        cwd: pluginRoot,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: [pythonPath, process.env.PYTHONPATH ?? ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
          PYTHONUNBUFFERED: '1',
          // This is set after inherited process variables and wins over env-file
          // content; Python also reserves the key in its env-file parser.
          HYMEM_MODEL_POLICY: JSON.stringify(startupModelPolicy),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } catch (error) {
    try {
      cleanupOwnedFiles(tokenFile, portFile)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'worker spawn and owned-file cleanup both failed')
    }
    throw error
  }
  const closeState = trackChildClose(child)
  const logs: string[] = []
  let stopping = false
  child.stdout?.on('data', chunk => {
    const text = String(chunk).trim()
    if (text) logs.push(text)
    logger.info(`hymem worker: ${text.slice(0, 500)}`)
  })
  child.stderr?.on('data', chunk => {
    const text = String(chunk).trim()
    if (text) logs.push(text)
    logger.warn(`hymem worker stderr: ${text.slice(0, 500)}`)
  })
  child.once('exit', code => {
    logger.warn(`hymem worker exited with code ${String(code)}`)
    if (!stopping) options.onUnexpectedExit?.(code)
  })
  const deadline = Date.now() + config.worker.startupTimeoutMs
  let port: number
  try {
    port = await readPortFile(portFile, deadline, child)
  } catch (startupError) {
    stopping = true
    try {
      await terminateOwnedChild(child, closeState)
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
      cleanupOwnedFiles(tokenFile, portFile)
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], 'worker startup and owned-child cleanup both failed')
    }
    const message = startupError instanceof Error ? startupError.message : String(startupError)
    throw new Error(`${message}\n${logs.slice(-10).join('\n')}`)
  }
  return {
    client: new EngineClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      timeoutMs: config.worker.requestTimeoutMs,
      modelPolicy,
      startupModelPolicy,
      managedWorker: true,
    }),
    port,
    token,
    owned: true,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    tokenFile,
    portFile,
    stop: async () => {
      stopping = true
      await terminateOwnedChild(child, closeState)
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
      cleanupOwnedFiles(tokenFile, portFile)
    },
  }
}
