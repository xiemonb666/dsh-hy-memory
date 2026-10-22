import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { createPrestepHandler, latestOrdinaryUserText } from '../../packages/host-plugin/src/prestep.js'
import { createQueueDrain } from '../../packages/host-plugin/src/queue-runtime.js'
import type { MessageLike } from '../../packages/host-plugin/src/dsh-types.js'

const nativeLifecycleMocks = vi.hoisted(() => ({ startWorker: vi.fn(), studioStart: vi.fn(), studioClose: vi.fn() }))
vi.mock('../../packages/host-plugin/src/worker.js', () => ({ startWorker: nativeLifecycleMocks.startWorker }))
vi.mock('../../packages/host-plugin/src/studio.js', () => ({
  StudioServer: class {
    start(): Promise<number> { return nativeLifecycleMocks.studioStart() }
    close(): Promise<void> { return nativeLifecycleMocks.studioClose() }
  },
  resolveStudioDir: () => 'mock-studio',
  resolveUiToken: () => ({ token: 'mock-ui-token' }),
}))
import { apply as applyNativePlugin, runtime as currentNativeRuntime } from '../../packages/host-plugin/src/index.js'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve: value => resolve(value) }
}

function fakeNativeSession(id: string): { session: object; append: ReturnType<typeof vi.fn> } {
  const nodes: number[] = []
  const messages = new Map<number, MessageLike>()
  let nextSeq = 0
  const append = vi.fn((type: string, data: unknown, options: { surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number } }) => {
    const seq = nextSeq++
    const message = (type === 'user/message' ? data : (data as { message?: unknown }).message) as MessageLike
    if (options.surfaceOp === 'append') {
      nodes.push(seq)
    } else {
      const index = nodes.indexOf(options.surfaceOp.startSeq)
      if (index >= 0) nodes.splice(index, 1, seq)
      messages.delete(options.surfaceOp.startSeq)
    }
    messages.set(seq, message)
  })
  const session = {
    id,
    get seq() { return nextSeq },
    surface: { nodes },
    deriveMessages: () => nodes.flatMap(seq => {
      const message = messages.get(seq)
      const content = message?.content
      const visible = typeof content === 'string'
        ? content.trim().length > 0
        : Array.isArray(content) && content.some(block => block.type !== 'text' || (typeof block.text === 'string' && block.text.trim().length > 0))
      return message && visible ? [message] : []
    }),
    append,
  }
  return { session, append }
}

