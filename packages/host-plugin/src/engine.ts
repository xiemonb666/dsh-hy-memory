/**
 * Typed HTTP client for the local Python memory worker.
 *
 * The worker binds 127.0.0.1 only and requires a bearer token. Every call is
 * bounded by a timeout and never throws into the agent loop: callers receive a
 * degraded result and the session continues.
 */
import { randomToken } from '@dsh-hy-memory/contracts'
import type { ModelSettings } from '@dsh-hy-memory/contracts'
import { defaultModelPolicy, modelPolicyAllowsSdkEgress, modelPolicyFingerprint } from './egress.js'

export interface EngineHealth {
  ok: boolean
  engine: 'hy-memory' | 'mock'
  engineVersion: string
  degraded: boolean
  reason: string | null
  queueDepth?: number
  embeddingDims?: number
  mode?: string
  uptimeSeconds?: number
}

export interface EngineMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
}

export interface EngineIngestInput {
  jobId: string
  namespace: string
  workspaceId?: string | null
  branch?: string | null
  scene: 'chat' | 'working' | 'coding'
  messages: EngineMessage[]
  toolOutcomes: Array<{ callId: string; name: string; exitCode?: number; success?: boolean }>
  observedAt: string
}

export interface EngineCandidate {
  scene: 'chat' | 'working' | 'coding'
  kind: string
  title: string
  text: string
  claims: Array<{ subject: string; predicate: string; object: string }>
  confidence: number
  engineMemoryId: string
  source: string
}

export interface EngineSearchHit {
  engineMemoryId: string
  governanceId: string | null
  text: string
  score: number
  scene: 'chat' | 'working' | 'coding'
  kind: string
  chainBlock?: string | null
}

export interface EngineClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  /** Read the current persisted host policy before each SDK-backed operation. */
  modelPolicy?: () => ModelSettings
  /** Snapshot actually used to start a managed worker, for change detection. */
  startupModelPolicy?: ModelSettings
  /** True when this process was started with the same host policy snapshot. */
  managedWorker?: boolean
}

export class EngineUnavailableError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`memory engine unavailable: ${reason}`)
    this.name = 'EngineUnavailableError'
    this.reason = reason
  }
}

/**
 * Minimal JSON-over-HTTP engine client with a hard timeout and structured
 * failures. It is deliberately unaware of governance: ids returned here are
 * engine ids, never trust decisions.
 */
