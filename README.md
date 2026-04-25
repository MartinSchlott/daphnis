# Daphnis

**A thin TypeScript wrapper for the Claude CLI and OpenAI Codex CLI — uniform sessions, streaming, one-shot. Nothing else.**

Daphnis wraps the official `claude` and `codex` binaries exactly as their vendors intended, and exposes a single small surface on top. Same options, same events, same session model — switch `provider: 'claude'` to `provider: 'codex'` and nothing else changes.

Most abstractions over AI coding agents grow in one of two directions: hundreds of parameters to cover every provider-specific knob, or capabilities that only half the providers actually support. Both end up leaking the distinction they tried to hide. Daphnis goes the other way. Only what both CLIs do cleanly, exposed once, uniformly. Anything provider-specific that can't be modelled without lying about behaviour stays out.

```typescript
import { createAIConversation } from '@ai-inquisitor/daphnis'

const agent = createAIConversation({
  provider: 'claude',
  cwd: process.cwd(),
  effort: 'high',
})

agent.on('message', (text) => console.log(text))
agent.on('error',   (err)  => console.error(err))

await agent.ready
await agent.sendMessage('Summarise src/index.ts in one sentence.')
```

Same code works with `provider: 'codex'`. No branches in your caller.

## What it does

**Uniform persistent sessions.** `createAIConversation` spawns the CLI and returns an `AIConversationInstance` — a typed `EventEmitter` with `'message'`, `'conversation'`, and `'error'` events. `inst.ready` is a promise that resolves when the wrapper is usable (or rejects on spawn failure). `inst.sendMessage(text)` returns a `Promise<void>` that resolves when the user turn has been durably written to the child's stdin. Resume a prior conversation with `sessionId`. Retrieve the full transcript (including history from the resumed session) via `getTranscript()`. Kill it with `destroy()`.

**Cancel a turn without losing the session.** `await instance.interrupt()` cancels the in-flight turn while keeping the session alive — it uses Claude's control-protocol `interrupt` and Codex's `turn/interrupt` JSON-RPC method natively, then waits until the wrapper has transitioned back to `'ready'` so the next `sendMessage` works immediately. There is no internal timeout: race the returned promise against your own `AbortSignal` / timer and call `destroy()` if you want a hard stop. If the turn happens to finish naturally during the cancel race, the assistant turn is still appended to the in-memory transcript (silently dropping a successful answer would erase it permanently).

**One-shot prompts, optionally schema-enforced.** `runOneShotPrompt` runs a single prompt and resolves with the final text, plus a typed `structured` field if you passed a JSON schema. Timeouts and `AbortSignal` both SIGTERM the child and still wait for stdio to drain — no truncated JSON.

**Session discovery.** `listSessions(provider, cwd)` enumerates persisted sessions for the given working directory, reading from `~/.claude/projects/…` or `~/.codex/sessions/…`. Previews and timestamps included.

**Environment hygiene.** Before spawn, daphnis strips `NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`, `VSCODE_PID`, `VSCODE_IPC_HOOK`, `ELECTRON_RUN_AS_NODE`, `CLAUDECODE` from the inherited env. Without this, a caller running inside Claude Code or VS Code leaks its host state into the child CLI and breaks auth or execution. Your own `env` option wins on collisions.

**Sandbox / permissions.** Daphnis exposes two declarative knobs and otherwise stays out of the way. `fullAccess: boolean` (default `false`) toggles the provider's full-access bypass flag — Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`. With the default, no sandbox/permission flag is appended and the CLI's own config decides. `extraArgs: string[]` is a verbatim pass-through for the long tail of provider-specific flags Daphnis does not abstract (`['--permission-mode', 'plan']` for Claude, `['--sandbox', 'read-only']` for Codex). Both apply uniformly to persistent sessions and one-shot. Note: with `fullAccess: false`, Claude in non-interactive stream-json mode will block on the first tool call that triggers a permission prompt — there is no human in the loop to answer. Either set `fullAccess: true` (e.g. for tests / CI) or supply `extraArgs: ['--permission-mode', '<mode>']`. **Scope:** `fullAccess` toggles only the CLI flag. It does *not* change Daphnis' Codex JSON-RPC auto-approval layer (auto-`accept` for command/file requests, fixed read/write/network/macOS grants for the permissions request) — that is required for the `app-server` handshake to make progress and is independent of `fullAccess`.

