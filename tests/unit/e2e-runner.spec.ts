import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The runner is an executable JavaScript module.
import { isolatedChildEnv, seedMockStudio, summarizeResults, stopOwnedMockWorker, stopOwnedStudioTree, waitForStudioReady, withIsolatedStudio } from '../../scripts/e2e-runner.mjs'
// @ts-expect-error The runner is an executable JavaScript module.
import { runE2E } from '../../scripts/run-e2e.mjs'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('E2E runner result accounting', () => {
  it('passes only the reported worker token-file path to suites', () => {
    const env = isolatedChildEnv({ HYMEM_WORKER_TOKEN: 'secret-token' }, {
      dataDir: 'C:/tmp/hymem-e2e-token-path',
      studioUrl: 'http://127.0.0.1:45678',
      python: 'python',
      workerTokenFile: 'C:/tmp/hymem-e2e-token-path/worker-token-12345678-1234-1234-1234-123456789abc',
    })

    expect(env.HYMEM_OWNED_WORKER_TOKEN_FILE).toBe('C:/tmp/hymem-e2e-token-path/worker-token-12345678-1234-1234-1234-123456789abc')
    expect(env.HYMEM_WORKER_TOKEN).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('secret-token')
  })

  it('seeds only the runner-owned mock Studio with a deterministic UI fixture', () => {
    let command = ''
    let args: string[] = []
    const result = seedMockStudio('C:/repo', {
      HYMEM_E2E_ISOLATED: '1',
      HYMEM_DATA_DIR: 'C:/tmp/hymem-e2e-test',
      HYMEM_OWNED_WORKER_ENGINE: 'mock',
    }, (nextCommand: string, nextArgs: string[]) => {
      command = nextCommand
      args = nextArgs
      return { status: 0, stdout: JSON.stringify({ ok: true, created: ['memory-1'] }) }
    })

    expect(result.ok).toBe(true)
    expect(command).toBe(process.execPath)
    expect(args).toContain('capture')
    expect(args).toContain('--engine')
    expect(args).toContain('mock')
    expect(args).toContain('C:/tmp/hymem-e2e-test')
  })

  it('only accepts the Studio that proves the runner token and isolated data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-e2e-ready-'))
    writeFileSync(join(dataDir, 'ui-token'), 'private-ui-token\n')
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
    const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
    stdout.setEncoding = () => undefined
    stderr.setEncoding = () => undefined
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void }
      stderr: EventEmitter & { setEncoding: (encoding: string) => void }
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
    child.stdout = stdout
    child.stderr = stderr
    child.exitCode = null
    child.signalCode = null
    const requests: Array<{ url: string; options: Record<string, unknown> }> = []
    const ready = waitForStudioReady(child, 'http://127.0.0.1:45678', dataDir, {
      timeoutMs: 1000,
      fetchImpl: async (url: string, options: Record<string, unknown>) => {
        requests.push({ url, options })
        if (url.includes('/studio/?token=')) {
          return { status: 302, headers: { get: () => 'hymem_session=owned-session; Path=/' } }
        }
        return {
          status: 200,
          json: async () => ({ plugin: { dataDir }, worker: { engine: 'mock' } }),
        }
      },
    })
    stdout.emit('data', JSON.stringify({
      command: 'serve',
      ok: true,
      workerPid: 202,
      workerPort: 45679,
      workerTokenFile: join(dataDir, 'worker-token-12345678-1234-1234-1234-123456789abc'),
      engine: { engine: 'mock' },
    }))

    try {
      await expect(ready).resolves.toMatchObject({
        workerPid: 202,
        workerPort: 45679,
        workerTokenFile: join(dataDir, 'worker-token-12345678-1234-1234-1234-123456789abc'),
      })
      expect(requests.at(0)?.url).toContain('private-ui-token')
      expect(requests.at(0)?.options).toMatchObject({ redirect: 'manual' })
      expect(requests.at(1)?.url).toBe('http://127.0.0.1:45678/api/health')
      expect(requests.at(1)?.options).toMatchObject({ headers: { cookie: 'hymem_session=owned-session' } })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects readiness that reports a shared or out-of-directory worker token file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-e2e-ready-path-'))
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
    const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
    stdout.setEncoding = () => undefined
    stderr.setEncoding = () => undefined
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void }
      stderr: EventEmitter & { setEncoding: (encoding: string) => void }
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
    child.stdout = stdout
    child.stderr = stderr
    child.exitCode = null
    child.signalCode = null
    const ready = waitForStudioReady(child, 'http://127.0.0.1:45678', dataDir, { timeoutMs: 1000 })
    stdout.emit('data', JSON.stringify({
      command: 'serve',
      ok: true,
      workerPid: 202,
      workerPort: 45679,
      workerTokenFile: join(dataDir, 'worker-token'),
      engine: { engine: 'mock' },
    }))

    try {
      await expect(ready).rejects.toThrow('token-file path')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('treats skipped and missing suites as a non-successful run', () => {
    const summary = summarizeResults([
      { name: 'present', status: 'pass' },
      { name: 'optional', status: 'skipped' },
      { name: 'absent', status: 'missing' },
    ])

    expect(summary).toMatchObject({ passed: 1, failed: 0, skipped: 2, ok: false })
  })

  it('returns a failing run status when a configured suite is missing', async () => {
    const result = await runE2E({
      root: 'C:/repo',
      environment: {},
      suites: [{ name: 'missing-suite', file: 'tests/e2e/missing.mjs', needsStudio: true }],
      withStudio: async (_options: unknown, run: (context: { env: Record<string, string> }) => Promise<void>) => run({ env: {} }),
      exists: () => false,
    })

    expect(result).toMatchObject({ passed: 0, failed: 0, skipped: 1, ok: false })
    expect(result.results).toContainEqual({ name: 'missing-suite', status: 'missing' })
  })

  it('does not count a suite with skipped assertions as a passing suite', async () => {
    const report = JSON.stringify({
      ok: true,
      total: 1,
      failed: 0,
      results: [{ id: 'E2E-14a', ok: true, name: 'drawer skipped', detail: 'skipped' }],
    })
    const result = await runE2E({
      root: 'C:/repo',
      environment: {},
      suites: [{ name: 'partial-suite', file: 'tests/e2e/partial.mjs', needsStudio: true }],
      withStudio: async (_options: unknown, run: (context: { env: Record<string, string> }) => Promise<void>) => run({ env: {} }),
      exists: () => true,
      spawn: () => ({ status: 0, stdout: report, stderr: '' }),
    })

    expect(result).toMatchObject({ passed: 0, failed: 0, skipped: 1, ok: false })
    expect(result.results).toContainEqual(expect.objectContaining({ name: 'partial-suite', status: 'skipped' }))
  })

  it('stops its own Studio and removes its temporary data when a suite fails', async () => {
    const calls: string[] = []
    const workerCleanup: unknown[] = []
    const child = {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
    }
    const spawnProcess = (command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      expect(command).toBe(process.execPath)
      calls.push(`spawn:${args.join(' ')}`)
      expect(options.env.HYMEM_PROFILE).toBeUndefined()
      expect(options.env.OPENAI_API_KEY).toBeUndefined()
      expect(options.env.MEMORY_LLM_API_KEY).toBeUndefined()
      expect(options.env.MEMORY_EMBEDDER_API_KEY).toBeUndefined()
      expect(options.env.HYMEM_WORKER_TOKEN).toBeUndefined()
      expect(options.env.HYMEM_DATA_DIR).toBe('C:/tmp/hymem-e2e-test')
      expect(options.env.HYMEM_STUDIO_URL).toBe('http://127.0.0.1:45678')
      expect(options.env.HYMEM_PYTHON).toBe('C:/repo/.venv/Scripts/python.exe')
      expect(options.env.HYMEM_OWNED_WORKER_PID).toBeUndefined()
      return child
    }

    await expect(
      withIsolatedStudio(
        {
          root: 'C:/repo',
          environment: {
            PATH: 'C:/Windows',
            HYMEM_PROFILE: 'existing-profile',
            OPENAI_API_KEY: 'secret',
            MEMORY_LLM_API_KEY: 'secret-llm',
            MEMORY_EMBEDDER_API_KEY: 'secret-embedder',
            HYMEM_WORKER_TOKEN: 'secret-worker',
          },
          python: 'C:/repo/.venv/Scripts/python.exe',
          createTempDir: () => 'C:/tmp/hymem-e2e-test',
          removeTempDir: (path: string) => calls.push(`remove:${path}`),
          getPort: async () => 45678,
          spawnProcess,
          waitForReady: async () => ({ workerPid: 102, workerPort: 45679, workerTokenFile: 'C:/tmp/hymem-e2e-test/worker-token-12345678-1234-1234-1234-123456789abc', engine: { engine: 'mock' } }),
          stopWorker: async (ownership: unknown) => {
            workerCleanup.push(ownership)
            calls.push('stop-worker:102')
            return { ok: true }
          },
          stopProcess: async (process: { pid?: number }) => calls.push(`stop:${process.pid}`),
        },
        async ({ env }: { env: Record<string, string | undefined> }) => {
          expect(env.HYMEM_OWNED_WORKER_PID).toBe('102')
          expect(env.HYMEM_OWNED_WORKER_PORT).toBe('45679')
          expect(env.HYMEM_OWNED_WORKER_TOKEN_FILE).toBe('C:/tmp/hymem-e2e-test/worker-token-12345678-1234-1234-1234-123456789abc')
          expect(env.HYMEM_OWNED_STUDIO_PID).toBe('101')
          calls.push('suite')
          throw new Error('suite failed')
        },
      ),
    ).rejects.toThrow('suite failed')

    expect(calls).toEqual([
      'spawn:C:\\repo\\dist\\bundle\\cli.js serve --engine mock --ui-port 45678 --data-dir C:/tmp/hymem-e2e-test --json',
      'suite',
      'stop-worker:102',
      'stop:101',
      'remove:C:/tmp/hymem-e2e-test',
    ])
    expect(workerCleanup).toEqual([expect.objectContaining({
      workerPid: 102,
      workerPort: 45679,
      studioPid: 101,
      tokenPath: 'C:/tmp/hymem-e2e-test/worker-token-12345678-1234-1234-1234-123456789abc',
      engine: 'mock',
    })])
  })

  it('uses an explicit isolated bundle directory for the owned Studio and its suites', async () => {
    let cliPath = ''
    let childEnvironment: Record<string, string | undefined> = {}
    const child = {
      pid: 401,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
    }
    await withIsolatedStudio({
      root: 'C:/repo',
      environment: { HYMEM_BUNDLE_DIR: 'C:/validation/bundle' },
      python: 'python',
      createTempDir: () => 'C:/tmp/hymem-e2e-bundle',
      removeTempDir: () => undefined,
      getPort: async () => 45678,
      spawnProcess: (_command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
        cliPath = args[0] ?? ''
        childEnvironment = options.env
        return child
      },
      waitForReady: async () => ({ workerPid: 402, workerPort: 45679, workerTokenFile: 'C:/tmp/hymem-e2e-bundle/worker-token-12345678-1234-1234-1234-123456789abc', engine: { engine: 'mock' } }),
      stopWorker: async () => ({ ok: true }),
      stopProcess: async () => undefined,
    }, async ({ env }: { env: Record<string, string | undefined> }) => {
      expect(env.HYMEM_BUNDLE_DIR).toBe('C:/validation/bundle')
    })

    expect(cliPath).toBe(join('C:/validation/bundle', 'cli.js'))
    expect(childEnvironment.HYMEM_BUNDLE_DIR).toBe('C:/validation/bundle')
  })

  it('cleans a reported worker when authenticated Studio readiness fails', async () => {
    const calls: string[] = []
    const child = {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
    }
    await expect(withIsolatedStudio({
      root: 'C:/repo',
      environment: {},
      python: 'python',
      createTempDir: () => 'C:/tmp/hymem-e2e-startup',
      removeTempDir: (path: string) => calls.push(`remove:${path}`),
      getPort: async () => 45678,
      spawnProcess: () => child,
      waitForReady: async (_child: unknown, _url: string, _dataDir: string, options: {
        onReadiness: (readiness: { workerPid: number; workerPort: number; workerTokenFile: string; engine: { engine: string } }) => void
      }) => {
        options.onReadiness({ workerPid: 102, workerPort: 45679, workerTokenFile: 'C:/tmp/hymem-e2e-startup/worker-token-12345678-1234-1234-1234-123456789abc', engine: { engine: 'mock' } })
        throw new Error('Studio identity mismatch')
      },
      stopWorker: async (ownership: { workerPid: number; workerPort: number; tokenPath: string }) => {
        calls.push(`worker:${ownership.workerPid}:${ownership.workerPort}`)
        expect(ownership.tokenPath).toBe('C:/tmp/hymem-e2e-startup/worker-token-12345678-1234-1234-1234-123456789abc')
        return { ok: true }
      },
      stopProcess: async (process: { pid?: number }) => calls.push(`studio:${process.pid}`),
    }, async () => undefined)).rejects.toThrow('Studio identity mismatch')

    expect(calls).toEqual([
      'worker:102:45679',
      'studio:101',
      'remove:C:/tmp/hymem-e2e-startup',
    ])
  })

  it('signals only its own POSIX Studio process group even after the leader exits', async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    const leader = { pid: 501, exitCode: 0, signalCode: null }
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      signals.push([pid, signal])
      if (signal === 0) throw Object.assign(new Error('no such process group'), { code: 'ESRCH' })
    }

    await stopOwnedStudioTree(leader, { platform: 'linux', kill })

    expect(signals).toContainEqual([-501, 'SIGTERM'])
    expect(signals.some(([pid]) => pid > 0 || pid < -501)).toBe(false)
  })

  it('kills only the supplied isolated mock worker and records token ownership safely', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-e2e-worker-'))
    const token = 'private-worker-token-for-this-test'
    const tokenPath = join(dataDir, 'worker-token-12345678-1234-1234-1234-123456789abc')
    writeFileSync(tokenPath, `${token}\n`)
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    let alive = true
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      signals.push([pid, signal])
      if (signal === 'SIGTERM') alive = false
      if (signal === 0 && !alive) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }

    try {
      const result = await stopOwnedMockWorker({
        isolated: '1',
        engine: 'mock',
        dataDir,
        workerPid: '202',
        workerPort: '34567',
        studioPid: '101',
        tokenPath,
        currentPid: 303,
        kill,
        fetchImpl: async (url: string, options: { headers: Record<string, string> }) => {
          expect(url).toBe('http://127.0.0.1:34567/v1/health')
          expect(options.headers.authorization).toBe(`Bearer ${token}`)
          return { status: 200, json: async () => ({ engine: 'mock' }) }
        },
        timeoutMs: 10,
        pollIntervalMs: 1,
      })

      expect(result.ok).toBe(true)
      expect(result.evidence).toMatchObject({ workerPid: 202, studioPid: 101, engine: 'mock', dataDir })
      expect(result.evidence.tokenSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(result)).not.toContain(token)
      expect(signals).toContainEqual([202, 'SIGTERM'])
      expect(signals.some(([pid]) => pid !== 202)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects shared or out-of-directory worker token paths before probing or killing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-e2e-worker-path-'))
    const signals: Array<[number, NodeJS.Signals | 0]> = []
    try {
      const result = await stopOwnedMockWorker({
        isolated: '1',
        engine: 'mock',
        dataDir,
        workerPid: '202',
        workerPort: '34567',
        studioPid: '101',
        currentPid: 303,
        tokenPath: join(dataDir, 'worker-token'),
        kill: (pid: number, signal: NodeJS.Signals | 0) => signals.push([pid, signal]),
        fetchImpl: async () => { throw new Error('must not probe before validating token path') },
      })

      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('worker token path') })
      expect(signals).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('prints both safe causes when isolated Studio startup and cleanup fail', async () => {
    const errorOutput: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errorOutput.push(args.join(' ')))
    try {
      const result = await runE2E({
        root: 'C:/repo',
        environment: {},
        suites: [],
        withStudio: async () => {
          throw new AggregateError([new Error('serve worker startup failed'), new Error('owned worker cleanup timed out')], 'isolated Studio run and cleanup both failed')
        },
      })

      expect(result.ok).toBe(false)
      expect(errorOutput.join('\n')).toContain('serve worker startup failed')
      expect(errorOutput.join('\n')).toContain('owned worker cleanup timed out')
    } finally {
      spy.mockRestore()
    }
  })
})
