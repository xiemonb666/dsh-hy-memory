/**
 * Candidate sources for the ACL-first retrieval controller.
 *
 * Keyword channel: SQLite FTS5 over governance text, already scoped to the
 * project/workspace. Semantic channel: the Python worker, but only after the
 * host has computed the authorized id set, so the engine cannot return a row
 * the caller may not read (defense in depth).
 */
import type { Candidate, CandidateSource } from '@dsh-hy-memory/retrieval'
import type { GovernanceStore } from '@dsh-hy-memory/governance'
import type { SearchQuery } from '@dsh-hy-memory/contracts'
import type { EngineClient } from './engine.js'

export interface SourceContext {
  store: GovernanceStore
  engine: () => EngineClient
  workspaceOf: (query: SearchQuery) => { projectId: string; workspaceId?: string; branch?: string }
  timeoutMs: number
}

/** FTS5 keyword channel with position-based normalization. */
export function keywordCandidates(context: SourceContext): CandidateSource['keyword'] {
  return async (query: SearchQuery): Promise<Candidate[]> => {
    const page = context.store.listMemories({
      projectId: query.projectId,
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
      query: query.query,
      limit: query.limit,
      includeDeleted: false,
    })
    return page.items.map((memory, index) => ({
      memoryId: memory.id,
      score: 1 - index / Math.max(page.items.length, 1),
      via: 'keyword' as const,
      text: memory.content,
    }))
  }
}

/**
 * Semantic channel restricted to ids the host already authorized. A row the
 * engine invents or returns outside the allow set is dropped here, before the
 * controller sees it.
 */
export function semanticCandidates(context: SourceContext): CandidateSource['semantic'] {
  return async (query: SearchQuery): Promise<Candidate[]> => {
    const candidates = context.store.listMemories({
      projectId: query.projectId,
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
      limit: 500,
      includeDeleted: false,
    })
    const authorized = candidates.items.flatMap(memory => {
      const row = context.store.getRawMemory(memory.id)
      if (!row || row.tombstone === 1 || row.status === 'deleted') return []
      if (row.project_id !== query.projectId || (query.workspaceId && row.workspace_id !== query.workspaceId)) return []
      if (!context.store.authorize(query.principalId, 'read', row)) return []
      return [{ memoryId: row.id, engineId: row.engine_id }]
    })
    const byEngineId = new Map<string, string>()
    for (const memory of authorized) {
      if (memory.engineId) byEngineId.set(memory.engineId, memory.memoryId)
    }
    const engineIds = [...byEngineId.keys()]
    if (engineIds.length === 0) return []

    // Engine allow-lists use engine ids, never host governance ids. Any hit
    // must map back through this host-built table; worker-supplied governance
    // metadata is untrusted and cannot establish that association.
    const result = await context.engine().search(
      {
        namespace: `project:${query.projectId}`,
        workspaceId: query.workspaceId ?? null,
        branch: query.branch ?? null,
        query: query.query,
        scene: query.scene ?? null,
        limit: query.limit,
        allowIds: engineIds,
      },
      context.timeoutMs,
    )
    const allowedMemoryIds = new Set(authorized.map(memory => memory.memoryId))
    const semantic: Candidate[] = []
    for (const hit of result.results) {
      const governanceId = byEngineId.get(hit.engineMemoryId)
      if (!governanceId || !allowedMemoryIds.has(governanceId)) continue
      semantic.push({ memoryId: governanceId, score: hit.score, via: 'semantic', text: hit.text })
    }
    return semantic
  }
}

/** Build both channels for one controller. */
export function buildCandidateSource(context: SourceContext): CandidateSource {
  return {
    keyword: keywordCandidates(context),
    semantic: semanticCandidates(context),
  }
}