**Instance registry.** Every instance produced by `createAIConversation` is auto-registered under a daphnis-assigned UUID. `listInstances()` returns a fresh DTO array; `getInstance(id)` returns the live reference. Each instance exposes `getInstanceId()` and a single opaque meta slot (`setMeta(value)` / `getMeta<T>()`) so callers can hang a project name, label, or whatever on an instance without keeping a parallel map. Deregistration follows actual process death: when `destroy()` is called the entry stays in the registry with `state: 'exiting'` until the child process emits `'exit'`, at which point `instance:removed` fires with the final `exitCode`. If Node skips the `'exit'` event after a spawn `'error'` (the classic ENOENT case), the error handler self-unregisters defensively with `exitCode: null`. The registry is passive — enumeration and metadata only, no orchestration.

**Lifecycle events.** `instanceEvents` is a typed `EventEmitter<InstanceEventMap>` exposing five events: `instance:added`, `instance:removed`, `instance:ready`, `instance:meta-changed`, `instance:state-changed`. Subscribe once and react to lifecycle without polling `listInstances()` / `getSessionId()`. `InstanceInfo.state` carries the current lifecycle state (`spawning | ready | busy | exiting`), and `InstanceInfo.exitCode` carries the child's exit code (`null` until the child has actually exited). `instance:state-changed` fires on every legal transition with payload `[info, prev, next]`; the failure-ordering invariant is that `state-changed → exiting` always fires before `instance:removed`. Listeners must not throw — Node's `EventEmitter` propagates synchronous throws back to the emit site.

```typescript
import { instanceEvents, createAIConversation } from '@ai-inquisitor/daphnis'

instanceEvents.on('instance:added',         info        => console.log('added',   info.id, info.cwd, info.state))
instanceEvents.on('instance:ready',         info        => console.log('ready',   info.id, info.sessionId))
instanceEvents.on('instance:state-changed', (i, p, n)   => console.log('state',   i.id, p, '→', n))
instanceEvents.on('instance:meta-changed',  (info, p)   => console.log('meta',    info.id, p, '→', info.meta))
instanceEvents.on('instance:removed',       info        => console.log('removed', info.id, info.state, 'exitCode=', info.exitCode))

const a = createAIConversation({ provider: 'claude', cwd: process.cwd() })
// → 'added <uuid> <cwd> spawning'
// → 'state <uuid> spawning → ready'
// → 'ready <uuid> null'              (Claude: sessionId is null until first reply)
a.setMeta({ label: 'first' })
// → 'meta <uuid> undefined → { label: "first" }'
a.destroy()
// → 'state <uuid> ready → exiting'
// (entry stays in registry with state='exiting' until proc.on('exit') fires)
// → 'removed <uuid> exiting exitCode= 0'
```

Events are forward-only — no replay for late subscribers. Compose `listInstances()` with `instanceEvents.on('instance:added', …)` for full coverage of pre-existing plus new instances.

## Quick taste

