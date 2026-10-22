# DSH Plugin API Map (implementation-ready reference)

Verified against installed packages `0.2.1-rc.2` and the source checkout at commit `687f282e`. Every API name below was read from a file; `UNVERIFIED` marks claims I could not confirm in the time available.

**Path legend** (shortened in citations):

- `SRC\` = `<repo>\.upstream\dsh-src`
- `PKG\` = `<repo>\.upstream\dsh\dsh\node_modules\@deepseek-ai`

Installed packages ship **built `lib/*.js` with JSDoc and no `.d.ts`**; type declarations in this document therefore come from `SRC\packages\**`, behavior from both.

---

## 1. Host plugin export forms

A plugin is a TS module exporting `apply`; the framework calls it with a `ctx`.

`SRC\docs\user\develop\basic\index.md:19-27`
```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register capabilities here.
}
```

**Rule (binding):** function plugins named-export `name` / `inject` / `Config` / `apply` and have **no default export**; mixing forms makes the Loader discard the function plugin's namespace (`SRC\packages\AGENTS.md`, "Plugin exports"; postmortem `SRC\docs\postmortem\0001-acp-default-export-drops-inject.md`).

Object and class forms, `SRC\docs\user\develop\basic\index.md:111-136`:
```ts
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}
```
```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) {
    super(ctx, 'myService')   // service name
  }
}
```

Dependencies and cleanup, `SRC\docs\user\develop\basic\index.md:91-101` and `:70-85`:
```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']
export function apply(ctx: Context) { ctx.tools.register(/* ... */) }
```
```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => { console.log('heartbeat') }, 5000)
    // The returned function runs when the plugin unloads.
    return () => clearInterval(timer)
  })
}
```

Everything registered through `ctx` (`ctx.on`, `ctx.tools.register`, `ctx.llm.registerAdapter`, `ctx.effect`) is disposed on unload; disposers start in reverse registration order but concurrent async disposers have no serial completion guarantee — put order-dependent cleanup in one disposer (`SRC\docs\user\develop\framework\index.md:42-63`).

`ctx.effect` also takes a label as its second argument — real client usage, `PKG\dsh-client-ui-plugin-manager\lib\client.js:4373-4376`:
```js
ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-plugin-manager: dictionaries");
```

### Schemastery `Config`

`SRC\docs\user\develop\basic\config.md:11-32`
```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)  // User value or schema default.
}
```

Validation forms (`required()`, `Schema.union`) at `SRC\docs\user\develop\basic\config.md:63-72`. "Do not export a plain object as `Config`; it does not implement the Standard Schema interface required by Cordis" (`:45`). Invalid config fails the load (`:74`). Row config is YAML under `config:` (`:36-43`).

---

## 2. Session events

### Exact Cordis event signature

`SRC\packages\core\session\src\index.ts:64-74` (declaration merging on `Events`):
```ts
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

Sibling events: `'session/created'` (`:54`), `'session/disposed'` (`:63`), `'session/flush'` (`@mode parallel`, `:82`).

Listener form: `ctx.on('session/event', (session, event) => { ... })` — hundreds of real call sites, e.g. `SRC\packages\goal\goal\src\index.ts:259`, `SRC\packages\session\session-projection\src\index.ts:220`.

**Not Cordis events:** `turn/*`, `step/*`, `tool/call`, `tool/result`, `compaction/*` are durable session-event types; observe them via `session/event` and switch on `event.type` (`SRC\docs\user\develop\framework\events.md:104-106`).

### Envelope

`SRC\packages\core\session\src\types.ts:494-517`
```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: SessionSeq
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
    ignorable?: true
  } & (K extends SurfaceEventType ? SurfaceIntent<K> : {
    surfaceOp?: never
    sourceEventSeqs?: never
  })
}[T]
```

### `SessionEventMap` members (exact)

`SRC\packages\core\session\src\types.ts:282-429` (comments elided; each line number given):

