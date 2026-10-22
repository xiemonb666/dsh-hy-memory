/**
 * Recall controller wiring: settings from the governance store, candidate
 * sources, branch applicability from code bindings, and the hard-budget clue
 * renderer from the retrieval package.
 */
import { RetrievalController, type RecallOutcome } from '@dsh-hy-memory/retrieval'
import type { GovernanceStore } from '@dsh-hy-memory/governance'
import type { MemoryRecord, SearchQuery } from '@dsh-hy-memory/contracts'
import type { EngineClient } from './engine.js'
import { buildCandidateSource } from './sources.js'
import type { HostConfig } from './config.js'
import type { WorkspaceIdentity } from './identity.js'

export interface RecallControllerOptions {
  store: GovernanceStore
  engine: EngineClient | (() => EngineClient)
  config: HostConfig
  workspace: () => WorkspaceIdentity
}

export class RecallController {
  private readonly store: GovernanceStore
  private readonly engineRef: () => EngineClient
  private readonly config: HostConfig
  private readonly workspace: () => WorkspaceIdentity
  private controller: RetrievalController | null = null
  private settingsRevision = -1
  private readonly disposeController = new AbortController()
  private disposed = false

  constructor(options: RecallControllerOptions) {
    this.store = options.store
    this.engineRef = typeof options.engine === 'function' ? (options.engine as () => EngineClient) : () => options.engine as EngineClient
    this.config = options.config
    this.workspace = options.workspace
  }

  /** Rebuild the controller when persisted settings change. */
  private current(): RetrievalController {
    const { settings, revision } = this.store.getSettings()
    if (!this.controller || revision !== this.settingsRevision) {
      this.settingsRevision = revision
      this.controller = new RetrievalController({
        store: this.store,
        source: buildCandidateSource({
          store: this.store,
          engine: this.engineRef,
          workspaceOf: query => ({ projectId: query.projectId, ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}) }),
          timeoutMs: settings.recall.searchTimeoutMs,
        }),
        settings: settings.recall,
        settingsRevision: revision,
        branchOf: memory => {
          const bindings = this.store.listCodeBindings(memory.id)
          const branch = bindings[0]?.branch
          return typeof branch === 'string' ? branch : undefined
        },
      })
    }
    return this.controller
  }

  /** Drop cached recall results (ACL or settings change). */
  invalidate(): void {
    this.controller?.clearCache()
  }

  /** Cancel pending retrieval and prevent late operations from recording usage after shutdown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeController.abort()
    this.controller?.clearCache()
  }

  /** Current effective recall settings. */
  settings(): ReturnType<GovernanceStore['getSettings']>['settings']['recall'] {
    return this.store.getSettings().settings.recall
  }

  /**
   * Run a recall pass for the current workspace.
   * @param input - query text, principal, session and scene.
   * @returns clues and the rendered container, or a degraded outcome.
   */
  async search(input: {
    principalId: string
    agentId: string
    sessionId: string
    query: string
    turn?: string
    scene?: 'chat' | 'working' | 'coding'
    limit?: number
    signal?: AbortSignal
  }): Promise<RecallOutcome> {
    if (this.disposed || input.signal?.aborted) return abortedOutcome()
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.disposeController.signal])
      : this.disposeController.signal
    const workspace = this.workspace()
    const query: SearchQuery = {
      query: input.query.slice(0, 4000),
      mode: 'hybrid',
      ...(input.scene ? { scene: input.scene } : {}),
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      agentId: input.agentId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      limit: Math.min(input.limit ?? this.settings().candidateLimit, 100),
      semantic: true,
    }
    const controller = this.current()
    const timeoutMs = this.settings().searchTimeoutMs
    const outcome = await controller.searchWithTimeout(query, timeoutMs, {
      ...(input.turn ? { turn: input.turn } : {}),
      signal,
    })
    if (this.disposed || signal.aborted) return abortedOutcome(outcome.elapsedMs)
    if (outcome.clues.length > 0) {
      this.store.recordUsage({
        projectId: workspace.projectId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        operation: 'recall',
        tokenEst: outcome.tokenCount,
        recallMs: outcome.elapsedMs,
        hitIds: outcome.clues.map(clue => clue.memoryId),
      })
    }
    return outcome
  }

  /** Token cost preview for the Studio detail drawer. */
  preview(memory: MemoryRecord, budget?: number): ReturnType<RetrievalController['clueForCurrentTask']> {
    return this.current().clueForCurrentTask(memory, budget)
  }

  /** Expose the configured limits to the tools and UI. */
  limits(): { clueLimit: number; maxInjectionTokens: number; maxSingleClueTokens: number } {
    const settings = this.settings()
    return {
      clueLimit: settings.clueLimit,
      maxInjectionTokens: settings.maxInjectionTokens,
      maxSingleClueTokens: settings.maxSingleClueTokens,
    }
  }
}

function abortedOutcome(elapsedMs = 0): RecallOutcome {
  return { clues: [], rendered: '', tokenCount: 0, degraded: 'aborted', elapsedMs, cacheHit: false }
}