export class EngineClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly modelPolicy: () => ModelSettings
  private readonly startupPolicyFingerprint: string
  private readonly managedWorker: boolean

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.modelPolicy = options.modelPolicy ?? defaultModelPolicy
    this.startupPolicyFingerprint = modelPolicyFingerprint(options.startupModelPolicy ?? this.modelPolicy())
    this.managedWorker = options.managedWorker ?? true
  }

  private assertRequestLive(deadline: number, signal: AbortSignal): void {
    if (signal.aborted || Date.now() >= deadline) throw new EngineUnavailableError('timeout')
  }

  private async fetchJson<T>(path: string, body: unknown, deadline: number, signal: AbortSignal): Promise<T> {
    this.assertRequestLive(deadline, signal)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal,
      })
      // Some fetch implementations or test doubles may not honor AbortSignal.
      // Recheck before reading a response or allowing a guarded data request.
      this.assertRequestLive(deadline, signal)
      const text = await response.text()
      this.assertRequestLive(deadline, signal)
      if (!response.ok) {
        throw new EngineUnavailableError(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      }
      return JSON.parse(text) as T
    } catch (error) {
      if (error instanceof EngineUnavailableError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new EngineUnavailableError('timeout')
      throw new EngineUnavailableError(error instanceof Error ? error.message : String(error))
    }
  }

  private async request<T>(path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const deadline = Date.now() + timeoutMs
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const operation = async (): Promise<T> => {
        if (path !== '/v1/health') await this.assertDataRequestAllowed(deadline, controller)
        this.assertRequestLive(deadline, controller.signal)
        return this.fetchJson<T>(path, body, deadline, controller.signal)
      }
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new EngineUnavailableError('timeout'))
        }, timeoutMs)
      })
      return await Promise.race([operation(), timeout])
    } catch (error) {
      if (error instanceof EngineUnavailableError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new EngineUnavailableError('timeout')
      throw new EngineUnavailableError(error instanceof Error ? error.message : String(error))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async assertDataRequestAllowed(deadline: number, controller: AbortController): Promise<void> {
    // The worker's health route is local and does not call a model. It tells us
    // whether data requests would use the deterministic mock or the SDK.
    this.assertRequestLive(deadline, controller.signal)
    let healthTimer: ReturnType<typeof setTimeout> | undefined
    const remaining = Math.max(0, deadline - Date.now())
    const healthTimeout = new Promise<never>((_resolve, reject) => {
      healthTimer = setTimeout(() => {
        controller.abort()
        reject(new EngineUnavailableError('timeout'))
      }, Math.min(3000, remaining))
    })
    let health: EngineHealth
    try {
      health = await Promise.race([
        this.fetchJson<EngineHealth>('/v1/health', undefined, deadline, controller.signal),
        healthTimeout,
      ])
    } finally {
      if (healthTimer !== undefined) clearTimeout(healthTimer)
    }
    this.assertRequestLive(deadline, controller.signal)
    if (health.engine === 'mock') return
    if (health.engine !== 'hy-memory') {
      throw new EngineUnavailableError('worker reported an unknown engine; refusing data request')
    }
    const currentPolicy = this.modelPolicy()
    if (modelPolicyFingerprint(currentPolicy) !== this.startupPolicyFingerprint) {
      throw new EngineUnavailableError('model policy changed since worker startup; restart the worker to apply the new policy')
    }
    if (!modelPolicyAllowsSdkEgress(currentPolicy)) {
      throw new EngineUnavailableError('external model egress is not allowed by current settings')
    }
    if (!this.managedWorker && currentPolicy.localOnly) {
      throw new EngineUnavailableError('attached worker endpoints cannot be verified as loopback; use a managed worker or set localOnly=false explicitly')
    }
  }

  async health(): Promise<EngineHealth> {
    return this.request<EngineHealth>('/v1/health', undefined, Math.min(this.timeoutMs, 3000))
  }

  async ingest(input: EngineIngestInput): Promise<{ engineMemoryIds: string[]; candidates: EngineCandidate[]; elapsedMs: number }> {
    return this.request('/v1/ingest', input)
  }

  async search(input: {
    namespace: string
    workspaceId?: string | null
    branch?: string | null
    query: string
    scene?: 'chat' | 'working' | 'coding' | null
    limit: number
    allowIds: string[]
  }, timeoutMs?: number): Promise<{ results: EngineSearchHit[]; elapsedMs: number }> {
    return this.request('/v1/search', input, timeoutMs ?? this.timeoutMs)
  }

  async get(engineMemoryId: string): Promise<{ text: string; metadata: Record<string, unknown> } | null> {
    try {
      return await this.request('/v1/get', { engineMemoryId })
    } catch (error) {
      // A missing engine id is a normal outcome: governance keeps the canonical
      // text, and hy-memory hides L1_RAW ids from get() by design.
      if (error instanceof EngineUnavailableError && error.reason.startsWith('HTTP 404')) return null
      throw error
    }
  }

  async delete(engineMemoryId: string): Promise<void> {
    await this.request('/v1/delete', { engineMemoryId })
  }

  async feedback(engineMemoryId: string, kind: 'useful' | 'incorrect' | 'stale'): Promise<void> {
    await this.request('/v1/feedback', { engineMemoryId, kind })
  }
}

/** Generate a worker token suitable for the loopback bearer check. */
export function newWorkerToken(): string {
  return randomToken(32)
}