describe('native pre-step adapter', () => {
  it('does not claim a future ordinary message when clearing owned context fails', async () => {
    const { session, append } = fakeNativeSession('failed-native-clear')
    const native = session as { deriveMessages(): MessageLike[] }
    let enabled = true
    const handler = createPrestepHandler({
      enabled: () => enabled,
      lookup: async () => ({ clues: [{ id: 'memory-1' }], rendered: '<memory_clues>safe fact</memory_clues>' }),
    })
    const enter = () => handler(
      { agent: { session: session as never }, messages: [], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: 'retrieve a fact' }] }),
    )
    await enter()
    enabled = false
    append.mockImplementationOnce(() => { throw new Error('native surface rejected clear') })
    await enter()
    append('user/message', { role: 'user', content: [{ type: 'text', text: 'ordinary message after failed clear' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    await enter()
    enabled = true
    await enter()

    expect(native.deriveMessages()).toContainEqual(expect.objectContaining({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'ordinary message after failed clear' }],
    }))
  })

  it('awaits the downstream decision once and preserves its complete accepted result', async () => {
    const decision = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'downstream batch' }] }],
      startsRequestSeries: true,
      acceptedBy: 'downstream',
    }
    const next = vi.fn(async () => decision)
    const handler = createPrestepHandler({ enabled: () => false })

    const result = await handler(
      { agent: { session: { id: 'session-1' } }, messages: [], turn: 1, step: 1 },
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(result).toBe(decision)
  })

  it('extracts the latest ordinary user text and ignores injected context messages', () => {
    expect(latestOrdinaryUserText([
      { role: 'user', content: [{ type: 'text', text: 'first request' }], source: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } },
      { role: 'user', content: [{ type: 'text', text: 'old memory' }], source: { kind: 'hymem:clues' } },
      { role: 'user', content: [{ type: 'text', text: 'latest request' }] },
    ])).toBe('latest request')
  })

  it('looks up accepted ordinary user text and appends one identified native context message', async () => {
    const { session, append } = fakeNativeSession('session-2')
    const lookup = vi.fn(async () => ({ clues: [{ id: 'memory-1' }], rendered: '<memory_clues>fact</memory_clues>' }))
    const decision = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'use current array' }], source: { kind: 'user' } }],
      startsRequestSeries: true,
    }
    const handler = createPrestepHandler({ enabled: () => true, lookup })
    const result = await handler(
      {
        agent: { session: session as never },
        messages: [],
        turn: 4,
        step: 1,
      },
      async () => decision,
    )

    expect(result).toBe(decision)
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ query: 'use current array', turn: 4 }))
    expect(append).toHaveBeenCalledOnce()
    expect(append).toHaveBeenCalledWith(
      'user/message',
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        role: 'user',
        content: [{ type: 'text', text: '<memory_clues>fact</memory_clues>' }],
        source: expect.objectContaining({ kind: 'hymem:clues', form: 'context', summary: 'memory clues' }),
      }),
      { surfaceOp: 'append' },
    )
  })

  it('returns a downstream reject unchanged without registering or recalling', async () => {
    const reject = { kind: 'reject', reason: 'downstream policy' }
    const next = vi.fn(async () => reject)
    const registerAgent = vi.fn()
    const lookup = vi.fn()
    const { session, append } = fakeNativeSession('session-reject')
    const handler = createPrestepHandler({ enabled: () => true, registerAgent, lookup })
    const result = await handler(
      {
        agent: { session: session as never },
        messages: [],
        turn: 1,
        step: 1,
      },
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(result).toBe(reject)
    expect(registerAgent).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('does not append recall results when the accepted step is aborted during lookup', async () => {
    const controller = new AbortController()
    let finishLookup!: (value: { clues: unknown[]; rendered: string }) => void
    const lookupStarted = deferred<void>()
    const lookup = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal)
      lookupStarted.resolve(undefined)
      return await new Promise<{ clues: unknown[]; rendered: string }>(resolve => { finishLookup = resolve })
    })
    const { session, append } = fakeNativeSession('session-abort')
    const handler = createPrestepHandler({ enabled: () => true, lookup })
    const pending = handler(
      {
        agent: { session: session as never },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'query' }] }],
        turn: 2,
        step: 1,
        signal: controller.signal,
      },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: 'query' }] }),
    )
    await lookupStarted.promise
    controller.abort()
    await pending
    finishLookup({ clues: [{ id: 'memory-1' }], rendered: 'late clue' })

    expect(append).not.toHaveBeenCalled()
  })

  it('does not recall or rewrite the surface outside a configured task boundary', async () => {
    const lookup = vi.fn()
    const { session, append } = fakeNativeSession('session-boundary')
    const decision = { kind: 'enter', messages: [{ role: 'user', content: 'follow-up step' }], startsRequestSeries: false }
    const handler = createPrestepHandler({ enabled: () => true, shouldLookup: payload => payload.step === 1, lookup })

    const result = await handler(
      {
        agent: { session: session as never },
        messages: [],
        turn: 3,
        step: 2,
      },
      async () => decision,
    )

    expect(result).toBe(decision)
    expect(lookup).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('keeps an already-aborted accepted step free of plugin side effects', async () => {
    const controller = new AbortController()
    controller.abort()
    const registerAgent = vi.fn()
    const lookup = vi.fn()
    const { session, append } = fakeNativeSession('session-aborted-before-plugin')
    const handler = createPrestepHandler({ enabled: () => true, registerAgent, lookup })
    const decision = { kind: 'enter', messages: [{ role: 'user', content: 'query' }] }

    const result = await handler(
      {
        agent: { session: session as never },
        messages: [],
        turn: 1,
        step: 1,
        signal: controller.signal,
      },
      async () => decision,
    )

    expect(result).toBe(decision)
    expect(registerAgent).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('keeps the downstream accepted decision when agent registration fails', async () => {
    const decision = { kind: 'enter', messages: [] }
    const logger = { warn: vi.fn() }
    const handler = createPrestepHandler({
      enabled: () => false,
      registerAgent: () => { throw new Error('store unavailable') },
      logger,
    })

    const result = await handler(
      { agent: { session: { id: 'session-register-error' } }, messages: [], turn: 1, step: 1 },
      async () => decision,
    )

    expect(result).toBe(decision)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'))
  })
})

describe('native queue drain lifecycle', () => {
  it('leaves queued work untouched when persisted capture is disabled', async () => {
    const leaseJobs = vi.fn(() => [])
    const queue = createQueueDrain({
      store: {
        getSettings: () => ({ settings: { enabled: true, capture: { enabled: false } } }),
        leaseJobs,
        completeJob: vi.fn(),
        failJob: vi.fn(),
      },
      process: vi.fn(),
      concurrency: 2,
      logger: { warn: vi.fn() },
    })

    await queue.drain()

    expect(leaseJobs).not.toHaveBeenCalled()
  })

  it('leaves queued work untouched when plugin configuration disables capture', async () => {
    const leaseJobs = vi.fn(() => [])
    const queue = createQueueDrain({
      store: {
        getSettings: () => ({ settings: { enabled: true, capture: { enabled: true } } }),
        leaseJobs,
        completeJob: vi.fn(),
        failJob: vi.fn(),
      },
      process: vi.fn(),
      concurrency: 2,
      configuredCaptureEnabled: false,
      logger: { warn: vi.fn() },
    })

    await queue.drain()

    expect(leaseJobs).not.toHaveBeenCalled()
  })

  it('leaves a leased job unchanged when capture is disabled while processing', async () => {
    const job = { id: 'job-disabled', payload_json: '{}', idempotency_key: 'disabled', lease_owner: 'host', attempt: 1 }
    let enabled = true
    const failJob = vi.fn()
    const queue = createQueueDrain({
      store: {
        getSettings: () => ({ settings: { enabled: true, capture: { enabled } } }),
        leaseJobs: vi.fn(() => [job]),
        completeJob: vi.fn(),
        failJob,
      },
      process: vi.fn(async () => {
        enabled = false
        throw new Error('capture is disabled by settings')
      }),
      concurrency: 1,
      logger: { warn: vi.fn() },
    })

    await queue.drain()

    expect(failJob).not.toHaveBeenCalled()
  })

  it('records completion with the exact lease fence and reports a stale update', async () => {
    const job = { id: 'job-1', payload_json: '{"kind":"capture"}', idempotency_key: 'idem-1', lease_owner: 'host', attempt: 3 }
    const completeJob = vi.fn(() => false)
    const failJob = vi.fn()
    const warn = vi.fn()
    const queue = createQueueDrain({
      store: {
        getSettings: () => ({ settings: { enabled: true, capture: { enabled: true } } }),
        leaseJobs: vi.fn(() => [job]),
        completeJob,
        failJob,
      },
      process: vi.fn(async envelope => ({ processed: envelope })),
      concurrency: 2,
      logger: { warn },
    })

    await queue.drain()

    expect(completeJob).toHaveBeenCalledWith('job-1', { processed: { kind: 'capture' } }, { owner: 'host', attempt: 3 })
    expect(failJob).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('superseded before completion'))
  })

  it('records retryable failure with the exact lease fence and checks the update result', async () => {
    const job = { id: 'job-2', payload_json: '{"kind":"capture"}', idempotency_key: 'idem-2', lease_owner: 'host', attempt: 4 }
    const failJob = vi.fn(() => false)
    const warn = vi.fn()
    const queue = createQueueDrain({
      store: {
        getSettings: () => ({ settings: { enabled: true, capture: { enabled: true } } }),
        leaseJobs: vi.fn(() => [job]),
        completeJob: vi.fn(),
        failJob,
      },
      process: vi.fn(async () => { throw new Error('worker unavailable') }),
      concurrency: 1,
      logger: { warn },
    })

    await queue.drain()

    expect(failJob).toHaveBeenCalledWith('job-2', 'E_BACKEND_UNAVAILABLE', true, { owner: 'host', attempt: 4 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('superseded before failure recording'))
  })

  it('prevents overlapping drains and ignores a worker result arriving after bounded disposal', async () => {
    const job = { id: 'job-late', payload_json: '{}', idempotency_key: 'late', lease_owner: 'host', attempt: 1 }
    const started = deferred<void>()
    const finish = deferred<unknown>()
    const leaseJobs = vi.fn(() => [job])
    const completeJob = vi.fn()
    const queue = createQueueDrain({
      store: {
        getSettings: () => ({ settings: { enabled: true, capture: { enabled: true } } }),
        leaseJobs,
        completeJob,
        failJob: vi.fn(),
      },
      process: vi.fn(() => {
        started.resolve(undefined)
        return finish.promise
      }),
      concurrency: 1,
      logger: { warn: vi.fn() },
    })
    const firstDrain = queue.drain()
    await started.promise
    await queue.drain()
    await queue.dispose(5)
    finish.resolve({ late: true })
    await firstDrain

    expect(leaseJobs).toHaveBeenCalledTimes(1)
    expect(queue.isDisposed()).toBe(true)
    expect(completeJob).not.toHaveBeenCalled()
  })
})

describe('native Plugins settings entry', () => {
  it('registers the bundle configuration page and routes it to Studio settings', () => {
    let definition: { factory: (require: (name: string) => unknown) => { apply(ctx: unknown): void } } | undefined
    const source = readFileSync(resolve(process.cwd(), 'packages/host-plugin/client/client.js'), 'utf8')
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: (value: typeof definition) => { definition = value } } },
    })
    const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) }
    const client = definition!.factory(name => name === 'react' ? React : undefined)
    const registrations: Array<{ options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }> = []
    const ctx = {
      effect: () => undefined,
      locale: { register: vi.fn(), bind: () => (key: string) => key },
      slots: {
        inject: (_slot: string, callback: () => unknown) => { callback() },
        register: (options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
          registrations.push({ options, component })
          return vi.fn()
        },
      },
      layout: { selectPanel: vi.fn() },
    }
    client.apply(ctx)
    const bundleSettings = registrations.find(item => item.options.name === 'plugins.bundle.config')

    expect(bundleSettings?.options.key).toBe('dsh-hy-memory')
    expect(registrations.some(item => item.options.name === 'conversation.view')).toBe(true)
    expect(registrations.some(item => item.options.name === 'sidebar.panellist')).toBe(true)
    expect(registrations.some(item => item.options.name === 'main')).toBe(true)
    const page = bundleSettings?.component({ t: (key: string) => key, view: 'page' }) as { props?: Record<string, unknown> }
    expect(page.props?.route).toBe('#/settings')
  })
})