| line | member |
|---|---|
| 289 | `'turn/start': { turn: number }` |
| 298 | `'turn/end': { turn: number; reason: TurnEndReason }` |
| 300 | `'step/start': { turn: number; step: number }` |
| 302 | `'step/end': { turn: number; step: number }` |
| 310 | `'user/message': UserMessage` |
| 312-318 | `'developer/message': { turn: number; step: number; message: DeveloperMessage; headerSeq?: SessionSeq }` |
| 331 | `'system/message': { turn: number; step: number; message: SystemMessage }` |
| 342-350 | `'assistant/message': { turn; step; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }` |
| 356 | `'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }` |
| 362 | `'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }` |
| 376-386 | `'tool/result': { turn; step; message: ToolResultMessage; error?: { name: string; code: string; reason?: string }; meta?: JsonValue }` |
| 391-396 | `'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true }` |
| 403 | `'request/context': RequestContext` |
| 428 | `'session/end-seed': { inherited?: true }` |

Key contracts read from the same file:
- `'tool/call'` `arguments` is "the raw `arguments` JSON string exactly as the model produced it (unparsed)" (`:358-361`).
- `'tool/result'` `error` is "allowed only when the message has `isError: true`", and `meta` "MUST be JSON-serializable" (`:363-385`).
- `'assistant/message'` carries `usage` and `interrupted: true` for a cancelled mid-stream turn (`:332-341`).
- `SessionEventType = keyof SessionEventMap` (`:432`); `SurfaceEventType = 'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result'` (`:440-445`).

Related types: `TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]` (`types.ts:233`); `UserMessage` / `AssistantMessage` / `ToolResultMessage` at `SRC\packages\llm\llm\src\message.ts:162`, `:167`, `:173` (bodies not read in detail — UNVERIFIED for field lists).

### Getting session id, turn id, agent principal

- **Session** — first listener argument `session: Session` (`index.ts:74`). `Session` is keyed by `SessionId` (`types.ts:88` `TypertLookup<Session, SessionId>`, `:552-556` `TypertResource<SessionId>`). The literal property that yields that id (`session.id`?) is **UNVERIFIED** — not read.
- **Turn / step** — `event.data.turn`, `event.data.step` on every turn/step/message event (`types.ts:289-386`). Note `turn/start` and `turn/end` carry only `{turn}` / `{turn, reason}`.
- **Agent principal** — available on `agent/*` payloads (`payload.agent: Agent`, `SRC\packages\core\agent\src\runtime-types.ts:320`) and on tool executions (`ToolExecutionInput.agent?: Agent`, `SRC\packages\core\tools\src\index.ts:340`). `session/event` carries **no** agent field; mapping a `Session` back to its `Agent` is **UNVERIFIED** (look at `ctx.agents` / `agent.session` identity comparison).

---

## 3. `agent/pre-step` (waterfall)

`SRC\packages\core\agent\src\runtime-types.ts:309-320`
```ts
    /**
     * Reject a proposed step or replace the messages that enter it. Calling
     * `next()` preserves the current messages.
     * @param payload.agent - the agent proposing the step.
     * @param payload.messages - messages removed from the inbox for this step.
     * @param payload.turn - the turn that will own the step.
     * @param payload.step - the step proposed by the loop.
     * @param payload.signal - the current turn's cancellation signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

Return type, `SRC\packages\core\agent\src\runtime-types.ts:111-119`
```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true
  }
```

`next()` semantics (authoritative prose): a waterfall listener **must** call `next()` to delegate; omitting it short-circuits the pipeline by design (`SRC\docs\user\develop\framework\events.md:64-81`). For this event, `next()` resolves the downstream decision, and "Calling `next()` preserves the current messages" (`runtime-types.ts:310-311`).

**How to inject context safely:** the only model-visible channel here is `messages: UserMessage[]` in the returned `{kind:'enter'}` — i.e. returning a replacement list, which the loop then logs as `user/message`. Do not mutate the payload array in place. The adjacent `'agent/request'` waterfall explicitly states it "cannot mutate messages" and that "Model-visible content must use logged channels" (`runtime-types.ts:321-337`), which is the same rule: model-visible ⟺ logged (`SRC\AGENTS.md`, "Model-visible ⟺ logged"). A non-rejecting listener that needs to add context usually appends synthetic `UserMessage`s to `messages` inside `{kind:'enter'}` — **UNVERIFIED** whether an `agent.inject()` helper is the preferred path (referenced by `'user/message'` JSDoc at `types.ts:303-310` as "a synthetic `agent.inject()` context").

Rejecting means the claimed inbox message "ends here: it is neither discarded nor re-emitted as a user/message, and the turn closes without a step" (`runtime-types.ts:290-292`).

---

## 4. `ctx.systemPrompt.section()`

Service is provided as `systemPrompt` (`SRC\packages\core\system-prompt\src\index.ts:446` `super(ctx, 'systemPrompt')`).

`SRC\packages\core\system-prompt\src\index.ts:470-487`
```ts
  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `system-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }
```

