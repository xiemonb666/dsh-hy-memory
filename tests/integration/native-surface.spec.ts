import { describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '@dsh-hy-memory/contracts'
import { createPrestepHandler } from '../../packages/host-plugin/src/prestep.js'

const sessionEntry = new URL(
  '../../.upstream/dsh/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
  import.meta.url,
)
let NativeSession: (new (id: string) => {
  append(type: string, data: unknown, options: unknown): unknown
  readonly seq: number
  readonly surface: { readonly nodes: readonly number[] }
  deriveMessages(): Array<{ readonly role?: string; readonly content?: unknown; readonly source?: { readonly kind?: string } }>
}) | undefined
try {
  const module = await import(sessionEntry.href) as { Session?: typeof NativeSession }
  NativeSession = module.Session
} catch {
  NativeSession = undefined
}

const nativeDescribe = NativeSession ? describe : describe.skip

nativeDescribe('native DSH Session surface integration', () => {
  it('uses the maintained message projection without calling deprecated eventAt', async () => {
    const session = new NativeSession!('hymem-native-no-event-at')
    const deprecatedReader = vi.fn(() => { throw new Error('eventAt must not be used') })
    ;(session as unknown as { eventAt: (seq: number) => never }).eventAt = deprecatedReader
    const userMessage = {
      id: uuidv7(),
      role: 'user',
      content: [{ type: 'text', text: 'query without deprecated reads' }],
      source: { kind: 'user' },
    }
    session.append('user/message', userMessage, { surfaceOp: 'append' })
    const handler = createPrestepHandler({
      enabled: () => true,
      lookup: async () => ({ clues: [{ id: 'offline-memory' }], rendered: '<memory_clues>offline fact</memory_clues>' }),
    })

    await handler(
      { agent: { session: session as never }, messages: [userMessage], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [userMessage] }),
    )

    const clues = session.deriveMessages().filter(message => message.source?.kind === 'hymem:clues')
    const marker = (clues[0]?.source as Record<string, string> | undefined)
    expect(deprecatedReader).not.toHaveBeenCalled()
    expect(clues).toHaveLength(1)
    expect(marker).toMatchObject({ producer: 'dsh-hy-memory:v1' })
    expect(session.surface.nodes).toContain(Number(marker?.hymemNodeSeq))
  })

  it('keeps one Hymem clue through 50 real hook turns and clears it without losing ordinary user messages', async () => {
    const session = new NativeSession!('hymem-native-surface-proof')
    let returnClue = true
    const handler = createPrestepHandler({
      enabled: () => true,
      lookup: async () => returnClue
        ? { clues: [{ id: 'offline-memory' }], rendered: '<memory_clues>offline fact</memory_clues>' }
        : { clues: [], rendered: '' },
    })

    for (let turn = 1; turn <= 50; turn++) {
      const userMessage = {
        id: uuidv7(),
        role: 'user',
        content: [{ type: 'text', text: `ordinary user turn ${turn}` }],
        source: { kind: 'user' },
      }
      session.append('user/message', userMessage, { surfaceOp: 'append' })
      const decision = { kind: 'enter', messages: [userMessage], startsRequestSeries: turn === 1 }
      const result = await handler(
        { agent: { session: session as never }, messages: [userMessage], turn, step: 1 },
        async () => decision,
      )

      expect(result).toBe(decision)
      const derived = session.deriveMessages()
      expect(derived.filter(message => message.source?.kind === 'hymem:clues')).toHaveLength(1)
      expect(derived.filter(message => message.role === 'user' && message.source?.kind === 'user')).toHaveLength(turn)
    }

    returnClue = false
    await handler(
      { agent: { session: session as never }, messages: [], turn: 51, step: 1 },
      async () => ({ kind: 'enter', messages: [], startsRequestSeries: false }),
    )
    const finalMessages = session.deriveMessages()
    expect(finalMessages.filter(message => message.source?.kind === 'hymem:clues')).toHaveLength(0)
    expect(finalMessages.filter(message => message.role === 'user' && message.source?.kind === 'user')).toHaveLength(50)
  })

  it('clears previously owned context when settings become unavailable', async () => {
    const session = new NativeSession!('hymem-native-settings-failure')
    const deprecatedReader = vi.fn(() => { throw new Error('eventAt must not be used') })
    ;(session as unknown as { eventAt: (seq: number) => never }).eventAt = deprecatedReader
    const agent = { session: session as never }
    const input = { id: uuidv7(), role: 'user', content: [{ type: 'text', text: 'ordinary request' }], source: { kind: 'user' } }
    session.append('user/message', input, { surfaceOp: 'append' })
    const decision = { kind: 'enter', messages: [input] }
    const enabled = createPrestepHandler({
      enabled: () => true,
      lookup: async () => ({ clues: [{ id: 'memory-1' }], rendered: '<memory_clues>old clue</memory_clues>' }),
    })
    await enabled({ agent, messages: [input], turn: 1, step: 1 }, async () => decision)
    const logger = { warn: vi.fn() }
    const unavailable = createPrestepHandler({
      enabled: () => { throw new Error('settings unavailable') },
      logger,
    })

    const result = await unavailable({ agent, messages: [], turn: 2, step: 1 }, async () => decision)

    expect(result).toBe(decision)
    expect(session.deriveMessages().filter(message => message.source?.kind === 'hymem:clues')).toHaveLength(0)
    expect(deprecatedReader).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('settings unavailable'))
  })

  it('deduplicates multiple owned nodes without replacing ordinary or other-plugin messages', async () => {
    const session = new NativeSession!('hymem-native-multiple-owned')
    const firstUser = { id: uuidv7(), role: 'user', content: [{ type: 'text', text: 'first ordinary' }], source: { kind: 'user' } }
    const oldClue = (text: string) => ({
      id: uuidv7(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'hymem:clues',
        form: 'context',
        summary: 'old memory',
        producer: 'dsh-hy-memory:v1',
        hymemNodeSeq: String(session.seq),
      },
    })
    session.append('user/message', firstUser, { surfaceOp: 'append' })
    session.append('user/message', oldClue('old clue one'), { surfaceOp: 'append' })
    session.append('developer/message', {
      turn: 1,
      step: 1,
      message: { id: uuidv7(), role: 'developer', content: [{ type: 'text', text: 'other plugin context' }], source: { kind: 'other-plugin' } },
    }, { surfaceOp: 'append' })
    const secondUser = { id: uuidv7(), role: 'user', content: [{ type: 'text', text: 'second ordinary' }], source: { kind: 'user' } }
    session.append('user/message', secondUser, { surfaceOp: 'append' })
    session.append('user/message', oldClue('old clue two'), { surfaceOp: 'append' })
    const handler = createPrestepHandler({
      enabled: () => true,
      lookup: async () => ({ clues: [{ id: 'memory-current' }], rendered: '<memory_clues>current clue</memory_clues>' }),
    })
    const decision = { kind: 'enter', messages: [secondUser] }

    await handler(
      { agent: { session: session as never }, messages: [secondUser], turn: 2, step: 1 },
      async () => decision,
    )
    const derived = session.deriveMessages()

    expect(derived.filter(message => message.source?.kind === 'hymem:clues')).toHaveLength(1)
    expect(derived.filter(message => message.role === 'user' && message.source?.kind === 'user')).toHaveLength(2)
    expect(derived.filter(message => message.source?.kind === 'other-plugin')).toHaveLength(1)
  })
})
