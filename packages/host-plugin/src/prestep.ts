import { uuidv7 } from '@dsh-hy-memory/contracts'
import { textOf, type AgentLike, type MessageLike } from './dsh-types.js'

export interface PrestepPayload {
  readonly agent: AgentLike
  readonly messages: readonly MessageLike[]
  readonly turn: number
  readonly step: number
  readonly signal?: AbortSignal
}

export interface PrestepLookupInput {
  readonly agent: AgentLike
  readonly query: string
  readonly turn: number
  readonly step: number
  readonly signal?: AbortSignal
}

export interface PrestepLookupResult {
  readonly clues: readonly unknown[]
  readonly rendered?: string
}

export interface PrestepOptions {
  /** Whether automatic clue injection is currently enabled. */
  readonly enabled: () => boolean
  /** Whether this step begins a recall boundary; disabled mode still clears old context. */
  readonly shouldLookup?: (payload: PrestepPayload) => boolean
  readonly registerAgent?: (agent: AgentLike) => void
  readonly lookup?: (input: PrestepLookupInput) => Promise<PrestepLookupResult>
  readonly logger?: { warn(message: string): void }
}

interface SurfaceNode {
  readonly seq: number
  readonly message: MessageLike
}

type NativeSurfaceSession = AgentLike['session'] & {
  readonly seq?: number
  readonly surface?: { readonly nodes?: readonly number[] }
  deriveMessages?: () => MessageLike[]
  append?: (
    type: string,
    data: unknown,
    options: { surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] },
  ) => unknown
}

const OWNED_PRODUCER = 'dsh-hy-memory:v1'
const emptyOwnedSequences = new WeakMap<object, Set<number>>()

/** Read the most recent user-authored text, excluding plugin and runtime context. */
export function latestOrdinaryUserText(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const sourceKind = message.source?.kind
    if (
      sourceKind === 'hymem:clues'
      || sourceKind === 'runtime-context'
      || sourceKind?.includes('runtime-context')
      || (message.source?.form === 'context' && sourceKind !== 'user')
    ) continue
    const text = textOf(message)
    if (text) return text
  }
  return ''
}

function acceptedDecision(value: unknown): value is { readonly kind: 'enter'; readonly messages: readonly MessageLike[] } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'enter'
}

function hasVisibleContent(message: MessageLike): boolean {
  if (!Array.isArray(message.content)) return typeof message.content === 'string' && message.content.trim().length > 0
  return message.content.some(block => block.type !== 'text' || (typeof block.text === 'string' && block.text.trim().length > 0))
}

const ABORTED = Symbol('aborted')

function waitForAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return task
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      resolve(ABORTED)
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    task.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

function surfaceSession(session: AgentLike['session']): (NativeSurfaceSession & { readonly surface: { readonly nodes: readonly number[] } }) | undefined {
  const candidate = session as NativeSurfaceSession
  if (
    typeof candidate.append !== 'function'
    || typeof candidate.deriveMessages !== 'function'
    || !Number.isSafeInteger(candidate.seq)
    || candidate.seq! < 0
    || !Array.isArray(candidate.surface?.nodes)
  ) {
    return undefined
  }
  return candidate as NativeSurfaceSession & { readonly surface: { readonly nodes: readonly number[] } }
}

function ownedNodes(session: NativeSurfaceSession & { readonly surface: { readonly nodes: readonly number[] } }): SurfaceNode[] {
  const currentNodes = new Set(session.surface.nodes)
  const found = new Map<number, SurfaceNode>()
  for (const message of session.deriveMessages?.() ?? []) {
    const source = message.source
    if (source?.kind !== 'hymem:clues' || source.producer !== OWNED_PRODUCER) continue
    const seq = Number(source.hymemNodeSeq)
    if (!Number.isSafeInteger(seq) || String(seq) !== source.hymemNodeSeq || !currentNodes.has(seq)) continue
    found.set(seq, { seq, message })
  }
  const empties = emptyOwnedSequences.get(session)
  if (empties) {
    for (const seq of empties) {
      if (!currentNodes.has(seq)) {
        empties.delete(seq)
        continue
      }
      if (!found.has(seq)) {
        found.set(seq, {
          seq,
          message: { role: 'developer', content: [], source: { kind: 'hymem:clues', producer: OWNED_PRODUCER, hymemNodeSeq: String(seq) } },
        })
      }
    }
  }
  return [...found.values()].sort((left, right) => left.seq - right.seq)
}

function replaceNode(
  session: NativeSurfaceSession,
  seq: number,
  turn: number,
  step: number,
  message: { readonly id: string; readonly role: 'user' | 'developer'; readonly content: MessageLike['content']; readonly source: Record<string, string> },
): void {
  const type = message.role === 'user' ? 'user/message' : 'developer/message'
  const eventSeq = session.seq
  if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq)) throw new Error('native Session seq is unavailable')
  const ownedMessage = {
    ...message,
    source: { ...message.source, producer: OWNED_PRODUCER, hymemNodeSeq: String(eventSeq) },
  }
  const data = message.role === 'user'
    ? ownedMessage
    : { turn, step, message: ownedMessage }
  session.append?.(type, data, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
  // Failed appends do not consume a sequence. Commit ownership only after the
  // native append succeeds, so a later ordinary message can never inherit it.
  const empties = emptyOwnedSequences.get(session) ?? new Set<number>()
  empties.delete(seq)
  if (!hasVisibleContent(ownedMessage)) empties.add(eventSeq)
  else empties.delete(eventSeq)
  emptyOwnedSequences.set(session, empties)
}