```typescript
// Persistent session with effort + model
const agent = createAIConversation({
  provider: 'codex',
  cwd: '/path/to/project',
  effort: 'max',
  model: 'gpt-5.4',
  env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
})
agent.on('message', console.log)
await agent.ready
await agent.sendMessage('Hi.')

// One-shot with JSON schema
import { runOneShotPrompt } from '@ai-inquisitor/daphnis'

const result = await runOneShotPrompt<{ summary: string; risks: string[] }>({
  provider: 'claude',
  cwd: process.cwd(),
  prompt: 'Analyse the repo. Return summary and risks.',
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      risks:   { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'risks'],
  },
  timeoutMs: 60_000,
})
console.log(result.structured?.summary)

// List prior sessions, then resume one
import { listSessions } from '@ai-inquisitor/daphnis'

const sessions = await listSessions('claude', process.cwd())
const resumed  = createAIConversation({
  provider:  'claude',
  cwd:       process.cwd(),
  sessionId: sessions[0].sessionId,
})
resumed.on('message', console.log)
await resumed.ready
const transcript = await resumed.getTranscript() // includes prior turns

// Multi-session bookkeeping via the registry — no hand-rolled Map
import { listInstances, getInstance } from '@ai-inquisitor/daphnis'

for (const project of ['api', 'web', 'infra']) {
  const agent = createAIConversation({ provider: 'claude', cwd: `/repos/${project}` })
  agent.setMeta({ project, label: `reviewer:${project}` })
}

for (const info of listInstances()) {
  const { project, label } = info.meta as { project: string; label: string }
  console.log(`${info.id} cwd=${info.cwd} session=${info.sessionId ?? '(pending)'} project=${project} label=${label}`)
}

// Look a specific one back up and drive it
const target = listInstances().find(i => (i.meta as { project: string }).project === 'api')!
const inst = getInstance(target.id)!
await inst.ready
await inst.sendMessage('Open PR against main.')
```

## As a library

```typescript
import { createAIConversation, type ConversationTurn } from '@ai-inquisitor/daphnis'

const turns: ConversationTurn[] = []

const agent = createAIConversation({
  provider: 'claude',
  cwd: process.cwd(),
  systemPrompt: 'You are a code reviewer. Be concise.',
  effort: 'high',
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    // Or: CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
  },
})

agent.on('conversation', (turn) => turns.push(turn))
agent.on('message',      (text) => {
  console.log('assistant:', text)
  agent.destroy()
})
agent.on('error',        (err) => {
  console.error('error:', err.message)
  agent.destroy()
})

try {
  await agent.ready
  await agent.sendMessage('Review the diff on this branch.')
} catch (err) {
  console.error('ready/send failed:', err)
}
```

---

*Every time I wanted to add "just one more flag", the answer was no. What's left is what both CLIs actually share — nothing more, nothing less.* — Claude Opus 4.7

*Make it simple — only what we actually need.* — AI-Inquisitor

---

## LLM Reference

Daphnis: thin TypeScript wrapper around the official Claude CLI and OpenAI Codex CLI. Two execution modes (persistent conversation, one-shot), five public functions (`createAIConversation`, `runOneShotPrompt`, `listSessions`, `listInstances`, `getInstance`) plus one public `EventEmitter` (`instanceEvents`), one uniform provider switch (`'claude' | 'codex'`). Uses the CLIs exactly as their vendors intended — this is what makes it TOS-conform: it's a wrapper, not a proxy or re-implementation.

**Architecture — why two modes:** Persistent and one-shot have different process models. Persistent = long-lived child with open stdio where messages flow both ways; Codex adds a JSON-RPC handshake and Claude adds NDJSON stream-json framing. One-shot = spawn with `stdin: 'ignore'`, collect stdout, parse, exit. The modes share the env filter, effort mapping, and NDJSON parser — nothing else.

