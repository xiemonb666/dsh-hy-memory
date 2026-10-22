import { describe, expect, it, vi } from 'vitest'
import { isStrictLoopbackHttpUrl } from '../../packages/host-plugin/src/egress.js'
import { EngineClient, EngineUnavailableError } from '../../packages/host-plugin/src/engine.js'
import { DEFAULT_SETTINGS } from '../../packages/contracts/src/index.js'
import { normalizeConfig } from '../../packages/host-plugin/src/config.js'
import { startWorker } from '../../packages/host-plugin/src/worker.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

describe('outbound policy', () => {
  it('accepts only explicit HTTP(S) loopback URLs without credentials', () => {
    expect(isStrictLoopbackHttpUrl('http://127.0.0.1:4312')).toBe(true)
    expect(isStrictLoopbackHttpUrl('https://[::1]:4312/path')).toBe(true)
    expect(isStrictLoopbackHttpUrl('http://localhost:4312')).toBe(true)
    expect(isStrictLoopbackHttpUrl('http://memory.local:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('http://127.0.0.2:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('http://2130706433:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('http://0177.0.0.1:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('ftp://127.0.0.1:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('http://user:pass@127.0.0.1:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('http://@127.0.0.1:4312')).toBe(false)
    expect(isStrictLoopbackHttpUrl('not a URL')).toBe(false)
  })

  it('checks health but blocks model data requests when the saved policy denies egress', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ engine: 'hy-memory' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new EngineClient({
        baseUrl: 'http://127.0.0.1:4312',
        token: 'test-token',
        modelPolicy: () => DEFAULT_SETTINGS.models,
      })
      await expect(client.ingest({
        jobId: 'job',
        namespace: 'project:test',
        scene: 'chat',
        messages: [],
        toolOutcomes: [],
        observedAt: '2026-10-21T00:00:00Z',
      })).rejects.toBeInstanceOf(EngineUnavailableError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/health')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('disables fetch redirects for worker requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return new Response(JSON.stringify({ engine: 'mock' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new EngineClient({ baseUrl: 'http://127.0.0.1:4312', token: 'test-token' })
      await expect(client.health()).resolves.toMatchObject({ engine: 'mock' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rechecks the latest policy and rejects a worker after permissions change', async () => {
    let policy: typeof DEFAULT_SETTINGS.models = { ...DEFAULT_SETTINGS.models, externalEgress: 'allow-configured' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.endsWith('/v1/health')
        ? new Response(JSON.stringify({ engine: 'hy-memory' }), { status: 200 })
        : new Response(JSON.stringify({ engineMemoryIds: [], candidates: [], elapsedMs: 0 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new EngineClient({
        baseUrl: 'http://127.0.0.1:4312',
        token: 'test-token',
        modelPolicy: () => policy,
      })
      const input = {
        jobId: 'job',
        namespace: 'project:test',
        scene: 'chat' as const,
        messages: [],
        toolOutcomes: [],
        observedAt: '2026-10-21T00:00:00Z',
      }
      await expect(client.ingest(input)).resolves.toMatchObject({ engineMemoryIds: [] })
      policy = { ...policy, externalEgress: 'deny' }
      await expect(client.ingest(input)).rejects.toThrow(/policy changed since worker startup/)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/v1/health')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('counts the policy health guard inside ingest and search request timeouts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/health')) {
        await new Promise(resolve => setTimeout(resolve, 45))
        return new Response(JSON.stringify({ engine: 'hy-memory' }), { status: 200 })
      }
      return new Response(JSON.stringify({ engineMemoryIds: [], candidates: [], elapsedMs: 0, results: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const policy = { ...DEFAULT_SETTINGS.models, externalEgress: 'allow-configured' as const, localOnly: false }
      const client = new EngineClient({ baseUrl: 'http://127.0.0.1:4312', token: 'test-token', timeoutMs: 15, modelPolicy: () => policy })
      await expect(client.ingest({
        jobId: 'job',
        namespace: 'project:test',
        scene: 'chat',
        messages: [],
        toolOutcomes: [],
        observedAt: '2026-10-21T00:00:00Z',
      })).rejects.toThrow(/timeout/)
      await new Promise(resolve => setTimeout(resolve, 50))
      await expect(client.search({
        namespace: 'project:test',
        query: 'query',
        limit: 1,
        allowIds: [],
      }, 15)).rejects.toThrow(/timeout/)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls.every(call => String(call[0]).endsWith('/v1/health'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses a non-loopback worker URL before creating a client that could send a bearer', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-egress-test-'))
    try {
      const config = normalizeConfig({
        dataDir,
        worker: { url: 'https://worker.example.com:4312', token: 'synthetic-token', autoSpawn: false },
      })
      await expect(startWorker(config, dataDir, { info: () => undefined, warn: () => undefined })).rejects.toThrow(/loopback/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('passes the persisted policy snapshot to the managed Python worker environment', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-managed-test-'))
    const policy = { ...DEFAULT_SETTINGS.models, externalEgress: 'allow-configured' as const, localOnly: false }
    let childEnv: NodeJS.ProcessEnv | undefined
    const child = Object.assign(new EventEmitter(), {
      pid: 54123,
      killed: true,
      exitCode: 0,
      stdout: undefined,
      stderr: undefined,
      stdin: undefined,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', 0, null))
        return true
      }),
    })
    spawnMock.mockImplementation((_python: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      childEnv = options.env
      const portFile = args[args.indexOf('--port-file') + 1]
      if (!portFile) throw new Error('test worker spawn did not receive --port-file')
      writeFileSync(portFile, '4312', 'utf8')
      return child
    })
    vi.stubEnv('HYMEM_MODEL_POLICY', '{"externalEgress":"deny"}')
    try {
      const config = normalizeConfig({ dataDir, worker: { autoSpawn: true, engine: 'mock' } })
      const worker = await startWorker(config, dataDir, { info: () => undefined, warn: () => undefined }, { modelPolicy: () => policy })
      expect(childEnv?.HYMEM_MODEL_POLICY).toBe(JSON.stringify(policy))
      expect(childEnv?.PYTHONPATH).toContain(join(dataDir, 'python'))
      expect(worker.owned).toBe(true)
      expect(worker.pid).toBe(54123)
      await worker.stop()
    } finally {
      vi.unstubAllEnvs()
      spawnMock.mockReset()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects an attached SDK worker when localOnly endpoints cannot be verified', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-attached-test-'))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.endsWith('/v1/health')
        ? new Response(JSON.stringify({ engine: 'hy-memory' }), { status: 200 })
        : new Response(JSON.stringify({ engineMemoryIds: [], candidates: [], elapsedMs: 0 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const config = normalizeConfig({
        dataDir,
        worker: { url: 'http://localhost:4312', token: 'synthetic-token', autoSpawn: false },
      })
      const policy = { ...DEFAULT_SETTINGS.models, externalEgress: 'allow-configured' as const, localOnly: true }
      const worker = await startWorker(config, dataDir, { info: () => undefined, warn: () => undefined }, { modelPolicy: () => policy })
      await expect(worker.client.ingest({
        jobId: 'job',
        namespace: 'project:test',
        scene: 'chat',
        messages: [],
        toolOutcomes: [],
        observedAt: '2026-10-21T00:00:00Z',
      })).rejects.toThrow(/cannot be verified as loopback/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('allows attached SDK requests only with explicit configured external egress', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-attached-allowed-test-'))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.endsWith('/v1/health')
        ? new Response(JSON.stringify({ engine: 'hy-memory' }), { status: 200 })
        : new Response(JSON.stringify({ engineMemoryIds: [], candidates: [], elapsedMs: 0 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const config = normalizeConfig({
        dataDir,
        worker: { url: 'http://127.0.0.1:4312', token: 'synthetic-token', autoSpawn: false },
      })
      const policy = { ...DEFAULT_SETTINGS.models, externalEgress: 'allow-configured' as const, localOnly: false }
      const worker = await startWorker(config, dataDir, { info: () => undefined, warn: () => undefined }, { modelPolicy: () => policy })
      await expect(worker.client.ingest({
        jobId: 'job',
        namespace: 'project:test',
        scene: 'chat',
        messages: [],
        toolOutcomes: [],
        observedAt: '2026-10-21T00:00:00Z',
      })).resolves.toMatchObject({ engineMemoryIds: [] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps deterministic mock data operations available under the default deny policy', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return String(input).endsWith('/v1/health')
        ? new Response(JSON.stringify({ engine: 'mock' }), { status: 200 })
        : new Response(JSON.stringify({ engineMemoryIds: [], candidates: [], elapsedMs: 0 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new EngineClient({ baseUrl: 'http://127.0.0.1:4312', token: 'test-token' })
      await expect(client.ingest({
        jobId: 'job',
        namespace: 'project:test',
        scene: 'chat',
        messages: [],
        toolOutcomes: [],
        observedAt: '2026-10-21T00:00:00Z',
      })).resolves.toMatchObject({ engineMemoryIds: [] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