`PromptSection`, `SRC\packages\core\system-prompt\src\index.ts:52-76`
```ts
export interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /** Sections are concatenated in ascending order. Equal orders use code-unit name order. */
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  readonly complete?: boolean
}
```

Real registration, `SRC\packages\core\system-prompt\src\index.ts:450-455`
```ts
    this.section({
      name: 'harness:identity',
      order: this.getSectionOrder('HARNESS_IDENTITY'),
      text: 'You are an AI agent powered by DeepSeek Harness.',
    })
```

Plugin-side call shape (per the signature and the effect-disposer contract): `ctx.systemPrompt.section({ name, order, text })`, with `order` from `getSectionOrder(name)` (`:494-496`) where a registered placement exists, and the disposer owned by `ctx`. There is also `ctx.systemPrompt.context(PromptContext)` for dynamic context materialized as a durable user-role snapshot (`:78-89`, `:513-519`) — this is the model-visible, logged alternative to prompt text.

---

## 5. `ctx.tools.register(defineTool({...}))`

Import path: `@deepseek-ai/dsh-tools` (`SRC\docs\user\develop\basic\tool.md:13`).

Tutorial minimum, `SRC\docs\user\develop\basic\tool.md:19-32`
```ts
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
```

**Parameter schema dialect:** a JSON-Schema-like object keyed by parameter name, with DSH extensions `required: true` per property (instead of a top-level `required` array), `enum`, `items`, `additionalProperties`, `type: 'object' | 'string' | 'array' | 'integer' | 'boolean'`. Real nested example, `PKG\dsh-tool-todo\lib\index.js:95-119`
```js
	ctx.tools.register(defineTool({
		name: "todo_write",
		description: describe(allowParallel),
		parameters: { todos: {
			type: "array",
			required: true,
			description: "The COMPLETE task list, replacing any previous list.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					content: { type: "string", required: true, description: "What the task is — a short imperative line." },
					status: { type: "string", required: true, enum: [...STATUSES], description: "pending (not started) | in_progress (now) | completed (done)." }
				}
			}
		} },
```

**Output + render**, same file `:120-169` — `output.schema` is the canonical value schema, `output.render: (args, value) => ContentBlock[]`
```js
			render: (_args, value) => [{
				type: "text",
				text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`
			}]