**Lifecycle surface (4.0.0):** Each `AIConversationInstance` is itself a typed `EventEmitter<InstanceMessageEventMap>` with three events: `message: (text)`, `conversation: (turn)`, `error: (err)`. `inst.ready: Promise<void>` resolves when the wrapper transitions `spawning → ready`, rejects with the spawn / handshake error otherwise — Daphnis attaches an internal `.catch(() => {})` so an unawaited `ready` does not surface as an unhandled rejection. `inst.state: InstanceState` is a getter that reads the registry. `sendMessage(text): Promise<void>` is uniformly async on both providers; rejections are `'Destroyed'` / `'Already processing'` / `'Not ready'` (in that guard order) plus any underlying stdin / JSON-RPC error. `destroy()` is synchronous and idempotent: it transitions the registry entry to `state: 'exiting'` and schedules a SIGKILL after 3 s, but does **not** unregister synchronously — `instance:removed` fires when the child actually exits, carrying the real `exitCode`. The exception is the spawn-failure path: `proc.on('error')` (and `stdin.on('error')`, and Codex's `initialize()` catch) self-unregister directly because Node does not guarantee an `'exit'` event after `'error'`; the `instance:removed` snapshot in that case carries `exitCode: null`. Emitting `'error'` while no listener is attached is a silent no-op (Daphnis swallows via a listener-count guard); spawn-phase failures surface via `inst.ready` rejection only, never via the `'error'` event.

**Async-ready ordering (Claude):** Claude's `claude --print` accepts stdin instantly, so the constructor schedules the `spawning → ready` transition via `setImmediate(...)` rather than firing it synchronously. `setImmediate` runs in the check phase of the event loop, **after** the `process.nextTick` queue and the microtask queue have drained — so any `nextTick`-emitted spawn `'error'` (ENOENT and friends) deterministically wins the race and rejects `inst.ready` before the deferred ready transition can fire. The deferred callback re-checks `getState(id) === 'spawning'` and self-cancels if the error path already moved state to `'exiting'`. `queueMicrotask` would not be sufficient: caller contexts that sit between `createAIConversation()` returning and the listener attachment (top-level await, `await Promise.resolve()`, etc.) drain microtasks early and do not give the same ordering guarantee against `nextTick`.

**Claude persistent flow:** `claude --print --input-format stream-json --output-format stream-json --verbose [--dangerously-skip-permissions if fullAccess] [--resume <id>] [--system-prompt ...] [--effort ...] [--model ...] [...extraArgs]`. The `system/init` event only arrives after the first user message is written to stdin; `getSessionId()` returns `null` until then (or the resumed id, if passed). User messages are written as JSON lines: `{type:'user', message:{role:'user', content:text}, session_id, parent_tool_use_id:null}`. Assistant replies surface as `type:'result'` envelopes with the final text. `interrupt()` writes `{type:'control_request', request_id:<uuid>, request:{subtype:'interrupt'}}` on the same stdin pipe and waits for a matching `{type:'control_response', response:{subtype:'success', request_id:<uuid>}}` plus the in-flight turn's terminator (`type:'result'` with `is_error:true` and `subtype:'error_during_execution'`); the session id stays valid afterwards.

**Codex persistent flow:** `codex [global flags] app-server`, where `[global flags] = [--dangerously-bypass-approvals-and-sandbox if fullAccess] [-c model_reasoning_effort=...] [-m <model>] [...extraArgs]`. JSON-RPC 2.0 over stdio. Handshake: `initialize` (hardcoded `clientInfo: {name:'daphnis', title:'Daphnis', version:'1.0.0'}` + `capabilities.experimentalApi:true`) → `thread/start` or `thread/resume` → ready resolves with captured `threadId`. Turns: `turn/start` returns `{turn:{id:<turnId>, ...}}` — the `turnId` is captured for `interrupt()` and cleared on every terminal turn event; `item/agentMessage/delta` notifications buffer partial text; `turn/completed` commits the buffered text as an assistant turn when `turn.status === 'completed'`. `interrupt()` issues `turn/interrupt({threadId, turnId})` and waits for both the JSON-RPC ack (`{}`) and the matching `turn/completed` notification (`turn.status === 'interrupted'`); the thread stays alive. Server-initiated requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) auto-grant. `item/permissions/requestApproval` auto-grants `fileSystem.read/write` scoped to exactly the session cwd, `network.enabled:true`, macOS sub-permissions. `item/tool/call` returns a fail-closed "not supported" response. Unknown server requests return JSON-RPC `-32601`.

**One-shot flow:** Claude — `claude -p <prompt> --output-format json [--dangerously-skip-permissions if fullAccess] [--system-prompt ...] [--effort ...] [--model ...] [--json-schema ...] [...extraArgs]`, stdio `['ignore','pipe','pipe']`, stdout is a single JSON envelope (`{result, session_id, structured_output?, is_error?}`). Codex — `codex [global flags] exec --output-last-message <tmpfile> [--output-schema <tmpfile>] <prompt>`, where global flags carry `[--dangerously-bypass-approvals-and-sandbox if fullAccess]`, effort/model, and `[...extraArgs]`. Assistant text read from tmpfile after close; system prompt prepended to user prompt (Codex has no dedicated system-prompt flag for `exec`). Both resolve on `'close'`, not `'exit'`. Timeout and `AbortSignal` both `SIGTERM` then wait for `close`.