describe('native host disposal', () => {
  it('aborts pending pre-step and capture work before closing the plugin store', async () => {
    nativeLifecycleMocks.startWorker.mockReset()
    const ingestStarted = deferred<void>()
    const finishIngest = deferred<{ engineMemoryIds: string[]; candidates: []; elapsedMs: number }>()
    const client = {
      ingest: vi.fn(() => { ingestStarted.resolve(undefined); return finishIngest.promise }),
    }
    const stop = vi.fn(async () => undefined)
    nativeLifecycleMocks.startWorker.mockResolvedValue({ client, port: 1234, token: 'private-test-token', owned: true, stop })
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-full-dispose-'))
    let cleanup: (() => void | Promise<void>) | undefined
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const context = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn((event: string, listener: (...args: never[]) => unknown) => {
        handlers.set(event, listener as (...args: unknown[]) => unknown)
        return vi.fn()
      }),
      effect: (execute: () => (() => void | Promise<void>) | void) => { cleanup = execute() ?? undefined; return vi.fn() },
      tools: { register: vi.fn(() => vi.fn()) },
      systemPrompt: { section: vi.fn(() => vi.fn()), context: vi.fn(() => vi.fn()) },
    }

    try {
      applyNativePlugin(context as never, { dataDir, ui: { enabled: false } })
      await vi.waitFor(() => expect(currentNativeRuntime()).not.toBeNull())
      const active = currentNativeRuntime()!
      const bindAgentSession = vi.spyOn(active.store, 'bindAgentSession')
      const ensureWorkspace = vi.spyOn(active.store, 'ensureWorkspace')
      const capturePromise = active.capture.process({
        projectId: 'project-dispose',
        workspaceId: 'workspace-dispose',
        agentId: 'agent-dispose',
        sessionId: 'session-dispose',
        sceneCandidate: 'chat',
        messages: [],
        toolOutcomes: [],
        sourceEventIds: [],
        observedAt: new Date().toISOString(),
      } as never, 'dispose-job')
      await ingestStarted.promise

      const { session, append } = fakeNativeSession('session-prestep-dispose')
      const next = deferred<unknown>()
      const decision = { kind: 'enter', messages: [{ role: 'user', content: 'pending downstream decision' }] }
      const preStep = handlers.get('agent/pre-step')!
      const preStepPromise = preStep(
        { agent: { session: session as never }, messages: decision.messages, turn: 1, step: 1 },
        () => next.promise,
      ) as Promise<unknown>
      const disposal = cleanup?.()
      await disposal
      next.resolve(decision)

      await expect(preStepPromise).resolves.toBe(decision)
      finishIngest.resolve({ engineMemoryIds: [], candidates: [], elapsedMs: 1 })
      await expect(capturePromise).resolves.toEqual({ created: [], needsReview: [], rejected: 0 })
      expect(bindAgentSession).not.toHaveBeenCalled()
      expect(ensureWorkspace).not.toHaveBeenCalled()
      expect(append).not.toHaveBeenCalled()
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      finishIngest.resolve({ engineMemoryIds: [], candidates: [], elapsedMs: 1 })
      await cleanup?.()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('stops a worker that finishes starting after plugin disposal without publishing a runtime', async () => {
    vi.useFakeTimers()
    nativeLifecycleMocks.startWorker.mockReset()
    const started = deferred<{
      client: object
      port: number
      token: string
      owned: boolean
      stop(): Promise<void>
    }>()
    nativeLifecycleMocks.startWorker.mockReturnValue(started.promise)
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-native-dispose-'))
    let cleanup: (() => void | Promise<void>) | undefined
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const context = {
      logger,
      on: vi.fn(() => vi.fn()),
      effect: (execute: () => (() => void | Promise<void>) | void) => { cleanup = execute() ?? undefined; return vi.fn() },
      tools: { register: vi.fn(() => vi.fn()) },
      systemPrompt: { section: vi.fn(() => vi.fn()), context: vi.fn(() => vi.fn()) },
    }

    try {
      applyNativePlugin(context as never, { dataDir, ui: { enabled: false } })
      expect(nativeLifecycleMocks.startWorker).toHaveBeenCalledOnce()
      const disposal = cleanup?.()
      await vi.advanceTimersByTimeAsync(5_000)
      await disposal

      const stop = vi.fn(async () => undefined)
      started.resolve({ client: {}, port: 1234, token: 'private-test-token', owned: true, stop })
      for (let turn = 0; turn < 5; turn++) await Promise.resolve()

      expect(stop).toHaveBeenCalledOnce()
      expect(currentNativeRuntime()).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('cancels Studio bind retry during disposal and closes only this plugin instance', async () => {
    vi.useFakeTimers()
    nativeLifecycleMocks.startWorker.mockReset()
    nativeLifecycleMocks.studioStart.mockReset().mockRejectedValue(new Error('EADDRINUSE'))
    nativeLifecycleMocks.studioClose.mockReset().mockResolvedValue(undefined)
    const stop = vi.fn(async () => undefined)
    nativeLifecycleMocks.startWorker.mockResolvedValue({ client: {}, port: 1234, token: 'private-test-token', owned: true, stop })
    const dataDir = mkdtempSync(join(tmpdir(), 'hymem-studio-dispose-'))
    let cleanup: (() => void | Promise<void>) | undefined
    const context = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: vi.fn(() => vi.fn()),
      effect: (execute: () => (() => void | Promise<void>) | void) => { cleanup = execute() ?? undefined; return vi.fn() },
      tools: { register: vi.fn(() => vi.fn()) },
      systemPrompt: { section: vi.fn(() => vi.fn()), context: vi.fn(() => vi.fn()) },
    }

    try {
      applyNativePlugin(context as never, { dataDir, ui: { enabled: true, host: '127.0.0.1', port: 48731 } })
      for (let turn = 0; turn < 10 && nativeLifecycleMocks.studioStart.mock.calls.length === 0; turn++) await Promise.resolve()
      expect(nativeLifecycleMocks.studioStart).toHaveBeenCalledOnce()
      const disposal = cleanup?.()
      await disposal
      await vi.advanceTimersByTimeAsync(10_000)

      expect(nativeLifecycleMocks.studioStart).toHaveBeenCalledOnce()
      expect(nativeLifecycleMocks.studioClose).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