```

**`execute(args, exec)`**, same file `:170-186`
```js
		execute(args, exec) {
			const todos = toTodoList(args.todos, allowParallel);
			if (!exec.agent) throw new Error("todo_write requires an owning agent session");
			exec.agent.session.append("todo/write", { todos });
			...
```

**Exec context fields.** `SRC\packages\core\tools\src\index.ts:327-353` (`ToolExecutionInput`, which is what `execute` receives):
```ts
export interface ToolExecutionInput {
  readonly callId: ToolCallId
  readonly rootCallId?: ToolCallId
  readonly name: string
  readonly schema?: ToolSchema
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  readonly parent?: ToolExecutionToken
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}
```
`agent` is optional, so guard it (as `todo_write` does); `signal` is required and caller-owned. **Session access is via `exec.agent.session`** (`PKG\dsh-tool-todo\lib\index.ts:173`), not a direct `exec.session` field — `ToolExecutionInput` has no `session` member.

The definition-side contract is `execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>` (`SRC\packages\core\tools\src\schema.ts:515`), with a second registration form at `SRC\packages\core\tools\src\index.ts:237` `execute(args: unknown, exec: ToolRunContext): Promise<unknown>`.

`presentCall` produces the UI card, `PKG\dsh-tool-todo\lib\index.js:187-192`
```js
		presentCall: (args) => ({
			card: "generic",
			title: "Update todo list",
			kind: "other",
			rawInput: args.todos
		})
```

**Error semantics:** model-facing failure is a thrown `Error` from `execute` (observed at `:172`); structured failure identity is the `tool/result` event's `error: { name, code, reason? }`, permitted only when `message.isError` is true (`SRC\packages\core\session\src\types.ts:376-385`). Exact mapping from a thrown error to `{name, code}` is **UNVERIFIED**.

---

## 6. Client plugin bundle format

### `dsh.client` manifest

Validator, `SRC\packages\client\modules\src\client\manifest.ts:173-193`
```ts
export function parseDshClient(pkgName: string, value: unknown): DshClientManifest | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}
```

Field semantics, `SRC\packages\client\modules\src\client\manifest.ts:44-68`
```ts
export interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  url: string
  rev: string
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
  /** Stage-one prefetch mark: load the script for factory registration during module-face boot. */
  immediately?: boolean
  /** Non-baseline module specifiers this row requests; omitted when it requests none. */
  external?: string[]
}
```

Real declaration, `PKG\dsh-client-ui-plugin-manager\package.json`
```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  }
```

Constraints (`SRC\packages\client\AGENTS.md`, "dsh.client manifest semantics"): `platform: 'web'` always, and the declaration **requires a `./client` export** (the scan throws without one); `immediately: true` only for stage-one-prefetch infrastructure rows; `inject` is **informational only** (preflight display, HMR diffing) and does not sequence activation or apply order; `external` is a module-graph request, not a feature-plugin dependency mechanism.

`./client` export shape, same `package.json`:
```json
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    },
```

### Lazy factory registration (exact shape)

`PKG\dsh-client-ui-plugin-manager\lib\client.js:1-12`
```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

Contract, `SRC\packages\client\modules\src\client\manifest.ts:356-368`
```ts
export interface ClientBundleRegistration {
  /** Plugin id (package name) — the registration key; must match the graph row being executed. */
  id: string
  /** Package-local chunk filename; absent for the package's `client.js` entry. */
  chunk?: string
  /**
   * Closure factory holding the whole bundle body: receives the module-table
   * require whose `async` operation loads generated chunks, and returns the
   * bundle's exports. The factory runs once, at materialization.
   */
  factory: (require: ClientBundleRequire) => Record<string, unknown>
}
```
`ClientBundleRequire` is `(specifier: string) => unknown` plus `.async(specifier): Promise<unknown>` (`:348-354`). Model: executing a bundle only **registers** its factory; every module-body side effect — including CSS injection — runs at materialization (`:9-16`). `<id>/client` and the bare package name resolve to the same exports (`stripClientSuffix`, `:209-220`).

### `ctx.slots.inject` + `ctx.slots.register`

Cardinality/scope options, `SRC\docs\subsystems\slots.md:52-62`

| Axis | Value | Meaning |
|---|---|---|
| cardinality | `single` | one cell; active priority winner renders |
| cardinality | `list` | cells addressed by required `id`, ordered by `order` then registration order |
| cardinality | `keyed` | owner dispatches an `entryKey`; matching cell renders with key-specific props |
| cardinality | `chain` | each entry supplies `select(owner)`; first non-null in priority order renders |
| scope | `root` | one root-scoped component and store instance |
| scope | `session-maybe` | inherits surrounding Provider but renderable without one |
| scope | `session` | requires a resolved Provider binding |

Registration example, `SRC\docs\subsystems\slots.md:36-45`
```tsx
export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'review',
      order: 100,
    }, HeaderAction))
}
```

`ctx.slots.inject(key, callback)` waits for the actual declaration, removes the contribution when the owner collapses, reruns after redeclaration, and leaves with the caller's fiber; return a **generator** yielding several registrations to install/roll back atomically (`SRC\packages\client\AGENTS.md`, "Registering into another package's slot"). A bare `slots.register` into an undeclared slot is an error (`SRC\docs\subsystems\slots.md:17`).

