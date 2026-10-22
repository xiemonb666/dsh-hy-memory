/**
 * Multi-agent integration (E2E-02): the real capture and recall pipelines with
 * one main agent and two subagents sharing exactly one authorized fact.
 *
 * Unlike the store-level security suite, this drives `CapturePipeline` and
 * `RecallController` — the same objects the plugin registers on the host — with
 * a deterministic engine, so principal binding, grant checks, capture
 * de-duplication and cache invalidation are exercised together.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GovernanceStore } from '@dsh-hy-memory/governance'
import { CapturePipeline, RecallController, normalizeConfig } from '@dsh-hy-memory/host-plugin'
import type { CaptureEnvelope } from '@dsh-hy-memory/contracts'

let dir: string
let store: GovernanceStore
let capture: CapturePipeline
let recall: RecallController
let envelopes: CaptureEnvelope[]
let ingestCalls: number

const workspace = {
  projectId: 'project_multi',
  workspaceId: 'ws_multi',
  repoFingerprint: 'fp_multi',
  rootAlias: 'C:/multi',
  branch: 'main',
  headCommit: 'abc1234',
  dirty: false,
  shallow: false,
  detached: false,
}

/** Deterministic engine: one candidate per user message, id minted per call. */
function makeEngine() {
  return {
    async health() {
      return { ok: true, engine: 'mock' as const, engineVersion: '0.1.0', degraded: false, reason: null }
    },
    async ingest(input: { messages: Array<{ role: string; content: string }>; scene: string }) {
      ingestCalls++
      const userText = input.messages
        .filter(message => message.role === 'user')
        .map(message => message.content)
        .join(' ')
      if (!userText) return { engineMemoryIds: [], candidates: [], elapsedMs: 1 }
      return {
        engineMemoryIds: [`engine-${ingestCalls}`],
        candidates: [
          {
            scene: input.scene as 'chat' | 'working' | 'coding',
            kind: 'decision',
            title: 'shared deployment decision',
            text: userText,
            claims: [{ subject: 'deploy', predicate: 'uses', object: 'blue-green rollout' }],
            confidence: 0.8,
            engineMemoryId: `engine-${ingestCalls}`,
            source: 'mock',
          },
        ],
        elapsedMs: 1,
      }
    },
    async search() {
      return { results: [], elapsedMs: 1 }
    },
    async get() {
      return null
    },
    async delete() {},
    async feedback() {},
  }
}

const main = { session: { id: 'session-main' } }
const subA = { session: { id: 'session-sub-a' }, parentAgent: main }
const subB = { session: { id: 'session-sub-b' }, parentAgent: main }