**Effort mapping:** `'default' | 'min' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. `'default'` returns `null` → flag omitted, CLI decides. `'min'` / `'max'` are silent aliases to the nearest supported gear: Claude `min → low`; Codex `min → minimal`, `max → xhigh`. `model` is passed through unchanged.

**ENV_BLACKLIST at spawn:** `NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`, `VSCODE_PID`, `VSCODE_IPC_HOOK`, `ELECTRON_RUN_AS_NODE`, `CLAUDECODE`. Stripped from `process.env` before merging caller-supplied `options.env`. Caller env wins on key collisions.

**Instance registry:** Module-level `Map<id, RegistryEntry>` in `registry.ts`. `createAIConversation` generates a `crypto.randomUUID()` and hands it to the wrapper constructor; the wrapper self-registers *after* `spawn(...)` succeeds and all `proc.on(...)` listeners are wired. `unregister` is invariant-tightened: it throws if the entry's state is not `'exiting'` at call time. Deregistration paths: `proc.on('exit')` (sets `exitCode` first, then unregisters), `proc.on('error')` and `stdin.on('error')` (self-unregister with `exitCode: null` because Node does not guarantee `'exit'` after `'error'`), Codex's `initialize()` catch (defensive self-unregister so handshake failure cleans up without waiting for the scheduled SIGKILL). `destroy()` does NOT unregister synchronously — the entry stays visible with `state: 'exiting'` between the `destroy()` call and the actual proc exit. `listInstances()` returns a fresh `InstanceInfo[]` each call, built from the live wrapper's `getSessionId` / `getPid` / `getInstanceId` plus the stored `provider` / `cwd` / `createdAt` / `meta` / `state` / `exitCode`. `getInstance(id)` returns the live reference. Meta is a single opaque slot.

**Public API surface — `src/index.ts` re-exports exactly:** `createAIConversation`, `AIConversationInstance`, `AIConversationOptions`, `ConversationTurn`, `Effort`, `InstanceMessageEventMap`, `runOneShotPrompt`, `OneShotOptions`, `OneShotResult`, `listSessions`, `SessionInfo`, `listInstances`, `getInstance`, `instanceEvents`, `InstanceInfo`, `InstanceEventMap`, `InstanceState`. Nothing else.

**Runtime dependencies:** zero. `@types/node`, `typescript`, `vitest` are devDependencies only. Node ≥ 22, ESM, `moduleResolution: "Node16"`. The Node 22 floor exists so the typed generic `EventEmitter<…>` from `@types/node@^22` resolves without subclassing or casts.

**Invariants — things that will bite you if you assume otherwise:**
Credentials are never read, prompted, or stored by daphnis. The caller passes `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY` (or whatever) via `options.env`.
State is reset to `'ready'` before message events fire. Both wrappers transition `busy → ready` *before* emitting `'conversation'` / `'message'`. Listeners may synchronously call `sendMessage` (marker-retry patterns, auto-dispatch); transitioning after would fail with "Already processing".
Ready semantics differ between providers but the public contract is identical: `await inst.ready` either resolves (wrapper is usable) or rejects (spawn / handshake failed). Claude's `setImmediate`-deferred ready transition is a microtask-class delay; Codex's ready awaits the full `initialize` + `thread/start`/`thread/resume` JSON-RPC handshake. Code that reads `getSessionId()` immediately after `await inst.ready` must tolerate `null` for Claude (the `system/init` event arrives later, after the first user message).
`destroy()` is non-blocking and the registry entry persists with `state: 'exiting'` until the child process actually exits. A consumer that calls `destroy()` and immediately calls `listInstances()` will still see the entry. Once the proc emits `'exit'`, `instance:removed` fires with the real `exitCode`. If Node skips `'exit'` after a spawn `'error'` (ENOENT case), the error handler self-unregisters defensively and `instance:removed` carries `exitCode: null`.
One-shot cancellation has no `SIGKILL` fallback. Timeout and `AbortSignal` both send `SIGTERM` and wait for `'close'`. A child that ignores `SIGTERM` will hang until it voluntarily exits.
`ConversationTurn` surfaces final messages only. Intermediate tool-use events, reasoning traces, and streaming deltas are *not* exposed.
`listSessions('codex', cwd)` is linear in total Codex session count, not per-cwd.
Cwd cannot change mid-session. The CLI pins it at spawn.
No retry, no rate-limit handling, no backoff.
Codex permission scope is the session cwd, exactly. `fileSystem.read`/`write` arrays contain only the cwd string.
Persistent sessions survive process death only through the on-disk `.jsonl` file. If you kill the daphnis process and start a new one, pass the `sessionId` to the new `createAIConversation` to pick up where you left off.
`unregister(id)` throws if the entry's state is not `'exiting'` at call time. This is a wrapper-bug surfacer — every code path that ends an instance must transition to `exiting` first.
`'error'` events fired without an attached listener are silently swallowed. The default Node `EventEmitter` would throw on unhandled `'error'`; Daphnis applies a listener-count guard so a wrapper without `inst.on('error', …)` does not crash the process. Spawn-phase failures (during `state === 'spawning'`) never emit `'error'` regardless of listeners — they surface via `inst.ready` rejection.
Late turn terminators after teardown are dropped silently. If `destroy()` runs while a turn is in flight, or the child crashes, or an error handler self-unregisters, a result message that was already buffered on stdout will arrive after the wrapper has transitioned away from `busy`. Both wrappers guard the `result` / `turn/completed` branch with a `state === 'busy'` check at the top — late terminators do not throw an illegal `exiting → ready` transition, do not emit `'conversation'` / `'message'` on a torn-down wrapper, and do not append a phantom assistant turn to the transcript.
Error-path teardown always kills the child. Both Claude error handlers (`stdin.on('error')`, `proc.on('error')`) call `destroy()` after rejecting `ready` (spawning branch) or emitting `'error'` (post-ready). `destroy()` schedules `stdin.end()` + a 3 s SIGKILL timer regardless of whether the wrapper was still in `'spawning'` — no orphan child when the spawn fails before any I/O. Codex follows the same pattern.
`interrupt()` has no internal timeout and three race outcomes. The promise resolves only after both the provider's cancel ack *and* the in-flight turn's terminator have arrived. Pending interrupt promises are also rejected on `proc.on('exit')`, `proc.on('error')`, `stdin.on('error')`, and `destroy()`.
Lifecycle events fire synchronously, but on different code paths. `instance:added` and `instance:removed` fire inside `register` / `unregister`. For `instance:removed`, the entry is deleted from the map *before* the event is emitted; `info.state` is always `'exiting'` and `info.exitCode` is the captured exit code (or `null` if the error path got there first). `instance:ready` is folded into `registry.transitionState(id, 'ready')` and fires only on the `spawning → ready` transition. Subsequent `busy → ready` transitions emit `instance:state-changed` but **not** `instance:ready`. `instance:state-changed` fires from `registry.transitionState` on every legal transition. Same-state self-transitions are no-ops, illegal transitions throw, unknown ids are silent no-ops. `instance:meta-changed` fires synchronously inside `setMetaFor` whenever the meta slot is updated for a known id. Events are forward-only: late subscribers do not receive replayed history. Listeners must not throw — Node's `EventEmitter` propagates synchronous throws back to the emit site. Spawn-failure semantics — the wrapper registers before any async failure can fire, so an ENOENT or Codex handshake failure produces `instance:added` → `instance:state-changed (spawning → exiting)` → `instance:removed` with no `instance:ready` in between. The standard `EventEmitter` listener-leak warning fires past 10 listeners; raise the cap with `instanceEvents.setMaxListeners(n)` if needed.