`ctx.slots.renderSlot` usage: `root` is the only key rendered through the Cordis service — `ui-renderer` calls `ctx.slots.renderSlot('root', {})`; every descendant is rendered through the `renderSlot`/`renderSlotChain` prop of the entry that declared it (`SRC\docs\subsystems\slots.md:19`). Components receive `renderSlot` as a standard prop (rule 4, `SRC\packages\client\AGENTS.md`).

### Styles insertion

There is **no `ctx.styles` service** in any file read. Shipped bundles inject CSS themselves at materialization, `PKG\dsh-client-locale\lib\client.js:1026-1042`
```js
		//#region \0dsh-css:...\LanguageRow.module.css.mjs
		const css = ".Hefa_q_row{...}";
		const tagId = "@deepseek-ai/dsh-client-locale/LanguageRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-locale";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
```
The module loader tracks these owned tags per module (`styles: string[]` — "Owned `<style data-plugin>` tag ids (`data-plugin-css` values) injected during materialization", `SRC\packages\client\modules\src\client\manifest.ts:409-418`). This is **build-emitted** code (CSS Modules pipeline); a handwritten `client.js` must replicate the same `data-plugin-css` guard/cleanup itself. Whether the loader removes those tags on unload: **UNVERIFIED**.

### Locale service

`SRC\packages\client\locale\src\client\index.ts:399-400`, `:455-456`, `:214`, `:227`
```ts
  register(ns: string, locale: string, dict: LocaleDict): () => void
  register(ns: string, localeOrDicts: string | Record<string, LocaleDict>, dict?: LocaleDict): () => void {
```
```ts
  bind(ns: string): Translate {
```
```ts
  resolveText(text: LocalizedText): string {
```
```ts
  getSnapshot(): LocaleSnapshot {
```

Real usage, `PKG\dsh-client-ui-plugin-manager\lib\client.js:4373-4377` and `:4307-4318` / `:4481`
```js
ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-plugin-manager: dictionaries");
const t = ctx.locale.bind(NS);
```
```js
const current = ctx.locale.getSnapshot().revision;
```
```js
label: () => t("panel"),
```
A registration that declares `locale: NS` receives the localized `t` as a component prop (`SRC\docs\subsystems\slots.md:74`, `:98`). Product-visible copy must live in typed dictionaries; `verify-client-ui-i18n` rejects hardcoded copy (`SRC\docs\AGENTS.md` / `SRC\packages\client\AGENTS.md`).

### Does client `apply(ctx, config)` receive its row config?

The client plugin entry is `apply(ctx)` in every file read (`PKG\dsh-client-ui-plugin-manager\lib\client.js:4372` `function apply(ctx) {`; exports are `NS`, `PANEL_ID`, `apply`, `inject` at `:4486-4489`). No shipped client bundle in this survey reads a second `config` argument. **UNVERIFIED** — I did not find a client plugin with a non-empty `Config`. Treat client-side config delivery as an open question; the Host-side `Config` mechanism (§1) is the verified one.

---

## 7. Main panel navigation

Slot declarations, `SRC\packages\client\ui-layout\src\client\index.ts:69-73`
```ts
    /**
     * Central panel selected by sidebar entry id. The reserved `conversation`
     * key hosts the Conversation; other keys receive no Session binding.
     */
    'main': { kind: 'keyed'; scope: 'root' }
```
`sidebar.panellist`, `SRC\packages\client\ui-sidebar\src\client\contract\slots.ts:31-35`
```ts
    /**
     * Global panel icons. Each list id addresses the matching main panel;
     * the sidebar owns the button and resolves its label from list metadata.
     */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
```
Component props for that slot: `SidebarPanelIconOwnerProps { size: number; active: boolean }` (`:70-75`); metadata row: `SidebarPanelMetadata { id: MainPanelId; order: number; label: string }` (`:78-85`).