function appendClue(session: NativeSurfaceSession, rendered: string): void {
  const eventSeq = session.seq
  if (!Number.isSafeInteger(eventSeq)) throw new Error('native Session seq is unavailable')
  session.append?.(
    'user/message',
    {
      id: uuidv7(),
      role: 'user',
      content: [{ type: 'text', text: rendered }],
      source: {
        kind: 'hymem:clues',
        form: 'context',
        summary: 'memory clues',
        producer: OWNED_PRODUCER,
        hymemNodeSeq: String(eventSeq),
      },
    },
    { surfaceOp: 'append' },
  )
}

/** Replace or clear only Hymem-owned visible context nodes on the native DSH surface. */
function updateOwnedContext(
  session: NativeSurfaceSession & { readonly surface: { readonly nodes: readonly number[] } },
  rendered: string,
  turn: number,
  step: number,
): void {
  const initialVisible = ownedNodes(session).filter(node => hasVisibleContent(node.message))

  // A single owned clue can be replaced directly, avoiding an intermediate node.
  if (rendered && initialVisible.length === 1) {
    const current = ownedNodes(session).find(node => node.seq === initialVisible[0]?.seq)
    if (current && hasVisibleContent(current.message)) {
      const message = {
        id: uuidv7(),
        role: 'user' as const,
        content: [{ type: 'text', text: rendered }],
        source: { kind: 'hymem:clues', form: 'context', summary: 'memory clues' },
      }
      replaceNode(session, current.seq, turn, step, message)
      return
    }
  }

  // Clear every old non-empty node separately so unrelated surface nodes are never shadowed.
  for (const old of initialVisible) {
    const current = ownedNodes(session).find(node => node.seq === old.seq)
    if (!current || !hasVisibleContent(current.message)) continue
    replaceNode(session, current.seq, turn, step, {
      id: uuidv7(),
      role: 'developer',
      content: [],
      source: { kind: 'hymem:clues' },
    })
  }

  if (!rendered) return
  const emptyOwned = ownedNodes(session).find(node => !hasVisibleContent(node.message))
  if (emptyOwned) {
    replaceNode(session, emptyOwned.seq, turn, step, {
      id: uuidv7(),
      role: 'user',
      content: [{ type: 'text', text: rendered }],
      source: { kind: 'hymem:clues', form: 'context', summary: 'memory clues' },
    })
    return
  }
  appendClue(session, rendered)
}

/** Create a downstream-first adapter for the native DSH pre-step waterfall. */
export function createPrestepHandler(options: PrestepOptions) {
  return async (payload: PrestepPayload, next: () => Promise<unknown>): Promise<unknown> => {
    const decision = await next()
    if (!acceptedDecision(decision)) return decision
    if (payload.signal?.aborted) return decision
    try {
      options.registerAgent?.(payload.agent)
    } catch (error) {
      options.logger?.warn(`hymem: agent registration skipped: ${error instanceof Error ? error.message : String(error)}`)
    }

    let shouldInject = false
    try {
      shouldInject = options.enabled()
    } catch (error) {
      options.logger?.warn(`hymem: pre-step settings unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    let shouldLookup = false
    if (shouldInject) {
      try {
        shouldLookup = options.shouldLookup?.(payload) ?? true
      } catch (error) {
        options.logger?.warn(`hymem: pre-step boundary unavailable: ${error instanceof Error ? error.message : String(error)}`)
        shouldInject = false
      }
    }
    if (shouldInject && !shouldLookup) return decision

    let session: ReturnType<typeof surfaceSession>
    try {
      session = surfaceSession(payload.agent.session)
    } catch (error) {
      options.logger?.warn(`hymem: native Session surface unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
    if (!session) {
      options.logger?.warn('hymem: native Session surface unavailable; automatic context disabled, memory tools remain available')
      return decision
    }

    let rendered = ''
    if (shouldLookup) {
      const query = latestOrdinaryUserText(decision.messages ?? payload.messages).slice(0, 2000)
      if (query.length > 2 && options.lookup) {
        try {
          const outcome = await waitForAbort(options.lookup({
            agent: payload.agent,
            query,
            turn: payload.turn,
            step: payload.step,
            ...(payload.signal ? { signal: payload.signal } : {}),
          }), payload.signal)
          if (outcome === ABORTED || payload.signal?.aborted) return decision
          if (outcome.clues.length > 0 && typeof outcome.rendered === 'string' && outcome.rendered.trim()) {
            rendered = outcome.rendered
          }
        } catch (error) {
          options.logger?.warn(`hymem: recall skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    if (payload.signal?.aborted) return decision
    try {
      updateOwnedContext(session, rendered, payload.turn, payload.step)
    } catch (error) {
      options.logger?.warn(`hymem: native context update skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  }
}
