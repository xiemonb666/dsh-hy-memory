/**
 * Minimal structural types for the DeepSeek Harness host objects this plugin
 * touches. They are intentionally narrow: the plugin only relies on documented
 * lifecycle surfaces (session events, pre-step, prompt sections, tool registry,
 * slots) and never on internal classes.
 */

export interface SessionLike {
  readonly id: string
  readonly seq?: number
  readonly surface?: { readonly nodes?: readonly number[] }
  deriveMessages?: () => MessageLike[]
  append?: (
    type: string,
    data: unknown,
    options: { surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] },
  ) => unknown
}

export interface AgentLike {
  readonly session: SessionLike
  readonly parentAgent?: AgentLike
}

export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

export interface MessageLike {
  readonly role?: string
  readonly content?: readonly ContentBlockLike[] | string
  readonly source?: {
    readonly kind?: string
    readonly form?: string
    readonly producer?: string
    readonly hymemNodeSeq?: string
  }
  readonly toolCalls?: readonly ToolCallLike[]
  readonly toolCallId?: string
  readonly toolName?: string
  readonly isError?: boolean
}

export interface ToolCallLike {
  readonly id: string
  readonly name: string
  readonly arguments?: string
}

export interface SessionEventLike {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: Record<string, unknown>
}

export interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly callId?: string
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

export interface ToolResultLike {
  readonly content?: readonly ContentBlockLike[]
  readonly isError?: boolean
  readonly value?: unknown
  readonly meta?: unknown
}

export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: { scope?: string }) => string)
}

export interface PromptContextLike {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: { scope?: string }) => string)
  readonly required?: boolean
}

export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  readonly execute: (args: Record<string, unknown>, exec: ToolExecutionLike) => Promise<unknown>
  readonly presentCall?: (args: Record<string, unknown>) => Record<string, unknown>
}

/** The subset of the Cordis context used by this plugin. */
export interface HostContextLike {
  readonly logger: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
    debug?(message: string): void
  }
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(execute: () => (() => void | Promise<void>) | void, label?: string): () => void
  readonly tools: { register(definition: ToolDefinitionLike): () => void }
  readonly systemPrompt: {
    section(section: PromptSectionLike): () => void
    context(context: PromptContextLike): () => void
  }
  readonly slots?: {
    inject(key: string, callback: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  readonly layout?: { selectPanel(id: string): void }
  get?(name: string): unknown
}

/** Read plain text from a content-block array or string. */
export function textOf(message: MessageLike | undefined): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!content) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool_result' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Extract an exit code from tool-result text or meta when one is present. */
export function exitCodeOf(message: MessageLike | undefined): number | undefined {
  const text = textOf(message)
  const patterns = [
    /exit\s*code[:\s=]+(-?\d+)/i,
    /\[exit code:\s*(-?\d+)\]/i,
    /process exited with code\s*(-?\d+)/i,
    /returned\s+(-?\d+)/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) {
      const value = Number.parseInt(match[1], 10)
      if (Number.isFinite(value)) return value
    }
  }
  return undefined
}