**Full example** — `PKG\dsh-client-ui-plugin-manager\lib\client.js:4353-4483` (verbatim excerpt; comments preserved)
```js
		/** Dictionary namespace owned by this plugin. */
		const NS = "pluginManager";
		/** The id shared by the sidebar entry and the main panel it opens. */
		const PANEL_ID = "plugins";
		/** Services required by the sidebar registration and the Remote methods; ... */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.pluginManager",
			"remote.pluginInventory",
			"remote.pluginRegistryProbe",
			"configForms",
			"layout"
		];
		...
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-plugin-manager: dictionaries");
			const t = ctx.locale.bind(NS);
```
```js
			ctx.slots.inject("main", function* () {
				const handle = createNavigationStore(), instance = handle.create();
				const store = {
					...handle,
					create: () => instance
				};
				yield ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: NS,
					store,
					inject: () => face,
					children: {
						"plugins.add.actions": { kind: "list", scope: "root" },
						"plugins.tab": { kind: "list", scope: "root" },
						"plugins.item": { kind: "list", scope: "root" },
						"plugins.bundle.activation": { kind: "keyed", scope: "root" },
						"plugins.bundle.config": { kind: "keyed", scope: "root" },
						"plugins.row.config": { kind: "keyed", scope: "root" },
						"plugins.detail.actions": { kind: "list", scope: "root" },
						"plugins.detail.badge": { kind: "list", scope: "root" },
						"plugins.detail.section": { kind: "list", scope: "root" }
					}
				}, PluginManagerPage);
				yield ctx.layout.panelInfo.subscribe(() => {
					if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") instance.actions.setView({ kind: "list" });
				});
				const disposeNavigation = ctx.reflect.provide("pluginNavigation", { openBundle: (packageName) => {
					ctx.layout.selectPanel(PANEL_ID);
					instance.actions.setTab("installed");
					instance.actions.setView({ kind: "package", name: packageName });
				} });
				yield () => {
					disposeNavigation();
				}
			});
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 0,
				label: () => t("panel"),
				locale: NS
			}, PluginsPanelIcon));
		}
```

Navigation API demonstrated there:
- `ctx.layout.selectPanel(PANEL_ID)` — selects the main panel by id (`:4466`).
- `ctx.layout.panelInfo.subscribe(cb)` / `ctx.layout.panelInfo.getSnapshot().activePanelId` — reactive selected-panel state (`:4462-4463`).
- `usePanelInfo` is also a global standard prop for components (`SRC\packages\client\ui-layout\src\client\index.ts:48-51`).

**Is `main` key + sidebar entry enough for a full page?** Yes for the page itself: the sidebar row's `id` addresses the `main` cell with the same key, and the registered component is what the central column renders. The plugin-manager does exactly this pairing and additionally declares child slots only because its page hosts other plugins' contributions. Two caveats: (a) `main` is `keyed`/`root`, so a non-reserved key receives **no Session binding** (`ui-layout\src\client\index.ts:69-72`); (b) `label` is resolved through `resolveSlotLabel`, so it must be a string or a function returning one (`PKG\dsh-client-ui-plugin-manager\lib\client.js:4314`).

---

## 8. Host HTTP / Remote for a plugin's own data API

**Core question: can a dynamically installed bundle declare `@Remote` endpoints without DSH build-time codegen?**

**UNVERIFIED — and the evidence points to no.** Not researched to conclusion inside the time box. What is verified:

- Remote surface is a generated, typed assembly: packages publish `./typert` and `./remote` subpaths (`PKG\dsh-client-ui-plugin-manager\package.json`), and the client half declares `inject: ["remote", "remote.pluginManager", "remote.pluginInventory", "remote.pluginRegistryProbe"]` (`lib/client.js:4357-4366`), i.e. each Remote service is a named, registered capability rather than an ad-hoc endpoint.
- Host↔client calls travel over a typed gateway with `rpcId` minting on the initiator and echoing on the responder (`SRC\packages\client\AGENTS.md`, "rpcId is strictly bidirectional"; `SRC\.agents\notes\implemented\architecture\2026-08-02-typert-remote-method-calls.md`).
- A dynamic bundle is loaded as a browser module from a served `lib/client.js` (`§9`); nothing in that path runs a codegen step.

