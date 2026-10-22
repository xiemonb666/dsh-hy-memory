import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CaptureEnvelope } from '../../packages/contracts/src/index.js'
import { GovernanceStore } from '@dsh-hy-memory/governance'
import { normalizeConfig } from '../../packages/host-plugin/src/config.js'
import { CapturePipeline } from '../../packages/host-plugin/src/capture.js'
import { RecallController } from '../../packages/host-plugin/src/recall.js'

describe('persisted capture settings', () => {
  let dataDir = ''

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    dataDir = ''
  })

  it('clears buffered and queued work when persisted capture is disabled', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hymem-capture-settings-'))
    const settings = {
      enabled: true,
      capture: { enabled: true },
    }
    const store = {
      getSettings: vi.fn(() => ({ settings })),
      ensureWorkspace: vi.fn(),
      appendSourceEvent: vi.fn(() => ({ id: 'event-1' })),
      addEvidence: vi.fn(() => ({ id: 'evidence-1' })),
    }
    const engine = { ingest: vi.fn() }
    const enqueue = vi.fn()
    const pipeline = new CapturePipeline({
      store: store as never,
      engine: engine as never,
      config: normalizeConfig({ dataDir }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cwd: () => dataDir,
      enqueue,
    })

    pipeline.observe('session-1', {
      type: 'user/message',
      seq: 1,
      data: { content: 'Please remember the local test setting.' },
    })
    expect(store.appendSourceEvent).toHaveBeenCalledTimes(1)

    settings.capture.enabled = false
    pipeline.observe('session-1', {
      type: 'user/message',
      seq: 2,
      data: { content: 'This message must not be captured.' },
    })
    await expect(pipeline.flush('session-1')).resolves.toBeNull()
    await expect(pipeline.process({} as CaptureEnvelope, 'queued-job')).resolves.toEqual({
      created: [],
      needsReview: [],
      rejected: 0,
    })
    expect(store.appendSourceEvent).toHaveBeenCalledTimes(1)
    expect(enqueue).not.toHaveBeenCalled()
    expect(engine.ingest).not.toHaveBeenCalled()
    expect(() => pipeline.assertEnabled()).toThrow(/capture is disabled/)
  })

  it.each([
    { label: 'the plugin setting', pluginEnabled: false, persistedCaptureEnabled: true, configEnabled: true },
    { label: 'the host config', pluginEnabled: true, persistedCaptureEnabled: true, configEnabled: false },
  ])('honors $label when observing events', ({ pluginEnabled, persistedCaptureEnabled, configEnabled }) => {
    dataDir = mkdtempSync(join(tmpdir(), 'hymem-capture-disabled-'))
    const store = {
      getSettings: vi.fn(() => ({ settings: { enabled: pluginEnabled, capture: { enabled: persistedCaptureEnabled } } })),
      ensureWorkspace: vi.fn(),
      appendSourceEvent: vi.fn(),
      addEvidence: vi.fn(),
    }
    const pipeline = new CapturePipeline({
      store: store as never,
      engine: { ingest: vi.fn() } as never,
      config: normalizeConfig({ dataDir, capture: { enabled: configEnabled } }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cwd: () => dataDir,
      enqueue: vi.fn(),
    })
    pipeline.observe('session-1', { type: 'user/message', seq: 1, data: { content: 'must not capture' } })
    expect(store.appendSourceEvent).not.toHaveBeenCalled()
    expect(() => pipeline.assertEnabled()).toThrow(/capture is disabled/)
  })

  it('drops buffered work after settings change even when capture was re-enabled between calls', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hymem-capture-reenabled-'))
    const persisted = { revision: 1, settings: { enabled: true, capture: { enabled: true } } }
    const store = {
      getSettings: vi.fn(() => persisted),
      ensureWorkspace: vi.fn(),
      appendSourceEvent: vi.fn(() => ({ id: 'event-1' })),
      addEvidence: vi.fn(() => ({ id: 'evidence-1' })),
    }
    const enqueue = vi.fn()
    const pipeline = new CapturePipeline({
      store: store as never,
      engine: { ingest: vi.fn() } as never,
      config: normalizeConfig({ dataDir }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cwd: () => dataDir,
      enqueue,
    })
    pipeline.observe('session-1', { type: 'user/message', seq: 1, data: { content: 'Buffered before settings changed.' } })
    persisted.settings.capture.enabled = false
    persisted.revision++
    persisted.settings.capture.enabled = true
    persisted.revision++

    await expect(pipeline.flush('session-1')).resolves.toBeNull()
    expect(enqueue).not.toHaveBeenCalled()
    pipeline.observe('session-1', { type: 'user/message', seq: 2, data: { content: 'Fresh after re-enabling capture.' } })
    await pipeline.flush('session-1')
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0]?.[0].messages).toEqual([{ role: 'user', content: 'Fresh after re-enabling capture.' }])
  })

  it('does not touch the closed store when an in-flight ingest resolves after disposal', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hymem-capture-dispose-late-'))
    let releaseIngest!: (value: { engineMemoryIds: string[]; candidates: []; elapsedMs: number }) => void
    let ingestStarted!: () => void
    const started = new Promise<void>(resolve => { ingestStarted = resolve })
    const pendingIngest = new Promise<{ engineMemoryIds: string[]; candidates: []; elapsedMs: number }>(resolve => {
      releaseIngest = resolve
    })
    let closed = false
    const callsAfterClose: string[] = []
    const assertOpen = (method: string): void => {
      if (closed) {
        callsAfterClose.push(method)
        throw new Error(`database is closed: ${method}`)
      }
    }
    const store = {
      getSettings: vi.fn(() => {
        assertOpen('getSettings')
        return { revision: 1, settings: { enabled: true, capture: { enabled: true } } }
      }),
      evidenceForSourceEvents: vi.fn(() => {
        assertOpen('evidenceForSourceEvents')
        return []
      }),
      recordUsage: vi.fn(() => assertOpen('recordUsage')),
    }
    const pipeline = new CapturePipeline({
      store: store as never,
      engine: { ingest: vi.fn(() => { ingestStarted(); return pendingIngest }) } as never,
      config: normalizeConfig({ dataDir }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cwd: () => dataDir,
      enqueue: vi.fn(),
    })
    const envelope = {
      projectId: 'project-late',
      workspaceId: 'workspace-late',
      agentId: 'agent-late',
      sessionId: 'session-late',
      sceneCandidate: 'chat',
      messages: [],
      toolOutcomes: [],
      sourceEventIds: [],
      observedAt: new Date().toISOString(),
    }

    const processing = pipeline.process(envelope as never, 'late-job')
    await started
    await pipeline.dispose()
    closed = true
    releaseIngest({ engineMemoryIds: [], candidates: [], elapsedMs: 1 })

    await expect(processing).resolves.toEqual({ created: [], needsReview: [], rejected: 0 })
    expect(callsAfterClose).toEqual([])
    expect(store.evidenceForSourceEvents).not.toHaveBeenCalled()
    expect(store.recordUsage).not.toHaveBeenCalled()
  })

  it('discards an in-flight result when settings changed even if capture is enabled again', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hymem-capture-revision-late-'))
    let releaseIngest!: (value: { engineMemoryIds: string[]; candidates: []; elapsedMs: number }) => void
    let ingestStarted!: () => void
    const started = new Promise<void>(resolve => { ingestStarted = resolve })
    const pendingIngest = new Promise<{ engineMemoryIds: string[]; candidates: []; elapsedMs: number }>(resolve => {
      releaseIngest = resolve
    })
    const persisted = { revision: 1, settings: { enabled: true, capture: { enabled: true } } }
    const store = {
      getSettings: vi.fn(() => persisted),
      evidenceForSourceEvents: vi.fn(() => []),
      recordUsage: vi.fn(),
    }
    const pipeline = new CapturePipeline({
      store: store as never,
      engine: { ingest: vi.fn(() => { ingestStarted(); return pendingIngest }) } as never,
      config: normalizeConfig({ dataDir }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cwd: () => dataDir,
      enqueue: vi.fn(),
    })
    const envelope = {
      projectId: 'project-revision',
      workspaceId: 'workspace-revision',
      agentId: 'agent-revision',
      sessionId: 'session-revision',
      sceneCandidate: 'chat',
      messages: [],
      toolOutcomes: [],
      sourceEventIds: [],
      observedAt: new Date().toISOString(),
    }

    const processing = pipeline.process(envelope as never, 'revision-job')
    await started
    persisted.settings.capture.enabled = false
    persisted.revision++
    persisted.settings.capture.enabled = true
    persisted.revision++
    releaseIngest({ engineMemoryIds: [], candidates: [], elapsedMs: 1 })

    await expect(processing).resolves.toEqual({ created: [], needsReview: [], rejected: 0 })
    expect(store.getSettings).toHaveBeenCalledTimes(2)
    expect(store.evidenceForSourceEvents).not.toHaveBeenCalled()
    expect(store.recordUsage).not.toHaveBeenCalled()
  })

  it('does not touch a closed database when a semantic recall result arrives after disposal', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hymem-recall-dispose-late-'))
    const store = new GovernanceStore(join(dataDir, 'governance.db'))
    store.ensureProject('project-recall-late')
    store.ensureWorkspace({ id: 'workspace-recall-late', projectId: 'project-recall-late', repoFingerprint: 'fp-late', rootAlias: 'C:/late' })
    store.ensureOwner()
    store.createMemory({
      scene: 'coding',
      kind: 'fact',
      title: 'late recall fixture',
      content: 'semantic guidance should be ignored after shutdown',
      status: 'supported',
      scope: 'project',
      projectId: 'project-recall-late',
      workspaceId: 'workspace-recall-late',
      authorPrincipalId: 'owner',
      engineId: 'engine-late-recall',
    }, 'owner')

    let releaseSearch!: (value: { results: Array<{ engineMemoryId: string; governanceId: null; text: string; score: number; scene: 'coding'; kind: 'fact' }>; elapsedMs: number }) => void
    let searchStarted!: () => void
    const started = new Promise<void>(resolve => { searchStarted = resolve })
    const pendingSearch = new Promise<{ results: Array<{ engineMemoryId: string; governanceId: null; text: string; score: number; scene: 'coding'; kind: 'fact' }>; elapsedMs: number }>(resolve => {
      releaseSearch = resolve
    })
    const engine = { search: vi.fn(() => { searchStarted(); return pendingSearch }) }
    const recall = new RecallController({
      store,
      engine: engine as never,
      config: normalizeConfig({ dataDir }),
      workspace: () => ({
        projectId: 'project-recall-late',
        workspaceId: 'workspace-recall-late',
        repoFingerprint: 'fp-late',
        rootAlias: 'C:/late',
      }),
    })
    const recordInjection = vi.spyOn(store, 'recordInjection')
    const recordUsage = vi.spyOn(store, 'recordUsage')
    let closed = false
    const lateResult = {
      results: [{ engineMemoryId: 'engine-late-recall', governanceId: null as null, text: 'late clue', score: 0.9, scene: 'coding' as const, kind: 'fact' as const }],
      elapsedMs: 1,
    }
    let pending: Promise<unknown> | undefined

    try {
      pending = recall.search({
        principalId: 'owner',
        agentId: 'agent-recall-late',
        sessionId: 'session-recall-late',
        query: 'semantic guidance after dispose',
      })
      await started
      await recall.dispose()
      store.close()
      closed = true
      await expect(pending).resolves.toMatchObject({ clues: [], rendered: '', degraded: 'aborted' })
      releaseSearch(lateResult)
      await Promise.resolve()
      await Promise.resolve()

      expect(recordInjection).not.toHaveBeenCalled()
      expect(recordUsage).not.toHaveBeenCalled()
    } finally {
      releaseSearch(lateResult)
      if (!closed) {
        await pending?.catch(() => undefined)
        store.close()
      }
    }
  })
})