function userEvent(text: string) {
  return { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hymem-multi-'))
  const dataDir = join(dir, 'data')
  store = new GovernanceStore(join(dataDir, 'governance.db'))
  const config = normalizeConfig({
    dataDir,
    worker: { engine: 'mock', autoSpawn: false },
    ui: { enabled: false },
    capture: { enabled: true, autoCapture: true },
  })
  store.ensureProject(workspace.projectId)
  store.ensureWorkspace({ id: workspace.workspaceId, projectId: workspace.projectId, repoFingerprint: 'fp_multi', rootAlias: 'C:/multi' })
  store.ensureOwner()
  envelopes = []
  ingestCalls = 0
  const engine = makeEngine()
  capture = new CapturePipeline({
    store,
    engine: engine as never,
    config,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    cwd: () => process.cwd(),
    enqueue: envelope => envelopes.push(envelope),
  })
  capture.workspace = () => workspace
  recall = new RecallController({ store, engine: engine as never, config, workspace: () => workspace })
  for (const agent of [main, subA, subB]) capture.registerAgent(agent)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('E2E-02 multi-agent sharing', () => {
  it('binds each agent to its own principal and records the subagent parent', () => {
    const sessions = ['session-main', 'session-sub-a', 'session-sub-b'].map(id => store.getAgentSession(id))
    expect(sessions.every(Boolean)).toBe(true)
    expect(sessions[0]?.parent_agent_id).toBeNull()
    expect(sessions[1]?.parent_agent_id).toBe('session-main')
    expect(sessions[2]?.parent_agent_id).toBe('session-main')
  })

  it('captures the main agent decision exactly once and stores it unverified', async () => {
    capture.observe('session-main', userEvent('We decided to deploy with a blue-green rollout for project multi.'))
    capture.observe('session-main', { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(envelopes).toHaveLength(1)

    const envelope = envelopes[0]!
    const processed = await capture.process(envelope, envelope.sourceKey)
    expect(processed.created.length + processed.needsReview.length).toBe(1)
    const memoryId = [...processed.created, ...processed.needsReview][0]!
    const stored = store.getMemory(memoryId)
    expect(stored?.scope).toBe('workspace')
    expect(stored?.status).not.toBe('verified')
  })

  it('replaying the same capture does not duplicate the memory', async () => {
    capture.observe('session-main', userEvent('We decided to deploy with a blue-green rollout for project multi.'))
    capture.observe('session-main', { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    const envelope = envelopes[0]!
    await capture.process(envelope, envelope.sourceKey)
    const before = store.overview(workspace.projectId).total
    await capture.process(envelope, envelope.sourceKey)
    expect(store.overview(workspace.projectId).total).toBe(before)
  })

  it('default-denies a subagent that has no grant, then shares after an explicit one', async () => {
    capture.observe('session-main', userEvent('We decided to deploy with a blue-green rollout for project multi.'))
    capture.observe('session-main', { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    await capture.process(envelopes[0]!, envelopes[0]!.sourceKey)

    const query = 'what rollout did we decide for deployment'
    const denied = await recall.search({ principalId: 'agent:session-sub-a', agentId: 'session-sub-a', sessionId: 'session-sub-a', query })
    expect(denied.clues).toHaveLength(0)

    for (const subject of ['agent:session-sub-a', 'agent:session-sub-b']) {
      store.addGrant({
        subjectId: subject,
        objectScope: `workspace:${workspace.workspaceId}`,
        action: 'read',
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        issuer: 'owner',
      })
    }
    recall.invalidate()
    const a = await recall.search({ principalId: 'agent:session-sub-a', agentId: 'session-sub-a', sessionId: 'session-sub-a', query })
    const b = await recall.search({ principalId: 'agent:session-sub-b', agentId: 'session-sub-b', sessionId: 'session-sub-b', query })
    expect(a.clues.length).toBeGreaterThanOrEqual(1)
    expect(b.clues.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps a subagent private record away from its sibling and its parent', () => {
    const privateRecord = store.createMemory(
      {
        scene: 'chat',
        kind: 'fact',
        title: 'subagent A scratch',
        content: 'subagent A private scratch note about the rollout',
        status: 'supported',
        scope: 'private',
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        agentId: 'session-sub-a',
        authorPrincipalId: 'agent:session-sub-a',
        evidenceIds: [],
      },
      'agent:session-sub-a',
    )
    expect(privateRecord.id).toBeTruthy()
    expect(store.getMemory(privateRecord.id, 'agent:session-sub-a')).not.toBeNull()
    expect(store.getMemory(privateRecord.id, 'agent:session-sub-b')).toBeNull()
    expect(store.getMemory(privateRecord.id, 'agent:session-main')).toBeNull()

    const grant = store.addGrant({
      subjectId: 'agent:session-sub-b',
      objectScope: `memory:${privateRecord.id}`,
      action: 'read',
      projectId: workspace.projectId,
      issuer: 'owner',
    })
    expect(store.getMemory(privateRecord.id, 'agent:session-sub-b')).not.toBeNull()
    store.revokeGrant(grant.id, 'owner')
    expect(store.getMemory(privateRecord.id, 'agent:session-sub-b')).toBeNull()
  })
})

