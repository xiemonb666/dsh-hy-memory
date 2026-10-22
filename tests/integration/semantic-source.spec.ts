import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type SearchQuery } from '@dsh-hy-memory/contracts'
import { GovernanceStore } from '@dsh-hy-memory/governance'
import { RetrievalController } from '@dsh-hy-memory/retrieval'
import { buildCandidateSource, semanticCandidates, type SourceContext } from '../../packages/host-plugin/src/sources.js'
import type { EngineClient, EngineSearchHit } from '../../packages/host-plugin/src/engine.js'

let dir: string
let store: GovernanceStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hymem-semantic-source-'))
  store = new GovernanceStore(join(dir, 'governance.db'))
  store.ensureProject('proj-a')
  store.ensureWorkspace({ id: 'ws-a', projectId: 'proj-a', repoFingerprint: 'fp-a', rootAlias: 'C:/semantic-a' })
  store.ensureOwner()
  store.registerPrincipal({ id: 'agent-main', kind: 'agent', name: 'main', role: 'main' })
  store.registerPrincipal({ id: 'agent-sub', kind: 'subagent', name: 'sub', role: 'subagent' })
  store.bindAgentSession({ agentId: 'session-main', principalId: 'agent-main', sessionId: 's-main', projectId: 'proj-a', workspaceId: 'ws-a' })
  store.bindAgentSession({ agentId: 'session-sub', principalId: 'agent-sub', sessionId: 's-sub', parentAgentId: 'session-main', projectId: 'proj-a', workspaceId: 'ws-a' })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function createMemory(options: { title: string; content: string; engineId?: string; scope?: 'workspace' | 'private'; author?: string }) {
  return store.createMemory({
    scene: 'coding',
    kind: 'fact',
    title: options.title,
    content: options.content,
    status: 'supported',
    scope: options.scope ?? 'workspace',
    projectId: 'proj-a',
    workspaceId: 'ws-a',
    authorPrincipalId: options.author ?? 'agent-main',
    ...(options.engineId ? { engineId: options.engineId } : {}),
  }, options.author ?? 'agent-main')
}

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    query: 'queue migration',
    mode: 'semantic',
    projectId: 'proj-a',
    workspaceId: 'ws-a',
    agentId: 'session-main',
    principalId: 'owner',
    sessionId: 's-main',
    limit: 10,
    semantic: true,
    ...overrides,
  }
}

function sourceContext(search: EngineClient['search']): SourceContext {
  const engine = { search } as unknown as EngineClient
  return {
    store,
    engine: () => engine,
    workspaceOf: value => ({ projectId: value.projectId, ...(value.workspaceId ? { workspaceId: value.workspaceId } : {}) }),
    timeoutMs: 100,
  }
}

function hit(engineMemoryId: string, extra: Partial<EngineSearchHit> = {}): EngineSearchHit {
  return {
    engineMemoryId,
    governanceId: null,
    text: 'queue migration semantic hit',
    score: 0.9,
    scene: 'coding',
    kind: 'fact',
    ...extra,
  }
}

describe('host semantic candidate source', () => {
  it('maps a worker hit without governance metadata through the authorized engine id', async () => {
    const memory = createMemory({ title: 'queue migration', content: 'Queue migration uses fenced leases.', engineId: 'engine-memory-1' })
    const search = vi.fn(async (_input: Parameters<EngineClient['search']>[0]) => ({ results: [hit('engine-memory-1')], elapsedMs: 1 }))

    const candidates = await semanticCandidates(sourceContext(search))(query())

    expect(search).toHaveBeenCalledOnce()
    expect(search.mock.calls[0]?.[0].allowIds).toEqual(['engine-memory-1'])
    expect(candidates.map(candidate => candidate.memoryId)).toEqual([memory.id])
  })

  it('sends only engine ids for rows the query principal is authorized to read', async () => {
    const granted = createMemory({ title: 'granted', content: 'granted semantic memory', engineId: 'engine-granted', scope: 'private' })
    createMemory({ title: 'private', content: 'ungranted private memory', engineId: 'engine-private', scope: 'private' })
    const deleted = createMemory({ title: 'deleted', content: 'deleted semantic memory', engineId: 'engine-deleted' })
    store.transition(deleted.id, 'deleted', 'agent-main', 'semantic source fixture', deleted.revision)
    store.addGrant({
      subjectId: 'agent-sub',
      objectScope: `memory:${granted.id}`,
      action: 'read',
      projectId: 'proj-a',
      issuer: 'owner',
    })
    const search = vi.fn(async (input: Parameters<EngineClient['search']>[0]) => ({
      results: input.allowIds.map(engineId => hit(engineId)),
      elapsedMs: 1,
    }))

    const candidates = await semanticCandidates(sourceContext(search))(
      query({ principalId: 'agent-sub', agentId: 'session-sub', sessionId: 's-sub' }),
    )

    expect(search.mock.calls[0]?.[0].allowIds).toEqual(['engine-granted'])
    expect(candidates.map(candidate => candidate.memoryId)).toEqual([granted.id])
  })

  it('ignores a worker-supplied governance id that is not backed by the hit engine id', async () => {
    const memory = createMemory({ title: 'allowed', content: 'allowed row', engineId: 'engine-authorized' })
    const search = vi.fn(async () => ({
      results: [hit('engine-not-mapped', { governanceId: memory.id })],
      elapsedMs: 1,
    }))

    const candidates = await semanticCandidates(sourceContext(search))(query())

    expect(candidates).toEqual([])
  })

  it('does not ask the worker when visible candidates have no engine ids', async () => {
    createMemory({ title: 'governance only', content: 'not indexed in the semantic engine' })
    const search = vi.fn(async () => ({ results: [], elapsedMs: 1 }))

    const candidates = await semanticCandidates(sourceContext(search))(query())

    expect(search).not.toHaveBeenCalled()
    expect(candidates).toEqual([])
  })

  it('keeps keyword hits and marks the recall degraded when semantic search fails', async () => {
    const memory = createMemory({
      title: 'queue migration path',
      content: 'Queue migration uses atomic lease renewal.',
      engineId: 'engine-queue-migration',
    })
    const search = vi.fn(async () => {
      throw new Error('offline semantic backend')
    })
    const source = buildCandidateSource(sourceContext(search))
    const controller = new RetrievalController({ store, source, settings: DEFAULT_SETTINGS.recall })

    const outcome = await controller.search(query({ mode: 'hybrid' }))

    expect(outcome.clues.map(clue => clue.memoryId)).toContain(memory.id)
    expect(outcome.degraded).toBe('source-error')
  })
})
