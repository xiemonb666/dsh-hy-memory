/**
 * Capture pipeline: durable session events → redacted evidence → engine
 * candidates → anchored governance records.
 *
 * Invariants:
 * - the queue is at-least-once and idempotent (`sourceKey` + checksum);
 * - secrets are redacted before a payload leaves the host process;
 * - a candidate is stored with the status the evidence gate returns, never the
 *   status the model asked for;
 * - recalled material never becomes new evidence (echo rejection).
 */
import {
  ErrorCode,
  HyMemoryError,
  canonicalJson,
  estimateTokens,
  sha256,
  sourceKey,
  uuidv7,
  type CaptureEnvelope,
  type CaptureMessage,
  type EvidenceTrust,
  type MemoryKind,
  type Scene,
  type ToolOutcome,
} from '@dsh-hy-memory/contracts'
import { anchorClaim, redact, type GovernanceStore } from '@dsh-hy-memory/governance'
import { exitCodeOf, textOf, type AgentLike, type HostContextLike, type MessageLike, type SessionEventLike } from './dsh-types.js'
import type { EngineCandidate, EngineClient, EngineIngestInput } from './engine.js'
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from './identity.js'
import type { HostConfig } from './config.js'

interface BufferedMessage extends CaptureMessage {
  evidenceId?: string
}

interface SessionBuffer {
  messages: BufferedMessage[]
  toolOutcomes: ToolOutcome[]
  sourceEventIds: string[]
  evidenceIds: string[]
  turnId?: string
  sawTool: boolean
  lastFlush: number
}

const MAX_MESSAGE_CHARS = 8000

/**
 * Derive a compact display title. The engine often returns the whole statement
 * as the title, which then repeats verbatim inside the clue line; take the first
 * sentence and cap it so the clue stays scannable.
 * @param title - engine-supplied title.
 * @param text - candidate statement, used when the title is empty.
 * @returns a short single-line title.
 */
function compactTitle(title: string, text: string): string {
  const source = (title.trim() || text.trim()).replace(/\s+/g, ' ')
  const firstSentence = source.split(/(?<=[.!?。！？;；])\s+|\n/)[0] ?? source
  const candidate = firstSentence.trim().length >= 8 ? firstSentence.trim() : source
  return candidate.length <= 80 ? candidate : `${candidate.slice(0, 77)}…`
}

