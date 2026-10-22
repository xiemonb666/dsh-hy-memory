/**
 * Runtime container shared by the tools, hooks and Studio API. Constructed once
 * per plugin activation and disposed with the plugin fiber.
 */
import type { GovernanceStore } from '@dsh-hy-memory/governance'
import type { EngineClient } from './engine.js'
import type { RecallController } from './recall.js'
import type { CapturePipeline } from './capture.js'
import type { HostConfig } from './config.js'
import type { WorkspaceIdentity } from './identity.js'
import type { AgentLike } from './dsh-types.js'

export interface PrincipalIdentity {
  principalId: string
  agentId: string
  sessionId: string
}

export interface HostRuntime {
  readonly config: HostConfig
  readonly store: GovernanceStore
  /** The current worker client. Replaced when the worker is restarted. */
  engine: EngineClient
  readonly recall: RecallController
  readonly capture: CapturePipeline
  readonly logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
  workspace(): WorkspaceIdentity
  identityOf(agent: AgentLike): PrincipalIdentity
  engineHealth(): Promise<{ ok: boolean; degraded: boolean; reason: string | null; engine: string; version: string }>
}

/**
 * Derive the authenticated principal for an agent. The principal is bound by
 * the host at activation time; model-supplied text never participates.
 * @param agent - live agent from a tool execution or pre-step payload.
 * @returns stable principal, agent and session ids.
 */
export function identityOfAgent(agent: AgentLike): PrincipalIdentity {
  const sessionId = agent.session.id
  return { principalId: `agent:${sessionId}`, agentId: sessionId, sessionId }
}