Therefore the realistic options for our plugin are (a) reuse an existing generic Remote service, or (b) serve our own loopback HTTP API. Option (b) constraints I could verify: client bundles may not import arbitrary cross-package runtime values, and a dynamic `external` request must be satisfied by the module table (`SRC\packages\client\AGENTS.md`, "Shared modules"; §6), so direct `fetch` to a loopback origin is the only unconstrained channel. Token delivery, CORS allow-listing, and port selection are **UNVERIFIED** — no DSH API for them was read.

---

## 9. Installation

**`plugin_manager install_bundle`** writes a *configuration-only bundle* into the current profile and installs it; the patch inserts plugin rows, and with HMR enabled the new capability appears in the same running session. Verify `application: applied`; a saved entry reporting `restart-required` has not activated (`SRC\docs\user\develop\practice\dynamic-cordis.md:5-15`).

Bundle layout, `SRC\docs\user\develop\basic\publish.md:26-44`
```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```
```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`, `:56-62`
```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```
Rows reference the package **by name** so Node resolution finds installed code; `patch` may be an ordered list of files; a package without `dsh.bundle` installs only as a plain dependency and activates no layer (`:64`).

Loading order (`:120-131`): bundle patches in `dsh.profile.bundles` order → the profile's `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → each `--patch` overlay. Later layers win per row, and **a patch replaces a row's entire `config` rather than deep-merging keys** (`:131-134`).

**Linked directory: served directly or built?** A linked checkout keeps its own `node_modules` (`:105`), and the Web registry serves the package's **`lib/client.js`, not sources**: "Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — the registry serves `lib/client.js`, not sources" (`SRC\packages\client\AGENTS.md`, "New plugin package checklist", step 5). So a linked directory needs a **build step** producing `lib/client.js`; it is not transpiled on serve. Git installs additionally need a `prepare` script plus pnpm `allowBuilds` approval (`SRC\docs\user\develop\basic\publish.md:161-186`).

---

## Decision for our plugin

Native integration, no Remote codegen:

1. **Host half** (`apply` in our bundle's `index.js`): register our data/tool surface through verified extension points only — `ctx.tools.register(defineTool({...}))` (§5), `ctx.on('session/event', ...)` (§2), and optionally `ctx.systemPrompt.section({name, order, text})` (§4). All registrations are effects, so unload is automatic (§1).
2. **Client half** (`./client` → `lib/client.js`): register **both** slots with one shared id, exactly as the plugin-manager does (§7) — `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id: PANEL_ID, order: 0, label: () => t('panel'), locale: NS }, Icon))` and `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key: PANEL_ID, locale: NS }, Page))`. The page component renders an **iframe** pointed at our authenticated loopback Host API; no DSH Remote service is required, which sidesteps the codegen question in §8.
3. **URL/token source.** Preferred: read them from the client plugin's row `config`. That delivery path is **UNVERIFIED** (§6) — no shipped client plugin with a non-empty `Config` was found. Fallbacks, in order: (a) same-origin fixed path served by our Host half, so the iframe needs no secret; (b) a build-time constant in `lib/client.js` when the port is stable; (c) a `!!js` config expression on the **Host** row, with the client iframe using a same-origin relative URL the Host proxies. Under no fallback may the token be committed to a tracked file.
4. **Build.** Ship prebuilt `lib/client.js` (+ `lib/index.js`), `package.json` with `dsh.bundle.patch`, and the `dsh.client` block with `platform: "web"` and a `./client` export; rebuild before each install test (§9).

### Gaps to close before implementation

- `session.id` property name and the `Session → Agent` mapping (§2).
- Whether client `apply(ctx, config)` receives row config, or how else to hand the iframe URL/token to the client half (§6, §8).
- `SessionEvent` producer set for `'user/message'` synthetic injection (`agent.inject()`), and whether `agent/pre-step` message replacement is the sanctioned injection point (§3).
- Remote/`@Remote` codegen requirement: confirm or refute before designing any non-iframe data path (§8).