function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max} chars)`
}

/**
 * Classify a scene from observed activity. A tool trace is the only signal that
 * promotes a segment to coding; a bare conversation stays chat.
 */
function sceneOf(buffer: SessionBuffer): Scene {
  if (!buffer.sawTool) return 'chat'
  return 'coding'
}

function kindOf(candidate: EngineCandidate): MemoryKind {
  const value = candidate.kind
  if (
    value === 'fact' ||
    value === 'preference' ||
    value === 'decision' ||
    value === 'experience' ||
    value === 'failure' ||
    value === 'todo' ||
    value === 'hypothesis'
  ) {
    return value
  }
  return 'fact'
}

export interface CapturePipelineOptions {
  store: GovernanceStore
  engine: EngineClient | (() => EngineClient)
  config: HostConfig
  logger: HostContextLike['logger']
  cwd: () => string
  enqueue: (envelope: CaptureEnvelope) => void
}

export class CapturePipeline {
  private readonly store: GovernanceStore
  private readonly engineRef: () => EngineClient
  private readonly config: HostConfig
  private readonly logger: HostContextLike['logger']
  private readonly cwd: () => string
  private readonly enqueue: (envelope: CaptureEnvelope) => void
  private readonly buffers = new Map<string, SessionBuffer>()
  private readonly workspaces = new Map<string, { identity: WorkspaceIdentity; at: number }>()
  private paused = false
  private disposed = false
  private settingsRevision: number | undefined

  constructor(options: CapturePipelineOptions) {
    this.store = options.store
    this.engineRef = typeof options.engine === 'function' ? (options.engine as () => EngineClient) : () => options.engine as EngineClient
    this.config = options.config
    this.logger = options.logger
    this.cwd = options.cwd
    this.enqueue = options.enqueue
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  isPaused(): boolean {
    return this.paused
  }

  /** Resolve (and cache for 30s) the workspace identity of the host cwd. */
  workspace(): WorkspaceIdentity {
    const cwd = this.cwd()
    const cached = this.workspaces.get(cwd)
    if (cached && Date.now() - cached.at < 30_000) return cached.identity
    const identity = resolveWorkspaceIdentity(cwd)
    this.workspaces.set(cwd, { identity, at: Date.now() })
    this.store.ensureWorkspace({
      id: identity.workspaceId,
      projectId: identity.projectId,
      repoFingerprint: identity.repoFingerprint,
      rootAlias: identity.rootAlias,
      ...(identity.remote ? { remote: identity.remote } : {}),
    })
    return identity
  }

  /** Bind an agent (main or subagent) to a principal for ACL purposes. */
  registerAgent(agent: AgentLike): void {
    const workspace = this.workspace()
    const agentId = agent.session.id
    const parent = agent.parentAgent?.session.id
    this.store.bindAgentSession({
      agentId,
      principalId: `agent:${agentId}`,
      sessionId: agent.session.id,
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      ...(parent ? { parentAgentId: parent } : {}),
    })
  }

  private buffer(sessionId: string): SessionBuffer {
    let current = this.buffers.get(sessionId)
    if (!current) {
      current = { messages: [], toolOutcomes: [], sourceEventIds: [], evidenceIds: [], sawTool: false, lastFlush: Date.now() }
      this.buffers.set(sessionId, current)
    }
    return current
  }

  private captureEnabled(): boolean {
    if (this.disposed) return false
    const persisted = this.store.getSettings()
    // A disable/re-enable can happen between events. Conservatively discard
    // unfinished segments on any settings revision, even if enabled is true now.
    if (this.settingsRevision !== undefined && persisted.revision !== this.settingsRevision) this.clearBuffers()
    this.settingsRevision = persisted.revision
    return this.config.capture.enabled && persisted.settings.enabled && persisted.settings.capture.enabled
  }

  private clearBuffers(): void {
    this.buffers.clear()
  }

  /** Stop accepting work and discard unfinished segments before the store closes. */
  dispose(): void {
    this.disposed = true
    this.clearBuffers()
    this.workspaces.clear()
  }

  private recordEvent(sessionId: string, eventType: string, payload: unknown, event: SessionEventLike): string | null {
    if (!this.captureEnabled()) {
      this.clearBuffers()
      return null
    }
    const text = JSON.stringify(payload)
    const checksum = sha256(text)
    const key = sourceKey(sessionId, eventType, event.seq ?? 0, checksum)
    const workspace = this.workspace()
    const stored = this.store.appendSourceEvent({
      sourceKey: key,
      checksum,
      eventType,
      payload,
      sessionId,
      workspaceId: workspace.workspaceId,
      observedAt: event.time ? new Date(event.time).toISOString() : new Date().toISOString(),
    })
    return stored.id
  }

  /**
   * Feed one durable session event. Called from the `session/event` listener.
   * @param sessionId - owning session.
   * @param event - the durable event.
   */
  observe(sessionId: string, event: SessionEventLike): void {
    if (!this.captureEnabled()) {
      this.clearBuffers()
      return
    }
    if (!this.config.capture.autoCapture || this.paused) return
    const buffer = this.buffer(sessionId)
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      buffer.turnId = typeof data.turn === 'number' ? `turn-${data.turn}` : buffer.turnId
      return
    }
    if (event.type === 'user/message') {
      const message = data as MessageLike
      const text = textOf(message)
      if (!text || text.includes('<memory_clues')) return
      const eventId = this.recordEvent(sessionId, 'user/message', { text }, event)
      if (!eventId) return
      const evidence = this.store.addEvidence({
        sourceEventId: eventId,
        type: 'user_message',
        payload: text,
        trustLevel: 'user_explicit',
        retentionDays: this.config.capture.evidenceRetentionDays,
        excerpt: text.slice(0, 512),
      })
      buffer.messages.push({ role: 'user', content: truncate(redact(text).text), evidenceId: evidence.id })
      buffer.sourceEventIds.push(eventId)
      buffer.evidenceIds.push(evidence.id)
      return
    }
    if (event.type === 'assistant/message') {
      const message = (data.message ?? {}) as MessageLike
      const text = textOf(message)
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls : []
      if (!text && calls.length === 0) return
      const eventId = this.recordEvent(sessionId, 'assistant/message', { text, calls }, event)
      if (!eventId) return
      if (text) {
        const evidence = this.store.addEvidence({
          sourceEventId: eventId,
          type: 'model_claim',
          payload: text,
          trustLevel: 'model_generated',
          retentionDays: this.config.capture.evidenceRetentionDays,
          excerpt: text.slice(0, 512),
        })
        buffer.evidenceIds.push(evidence.id)
      }
      buffer.messages.push({
        role: 'assistant',
        content: truncate(redact(text).text),
        ...(calls.length > 0
          ? { toolCalls: calls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments ?? '{}' })) }
          : {}),
      })
      buffer.sourceEventIds.push(eventId)
      if (calls.length > 0) buffer.sawTool = true
      return
    }
    if (event.type === 'tool/call') {
      buffer.sawTool = true
      return
    }
    if (event.type === 'tool/result') {
      const message = (data.message ?? {}) as MessageLike
      const text = textOf(message)
      if (text.length > this.config.capture.excludeToolOutputOverKb * 1024) return
      const callId = message.toolCallId ?? (typeof data.callId === 'string' ? data.callId : uuidv7())
      const name = message.toolName ?? (typeof data.name === 'string' ? data.name : 'tool')
      const exitCode = exitCodeOf(message)
      const success = message.isError === true ? false : exitCode === undefined ? true : exitCode === 0
      const eventId = this.recordEvent(sessionId, 'tool/result', { callId, name, text: text.slice(0, 4096), exitCode }, event)
      if (!eventId) return
      const isTest = /pytest|unittest|npm test|pnpm test|vitest|ctest|go test|cargo test|jest/i.test(`${name} ${text.slice(0, 2000)}`)
      const trust: EvidenceTrust = isTest && exitCode === 0 ? 'test_verified' : 'tool_observed'
      const evidence = this.store.addEvidence({
        sourceEventId: eventId,
        type: isTest ? 'test_result' : 'tool_result',
        payload: text,
        trustLevel: trust,
        retentionDays: this.config.capture.evidenceRetentionDays,
        excerpt: text.slice(0, 512),
      })
      buffer.messages.push({
        role: 'tool',
        content: truncate(redact(text).text),
        toolCallId: callId,
        toolName: name,
      })
      buffer.toolOutcomes.push({ callId, name, ...(exitCode === undefined ? {} : { exitCode }), success })
      buffer.sourceEventIds.push(eventId)
      buffer.evidenceIds.push(evidence.id)
      return
    }
    if (event.type === 'turn/end') {
      void this.flush(sessionId)
    }
  }

  /**
   * Flush the buffered segment as one capture envelope and enqueue a job.
   * @param sessionId - session whose buffer is flushed.
   * @returns the enqueued job id, or null when nothing was captured.
   */
  async flush(sessionId: string): Promise<string | null> {
    if (!this.captureEnabled()) {
      this.clearBuffers()
      return null
    }
    const buffer = this.buffers.get(sessionId)
    if (!buffer || buffer.messages.length === 0) return null
    this.buffers.set(sessionId, { messages: [], toolOutcomes: [], sourceEventIds: [], evidenceIds: [], sawTool: false, lastFlush: Date.now() })
    const workspace = this.workspace()
    const scene = sceneOf(buffer)
    if (scene === 'coding' && !this.config.capture.enableCoding) return null
    if (scene === 'chat' && !this.config.capture.enableChat) return null
    const envelope: CaptureEnvelope = {
      schemaVersion: 1,
      sourceKey: sourceKey(sessionId, buffer.turnId ?? 'turn', canonicalJson(buffer.messages)),
      principalId: `agent:${sessionId}`,
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      agentId: sessionId,
      sessionId,
      ...(buffer.turnId ? { turnId: buffer.turnId } : {}),
      sceneCandidate: scene,
      messages: buffer.messages.map(({ evidenceId: _evidenceId, ...message }) => message),
      toolOutcomes: buffer.toolOutcomes,
      ...(workspace.headCommit
        ? {
            git: {
              root: workspace.rootAlias,
              ...(workspace.branch ? { branch: workspace.branch } : {}),
              ...(workspace.headCommit ? { baseCommit: workspace.headCommit, headCommit: workspace.headCommit } : {}),
              ...(workspace.dirty === undefined ? {} : { dirty: workspace.dirty }),
              ...(workspace.remote ? { remote: workspace.remote } : {}),
              ...(workspace.shallow === undefined ? {} : { shallow: workspace.shallow }),
            },
          }
        : {}),
      sourceEventIds: buffer.sourceEventIds,
      observedAt: new Date().toISOString(),
    }
    this.enqueue(envelope)
    this.logger.info(`hymem: captured ${buffer.messages.length} messages (${scene}) for ${envelope.projectId}`)
    return envelope.sourceKey
  }

  /**
   * Process one leased job: engine ingest → evidence anchoring → governance
   * record. Idempotent by engine id; retries never duplicate a memory.
   * @param envelope - capture envelope from the queue.
   * @param idempotencyKey - queue key, reused as the engine job id.
   */
  async process(envelope: CaptureEnvelope, idempotencyKey: string): Promise<{ created: string[]; needsReview: string[]; rejected: number }> {
    if (!this.captureEnabled()) {
      this.clearBuffers()
      return { created: [], needsReview: [], rejected: 0 }
    }
    const processSettingsRevision = this.settingsRevision
    const input: EngineIngestInput = {
      jobId: idempotencyKey,
      namespace: `project:${envelope.projectId}`,
      workspaceId: envelope.workspaceId,
      branch: envelope.git?.branch ?? null,
      scene: envelope.sceneCandidate,
      messages: envelope.messages,
      toolOutcomes: envelope.toolOutcomes.map(outcome => ({
        callId: outcome.callId,
        name: outcome.name,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        ...(outcome.success === undefined ? {} : { success: outcome.success }),
      })),
      observedAt: envelope.observedAt,
    }
    const result = await this.engineRef().ingest(input)
    if (this.disposed) return { created: [], needsReview: [], rejected: 0 }
    const stillEnabled = this.captureEnabled()
    if (!stillEnabled || this.settingsRevision !== processSettingsRevision) {
      this.clearBuffers()
      return { created: [], needsReview: [], rejected: 0 }
    }
    const evidence = this.store.evidenceForSourceEvents(envelope.sourceEventIds)
    const evidenceTexts = evidence.map(item => item.excerpt ?? '')
    const trustLevels = evidence.map(item => item.trust_level as EvidenceTrust)
    const userExplicit = envelope.messages.some(message => message.role === 'user')
    const created: string[] = []
    const needsReview: string[] = []
    let rejected = 0
    for (const candidate of result.candidates) {
      const existing = candidate.engineMemoryId ? this.store.findMemoryByEngineId(candidate.engineMemoryId) : undefined
      if (existing) {
        created.push(existing.id)
        continue
      }
      // Idempotency also has to survive an engine that mints a fresh id for the
      // same text (a re-run, or a model-backed extraction): identical content in
      // the same project is the same claim, so it is not stored twice.
      const sameContent = this.store.findMemoryByContent(envelope.projectId, candidate.title, redact(candidate.text).text)
      if (sameContent) {
        created.push(sameContent.id)
        continue
      }
      if (this.store.wasInjected(envelope.sessionId, candidate.text)) {
        rejected++
        continue
      }
      const anchor = anchorClaim({
        candidate: candidate.text,
        evidenceTexts,
        toolOutcomes: envelope.toolOutcomes.map(outcome => ({
          ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
          ...(outcome.success === undefined ? {} : { success: outcome.success }),
          name: outcome.name,
        })),
        trustLevels,
        userExplicit: userExplicit && candidate.kind === 'preference',
      })
      if (anchor.decision === 'rejected') {
        rejected++
        continue
      }
      const record = this.store.createMemory(
        {
          scene: candidate.scene,
          kind: kindOf(candidate),
          title: compactTitle(candidate.title, candidate.text),
          content: redact(candidate.text).text,
          status: anchor.decision === 'supported' ? 'supported' : 'needs_review',
          scope: this.config.agents.defaultScope,
          projectId: envelope.projectId,
          workspaceId: envelope.workspaceId,
          agentId: envelope.agentId,
          authorPrincipalId: envelope.principalId,
          evidenceIds: evidence.map(item => item.id),
          confidence: candidate.confidence,
          ...(candidate.engineMemoryId ? { engineId: candidate.engineMemoryId } : {}),
          ...(candidate.claims.length > 0
            ? { claims: candidate.claims.map(claim => ({ subject: claim.subject, predicate: claim.predicate, object: claim.object })) }
            : {}),
        },
        envelope.principalId,
      )
      if (envelope.git) {
        this.store.addCodeBinding({
          memoryId: record.id,
          workspaceId: envelope.workspaceId,
          ...(envelope.git.branch ? { branch: envelope.git.branch } : {}),
          ...(envelope.git.baseCommit ? { baseCommit: envelope.git.baseCommit } : {}),
          ...(envelope.git.headCommit ? { headCommit: envelope.git.headCommit } : {}),
          ...(envelope.git.files && envelope.git.files.length > 0 ? { filePath: envelope.git.files[0] } : {}),
        })
      }
      this.store.detectConflicts(record.id, envelope.principalId)
      if (anchor.decision === 'supported') created.push(record.id)
      else needsReview.push(record.id)
    }
    this.store.recordUsage({
      projectId: envelope.projectId,
      sessionId: envelope.sessionId,
      agentId: envelope.agentId,
      operation: 'capture',
      tokenEst: result.candidates.reduce((sum, candidate) => sum + estimateTokens(candidate.text), 0),
      hitIds: [...created, ...needsReview],
    })
    return { created, needsReview, rejected }
  }

  /** Throw a typed error when capture is disabled (used by tools). */
  assertEnabled(): void {
    if (!this.captureEnabled()) {
      this.clearBuffers()
      throw new HyMemoryError(ErrorCode.FORBIDDEN, 'capture is disabled by settings', 403)
    }
  }
}




