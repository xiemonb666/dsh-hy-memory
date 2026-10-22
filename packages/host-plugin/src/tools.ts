/**
 * Model-facing memory tools. Every tool authorizes through the governance
 * store; none can promote a claim to `verified`, and none can read outside the
 * caller's project/workspace/grant scope.
 */
import {
  ErrorCode,
  HyMemoryError,
  looksLikeEcho,
  sha256,
  type MemoryKind,
  type MemoryScope,
  type Scene,
} from '@dsh-hy-memory/contracts'
import { anchorClaim, redact } from '@dsh-hy-memory/governance'
import type { ToolDefinitionLike, ToolExecutionLike } from './dsh-types.js'
import type { HostRuntime } from './runtime.js'

function requireAgent(exec: ToolExecutionLike): { principalId: string; agentId: string; sessionId: string } {
  if (!exec.agent) throw new HyMemoryError(ErrorCode.UNAUTHORIZED, 'memory tools require an owning agent session', 401)
  return { principalId: `agent:${exec.agent.session.id}`, agentId: exec.agent.session.id, sessionId: exec.agent.session.id }
}

function textResult(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

const SCENE_VALUES = ['chat', 'working', 'coding'] as const
const KIND_VALUES = ['fact', 'preference', 'decision', 'experience', 'failure', 'todo', 'hypothesis'] as const
const SCOPE_VALUES = ['private', 'agent', 'workspace', 'project', 'shared'] as const

/**
 * Build the six tool definitions bound to one runtime.
 * @param runtime - plugin runtime.
 * @returns registry-ready definitions.
 */
export function buildTools(getRuntime: () => HostRuntime): ToolDefinitionLike[] {
  /** Resolve the runtime per call: tools are registered before the worker starts. */
  const runtime = (): HostRuntime => getRuntime()
  /** The governance store is resolved per call for the same reason as the runtime. */
  const store = (): HostRuntime['store'] => getRuntime().store
  const search: ToolDefinitionLike = {
    name: 'memory_search',
    description:
      'Search long-term project memory (semantic + keyword) for prior decisions, verified facts and failure lessons. '
      + 'Results are clues with citations; call memory_get for the full record. Never treat memory as current source code.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look for: task, symbol, file path or error text.' },
      scene: { type: 'string', enum: [...SCENE_VALUES], description: 'Restrict to one memory scene.' },
      limit: { type: 'integer', description: 'Maximum clues (default 6).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rendered: { type: 'string' },
          count: { type: 'integer' },
          ids: { type: 'array', items: { type: 'string' } },
          degraded: { type: 'string' },
        },
        required: ['rendered', 'count', 'ids'],
      },
      render: (_args, value) => {
        const result = value as { rendered: string; count: number }
        return textResult(result.count === 0 ? 'No matching memory in this scope.' : result.rendered)
      },
    },
    async execute(args, exec) {
      const identity = requireAgent(exec)
      const query = String(args.query ?? '').trim()
      if (query.length < 2) throw new HyMemoryError(ErrorCode.VALIDATION, 'query is too short', 400)
      const outcome = await runtime().recall.search({
        principalId: identity.principalId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        query,
        limit: typeof args.limit === 'number' ? args.limit : 6,
        ...(typeof args.scene === 'string' && (SCENE_VALUES as readonly string[]).includes(args.scene)
          ? { scene: args.scene as Scene }
          : {}),
      })
      return {
        rendered: outcome.rendered,
        count: outcome.clues.length,
        ids: outcome.clues.map(clue => clue.memoryId),
        ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Search memory', kind: 'read', rawInput: args }),
  }

  const get: ToolDefinitionLike = {
    name: 'memory_get',
    description:
      'Read one memory record by id, including status, scope, claims and evidence references. '
      + 'Unauthorized or deleted ids return the same not-found error, without revealing whether they exist.',
    parameters: { id: { type: 'string', required: true, description: 'Memory id from memory_search.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          scope: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          injectableTokens: { type: 'integer' },
        },
        required: ['id', 'status', 'title', 'content', 'scope', 'evidence', 'injectableTokens'],
      },
      render: (_args, value) => {
        const record = value as { title: string; status: string; content: string; evidence: string[] }
        return textResult(`[${record.status}] ${record.title}\n${record.content}\nEvidence: ${record.evidence.join(', ') || 'none'}`)
      },
    },
    async execute(args, exec) {
      const identity = requireAgent(exec)
      const id = String(args.id ?? '')
      const record = store().getMemory(id, identity.principalId)
      if (!record) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
      const preview = runtime().recall.preview(record)
      return {
        id: record.id,
        status: record.status,
        title: record.title,
        content: record.content,
        scope: record.scope,
        evidence: record.evidenceIds,
        injectableTokens: preview.tokenCost,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read memory', kind: 'read', rawInput: args }),
  }

  const propose: ToolDefinitionLike = {
    name: 'memory_propose',
    description:
      'Propose a memory candidate (preference, decision, fact, experience, failure or hypothesis) for this project. '
      + 'Candidates are stored as proposed/needs_review; only real evidence and a passing validation can make one verified. '
      + 'Do not propose recalled text as a new fact.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title (<=120 chars).' },
      content: { type: 'string', required: true, description: 'The claim, with preconditions and uncertainty stated.' },
      scene: { type: 'string', enum: [...SCENE_VALUES], description: 'chat|working|coding.' },
      kind: { type: 'string', enum: [...KIND_VALUES], description: 'Memory kind.' },
      scope: { type: 'string', enum: [...SCOPE_VALUES], description: 'Visibility scope (default workspace).' },
      subject: { type: 'string', description: 'Optional claim subject (file, symbol, topic).' },
      predicate: { type: 'string', description: 'Optional claim predicate.' },
      object: { type: 'string', description: 'Optional claim object.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'status', 'reason'],
      },
      render: (_args, value) => {
        const result = value as { id: string; status: string; reason: string }
        return textResult(`Stored as ${result.status} (${result.id}). ${result.reason}`)
      },
    },
    async execute(args, exec) {
      const identity = requireAgent(exec)
      const title = String(args.title ?? '').trim()
      const content = String(args.content ?? '').trim()
      if (title.length === 0 || content.length < 8) throw new HyMemoryError(ErrorCode.VALIDATION, 'title and content are required', 400)
      if (looksLikeEcho(content)) throw new HyMemoryError(ErrorCode.ECHO_REJECTED, 'recalled memory cannot be proposed as new evidence', 409)
      const workspace = runtime().workspace()
      const event = store().appendSourceEvent({
        sourceKey: `tool:memory_propose:${identity.sessionId}:${sha256(`${title}\u0000${content}`)}`,
        checksum: sha256(content),
        eventType: 'tool/memory_propose',
        payload: { title, content, scene: args.scene, kind: args.kind },
        sessionId: identity.sessionId,
        workspaceId: workspace.workspaceId,
      })
      const evidence = store().addEvidence({
        sourceEventId: event.id,
        type: 'model_claim',
        payload: content,
        trustLevel: 'model_generated',
        retentionDays: runtime().config.capture.evidenceRetentionDays,
        excerpt: redact(content).text.slice(0, 512),
      })
      const anchor = anchorClaim({
        candidate: content,
        evidenceTexts: [content],
        toolOutcomes: [],
        trustLevels: ['model_generated'],
        userExplicit: false,
      })
      const scene = typeof args.scene === 'string' && (SCENE_VALUES as readonly string[]).includes(args.scene) ? (args.scene as Scene) : 'chat'
      const kind = typeof args.kind === 'string' && (KIND_VALUES as readonly string[]).includes(args.kind) ? (args.kind as MemoryKind) : 'fact'
      const scope = typeof args.scope === 'string' && (SCOPE_VALUES as readonly string[]).includes(args.scope) ? (args.scope as MemoryScope) : 'workspace'
      const record = store().createMemory(
        {
          scene,
          kind,
          title,
          content,
          status: anchor.decision === 'rejected' ? 'rejected' : 'proposed',
          scope,
          projectId: workspace.projectId,
          workspaceId: workspace.workspaceId,
          agentId: identity.agentId,
          authorPrincipalId: identity.principalId,
          evidenceIds: [evidence.id],
          ...(typeof args.subject === 'string' && typeof args.predicate === 'string' && typeof args.object === 'string'
            ? { claims: [{ subject: args.subject, predicate: args.predicate, object: args.object }] }
            : {}),
        },
        identity.principalId,
      )
      store().detectConflicts(record.id, identity.principalId)
      return {
        id: record.id,
        status: record.status,
        reason: anchor.reasons.join(', ') || 'awaiting evidence',
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Propose memory', kind: 'write', rawInput: args }),
  }

  const feedback: ToolDefinitionLike = {
    name: 'memory_feedback',
    description:
      'Report that a memory was useful, incorrect or stale. Feedback never deletes or confirms a memory; '
      + 'incorrect/stale marks it for review with the current revision preserved.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id.' },
      kind: { type: 'string', required: true, enum: ['useful', 'incorrect', 'stale'], description: 'Feedback kind.' },
      note: { type: 'string', description: 'Short justification.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
        },
        required: ['ok', 'status'],
      },
      render: (_args, value) => {
        const result = value as { ok: boolean; status: string }
        return textResult(result.ok ? `Feedback recorded; memory is ${result.status}.` : 'Feedback rejected.')
      },
    },
    async execute(args, exec) {
      const identity = requireAgent(exec)
      const record = store().getMemory(String(args.id ?? ''), identity.principalId)
      if (!record) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
      const kind = String(args.kind ?? '')
      store().recordUsage({
        projectId: record.projectId,
        sessionId: identity.sessionId,
        agentId: identity.agentId,
        operation: `feedback:${kind}`,
        hitIds: [record.id],
      })
      let status = record.status
      if ((kind === 'incorrect' || kind === 'stale') && (record.status === 'supported' || record.status === 'verified')) {
        const updated = store().transition(record.id, 'stale', identity.principalId, `feedback:${kind}`, record.revision)
        status = updated.status
      }
      return { ok: true, status }
    },
    presentCall: args => ({ card: 'generic', title: 'Memory feedback', kind: 'write', rawInput: args }),
  }

  const linkCode: ToolDefinitionLike = {
    name: 'memory_link_code',
    description:
      'Bind a memory to the current repository state (branch, commit, file, optional symbol) so version validity can be '
      + 're-evaluated later. The host reads git itself; model-supplied commits are ignored.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id.' },
      file: { type: 'string', required: true, description: 'Repository-relative file path.' },
      symbol: { type: 'string', description: 'Optional function/class symbol.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bindingId: { type: 'string' },
          commit: { type: 'string' },
          branch: { type: 'string' },
        },
        required: ['bindingId', 'commit', 'branch'],
      },
      render: (_args, value) => {
        const result = value as { commit: string; branch: string }
        return textResult(`Bound to ${result.branch}@${result.commit.slice(0, 12)}.`)
      },
    },
    async execute(args, exec) {
      const identity = requireAgent(exec)
      const record = store().getMemory(String(args.id ?? ''), identity.principalId)
      if (!record) throw new HyMemoryError(ErrorCode.NOT_FOUND, 'memory not found', 404)
      const workspace = runtime().workspace()
      if (!workspace.headCommit) throw new HyMemoryError(ErrorCode.VALIDATION, 'workspace has no git HEAD to bind', 409)
      const file = String(args.file ?? '').replaceAll('\\', '/')
      if (file.includes('..')) throw new HyMemoryError(ErrorCode.VALIDATION, 'file must be repository-relative', 400)
      const bindingId = store().addCodeBinding({
        memoryId: record.id,
        workspaceId: workspace.workspaceId,
        ...(workspace.branch ? { branch: workspace.branch } : {}),
        ...(workspace.headCommit ? { headCommit: workspace.headCommit } : {}),
        filePath: file,
        ...(typeof args.symbol === 'string' ? { symbol: args.symbol } : {}),
      })
      return { bindingId, commit: workspace.headCommit, branch: workspace.branch ?? 'HEAD' }
    },
    presentCall: args => ({ card: 'generic', title: 'Link memory to code', kind: 'write', rawInput: args }),
  }

  const status: ToolDefinitionLike = {
    name: 'memory_status',
    description:
      'Report whether long-term memory is available for this scope: engine health, capture/recall state, and counts for '
      + 'the current project only. It never reveals other projects.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean' },
          degraded: { type: 'boolean' },
          engine: { type: 'string' },
          project: { type: 'string' },
          counts: { type: 'object' },
        },
        required: ['available', 'degraded', 'engine', 'project', 'counts'],
      },
      render: (_args, value) => {
        const result = value as { available: boolean; degraded: boolean; engine: string; counts: Record<string, number> }
        return textResult(
          `memory ${result.available ? 'available' : 'unavailable'} (${result.engine}${result.degraded ? ', degraded' : ''}); `
          + `verified=${result.counts.verified ?? 0} supported=${result.counts.supported ?? 0} review=${result.counts.needs_review ?? 0}`,
        )
      },
    },
    async execute(_args, exec) {
      requireAgent(exec)
      const workspace = runtime().workspace()
      const health = await runtime().engineHealth()
      const overview = store().overview(workspace.projectId, workspace.workspaceId)
      const counts = {
        verified: Number(overview.verified ?? 0),
        supported: Number(overview.supported ?? 0),
        needs_review: Number(overview.needsReview ?? 0),
        total: Number(overview.total ?? 0),
      }
      return {
        available: health.ok,
        degraded: health.degraded,
        engine: health.engine,
        project: workspace.projectId,
        counts,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Memory status', kind: 'read', rawInput: {} }),
  }

  return [search, get, propose, feedback, linkCode, status]
}




