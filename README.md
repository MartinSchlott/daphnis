# Daphnis

**A thin TypeScript wrapper for the Claude CLI and OpenAI Codex CLI — uniform sessions, streaming, one-shot. Nothing else.**

Daphnis wraps the official `claude` and `codex` binaries exactly as their vendors intended, and exposes a single small surface on top. Same options, same callbacks, same session model — switch `provider: 'claude'` to `provider: 'codex'` and nothing else changes.

Most abstractions over AI coding agents grow in one of two directions: hundreds of parameters to cover every provider-specific knob, or capabilities that only half the providers actually support. Both end up leaking the distinction they tried to hide. Daphnis goes the other way. Only what both CLIs do cleanly, exposed once, uniformly. Anything provider-specific that can't be modelled without lying about behaviour stays out.

```typescript
import { createAIConversation } from '@ai-inquisitor/daphnis'

const agent = createAIConversation({
  provider: 'claude',
  cwd: process.cwd(),
  effort: 'high',
  handlers: {
    onReady: () => agent.sendMessage('Summarise src/index.ts in one sentence.'),
    onMessage: (text) => console.log(text),
    onExit: () => process.exit(0),
  },
})
```

Same code works with `provider: 'codex'`. No branches in your caller.

## What it does

**Uniform persistent sessions.** `createAIConversation` spawns the CLI and streams replies through `onMessage` / `onConversation` callbacks. Resume a prior conversation with `sessionId`. Retrieve the full transcript (including history from the resumed session) via `getTranscript()`. Kill it with `destroy()`.

**One-shot prompts, optionally schema-enforced.** `runOneShotPrompt` runs a single prompt and resolves with the final text, plus a typed `structured` field if you passed a JSON schema. Timeouts and `AbortSignal` both SIGTERM the child and still wait for stdio to drain — no truncated JSON.

**Session discovery.** `listSessions(provider, cwd)` enumerates persisted sessions for the given working directory, reading from `~/.claude/projects/…` or `~/.codex/sessions/…`. Previews and timestamps included.

**Environment hygiene.** Before spawn, daphnis strips `NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`, `VSCODE_PID`, `VSCODE_IPC_HOOK`, `ELECTRON_RUN_AS_NODE`, `CLAUDECODE` from the inherited env. Without this, a caller running inside Claude Code or VS Code leaks its host state into the child CLI and breaks auth or execution. Your own `env` option wins on collisions.

**Instance registry.** Every instance produced by `createAIConversation` is auto-registered under a daphnis-assigned UUID. `listInstances()` returns a fresh DTO array; `getInstance(id)` returns the live reference. Each instance exposes `getInstanceId()` and a single opaque meta slot (`setMeta(value)` / `getMeta<T>()`) so callers can hang a project name, label, or whatever on an instance without keeping a parallel map. Deregistration is automatic: synchronous on `destroy()`, and before `onExit` fires on a child exit. The registry is passive — enumeration and metadata only, no orchestration.

**Lifecycle events.** `instanceEvents` is a typed `EventEmitter<InstanceEventMap>` exposing `instance:added` and `instance:removed`. Subscribe once and react to lifecycle without polling `listInstances()`.

```typescript
import { instanceEvents, createAIConversation } from '@ai-inquisitor/daphnis'

instanceEvents.on('instance:added',   info => console.log('added',   info.id, info.cwd))
instanceEvents.on('instance:removed', info => console.log('removed', info.id))

const a = createAIConversation({ provider: 'claude', cwd: process.cwd() })
// → 'added <uuid> <cwd>'
a.destroy()
// → 'removed <uuid>'
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
  handlers: { onMessage: console.log },
})

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
  handlers:  { onMessage: console.log },
})
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
getInstance(target.id)!.sendMessage('Open PR against main.')
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
  handlers: {
    onReady: () => {
      agent.sendMessage('Review the diff on this branch.')
    },
    onConversation: (turn) => {
      turns.push(turn)
    },
    onMessage: (text) => {
      console.log('assistant:', text)
      agent.destroy()
    },
    onError: (err) => {
      console.error('error:', err.message)
      agent.destroy()
    },
    onExit: (code) => {
      console.log(`exited with ${code}, ${turns.length} turns, session=${agent.getSessionId()}`)
    },
  },
})
```

---

*Every time I wanted to add "just one more flag", the answer was no. What's left is what both CLIs actually share — nothing more, nothing less.* — Claude Opus 4.7

*Make it simple — only what we actually need.* — AI-Inquisitor

---

## LLM Reference

Daphnis: thin TypeScript wrapper around the official Claude CLI and OpenAI Codex CLI. Two execution modes (persistent conversation, one-shot), five public functions (`createAIConversation`, `runOneShotPrompt`, `listSessions`, `listInstances`, `getInstance`) plus one public `EventEmitter` (`instanceEvents`), one uniform provider switch (`'claude' | 'codex'`). Uses the CLIs exactly as their vendors intended — this is what makes it TOS-conform: it's a wrapper, not a proxy or re-implementation.

**Architecture — why two modes:** Persistent and one-shot have different process models. Persistent = long-lived child with open stdio where messages flow both ways; Codex adds a JSON-RPC handshake and Claude adds NDJSON stream-json framing. One-shot = spawn with `stdin: 'ignore'`, collect stdout, parse, exit. The modes share the env filter, effort mapping, and NDJSON parser — nothing else. They do not try to present a common "session" that isn't really there.

**Claude persistent flow:** `claude --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions [--resume <id>] [--system-prompt ...] [--effort ...] [--model ...]`. Ready fires immediately after spawn — the `system/init` event only arrives after the first user message is written to stdin, so we can't wait for it. `session_id` is captured asynchronously when init finally arrives; until then `getSessionId()` returns `null` (or the resumed id, if passed). User messages are written as JSON lines: `{type:'user', message:{role:'user', content:text}, session_id, parent_tool_use_id:null}`. Assistant replies surface as `type:'result'` envelopes with the final text.

**Codex persistent flow:** `codex [global flags] app-server`. JSON-RPC 2.0 over stdio. Handshake: `initialize` (clientInfo + capabilities.experimentalApi:true) → `thread/start` or `thread/resume` → ready fires with captured `threadId`. Turns: `turn/start` returns a request; `item/agentMessage/delta` notifications buffer partial text; `turn/completed` commits the buffered text as an assistant turn. Server-initiated requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) auto-grant. `item/permissions/requestApproval` auto-grants `fileSystem.read/write` scoped to exactly the session cwd, `network.enabled:true`, macOS sub-permissions. `item/tool/call` returns a fail-closed "not supported" response. Unknown server requests return JSON-RPC `-32601`.

**One-shot flow:** Claude — `claude -p <prompt> --output-format json --dangerously-skip-permissions [--system-prompt ...] [--effort ...] [--model ...] [--json-schema ...]`, stdio `['ignore','pipe','pipe']`, stdout is a single JSON envelope (`{result, session_id, structured_output?, is_error?}`). Codex — `codex [global flags] exec --output-last-message <tmpfile> [--output-schema <tmpfile>] <prompt>`, assistant text read from tmpfile after close, system prompt prepended to user prompt (Codex has no dedicated system-prompt flag for `exec`). Both resolve on `'close'`, not `'exit'` — `exit` can fire while stdout still has buffered data; resolving there produces intermittent truncated envelopes that fail `JSON.parse`. Timeout and `AbortSignal` both `SIGTERM` then wait for `close`.

**Effort mapping:** `'default' | 'min' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. `'default'` returns `null` → flag omitted, CLI decides. `'min'` / `'max'` are silent aliases to the nearest supported gear: Claude `min → low`; Codex `min → minimal`, `max → xhigh`. `model` is passed through unchanged — no validation of the string against any known list. No way to pass raw provider-native levels; if the mapping is wrong for you, fork.

**ENV_BLACKLIST at spawn:** `NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`, `VSCODE_PID`, `VSCODE_IPC_HOOK`, `ELECTRON_RUN_AS_NODE`, `CLAUDECODE`. Stripped from `process.env` before merging caller-supplied `options.env`. Caller env wins on key collisions. Why: a daphnis caller running inside Claude Code or a VS Code JS debugger leaks its host state into the child CLI; the child then either picks up the wrong auth (Claude sees `CLAUDECODE` and thinks it's embedded) or crashes on inherited inspector flags.

**Instance registry:** Module-level `Map<id, RegistryEntry>` in `registry.ts`. `createAIConversation` generates a `crypto.randomUUID()` and hands it to the wrapper constructor; the wrapper self-registers *after* `spawn(...)` succeeds and all `proc.on(...)` listeners are wired, but *before* the first user callback can fire (Claude's synchronous `onReady`, Codex's async `initialize()`). Placing it after spawn means a synchronously throwing spawn cannot leak an entry. Deregistration fires from three paths, all idempotent because `Map.delete` is: `destroy()` (synchronous — the entry is gone the instant `destroy()` returns; Codex `initialize()` calls `this.destroy()` in its catch block, so a failed handshake cleans up too), `proc.on('exit')` (before `onExit(code)` runs — callers inspecting `listInstances()` from inside `onExit` see the instance already gone), and `proc.on('error')` via `this.destroy()` (ENOENT guard — Node does not guarantee an `exit` event when `spawn` emits `error`, so without this path a missing binary would leave a dead entry). `listInstances()` returns a fresh `InstanceInfo[]` each call, built from the live wrapper's `getSessionId` / `getPid` / `getInstanceId` plus the stored `provider` / `cwd` / `createdAt` / `meta`. `getInstance(id)` returns the live reference. Meta is a single opaque slot (`setMeta(value: unknown)` overwrites, `getMeta<T>()` is an unchecked cast). No key-value API, no schema — callers who want multiple fields pass an object. The registry is passive: enumeration and metadata only, no role management, no dispatch, no "send to the idle one". That stays on the caller's side of the orchestration boundary.

**Session storage:** Claude writes `~/.claude/projects/<cwd-slash-to-dash>/<session-uuid>.jsonl` — the cwd is encoded by replacing `/` and whitespace with `-`. Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` with the cwd embedded in a `session_meta` payload. `listSessions` reads those paths directly. Consequence: sessions are bound to `(host user, cwd)` and are not portable between machines or users. Moving `.claude/projects` between hosts will not preserve session continuity — that's a consequence of using the CLIs as intended, not a daphnis limitation.

**Public API surface — `src/index.ts` re-exports exactly:** `createAIConversation`, `AIConversationInstance`, `AIConversationOptions`, `AIConversationHandlers`, `ConversationTurn`, `Effort`, `runOneShotPrompt`, `OneShotOptions`, `OneShotResult`, `listSessions`, `SessionInfo`, `listInstances`, `getInstance`, `instanceEvents`, `InstanceInfo`, `InstanceEventMap`. Nothing else. Internal helpers (`NdjsonParser`, effort mapping, `loadSessionHistory`, internal registry `register` / `unregister` / `setMetaFor` / `getMetaFor`) are implementation detail and not exposed.

**Runtime dependencies:** zero. `@types/node`, `typescript`, `vitest` are devDependencies only. Node ≥ 22, ESM, `moduleResolution: "Node16"`. The Node 22 floor exists so the typed generic `EventEmitter<InstanceEventMap>` from `@types/node@^22` resolves without subclassing or casts.

**Invariants — things that will bite you if you assume otherwise:**
Credentials are never read, prompted, or stored by daphnis. The caller passes `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY` (or whatever) via `options.env`. If you forget this, the child CLI falls back to whatever the host user is logged into — usually not what you want in a programmatic context.
`busy` is reset before the callback fires. Both wrappers set `busy = false` *before* invoking `onConversation` / `onMessage`. Callbacks may synchronously call `sendMessage` (marker-retry patterns, auto-dispatch); resetting after would fail with "Already processing". If you rely on the order the other way, you'll race yourself.
Ready semantics differ between providers. Claude fires `onReady` immediately after spawn — the CLI accepts stdin instantly, but `getSessionId()` returns `null` until the first reply arrives. Codex fires `onReady` only after the initialize+thread handshake completes, at which point `getSessionId()` already returns the `threadId`. Code that reads `getSessionId()` in `onReady` must tolerate `null` for Claude.
One-shot cancellation has no `SIGKILL` fallback. Timeout and `AbortSignal` both send `SIGTERM` and wait for `'close'`. A child that ignores `SIGTERM` will hang until it voluntarily exits. If you need hard-kill semantics, wrap with an outer timeout that calls `proc.kill('SIGKILL')` yourself — not supported in v1.
`ConversationTurn` surfaces final messages only. Intermediate tool-use events, reasoning traces, and streaming deltas are *not* exposed. For Codex, deltas are internally buffered and committed on `turn/completed`; for Claude, intermediate `assistant` events are deliberately ignored. If you need token-level streaming, daphnis is the wrong layer.
`listSessions('codex', cwd)` is linear in total Codex session count, not per-cwd. The function walks the entire `~/.codex/sessions` tree and reads the first few lines of each file to filter by cwd. Expect O(N) file opens for N lifetime sessions. Claude's layout (per-cwd directory) is direct — one `readdir` plus per-file reads.
Cwd cannot change mid-session. The CLI pins it at spawn. To switch, `destroy()` and create a new instance.
No retry, no rate-limit handling, no backoff. If the CLI exits non-zero or errors mid-stream, you get the error and whatever was written. Retry is the caller's concern.
Codex permission scope is the session cwd, exactly. `fileSystem.read`/`write` arrays contain only the cwd string. If the CLI tries to touch files outside cwd, the request will be denied. Pass a broader cwd at spawn, or fork the permission handler.
Persistent sessions survive process death only through the on-disk `.jsonl` file. If you kill the daphnis process and start a new one, pass the `sessionId` to the new `createAIConversation` to pick up where you left off. There is no in-memory handover — the CLI re-reads its own transcript from disk on `--resume` / `thread/resume`.
Registry deregistration runs *before* `onExit` fires, and `listInstances()` DTOs carry whatever `getSessionId()` returns *at call time* — which is `null` on Claude until the first reply arrives. A caller iterating `listInstances()` for Claude entries right after construction must tolerate `sessionId: null`, same as reading `getSessionId()` directly.
Lifecycle events fire synchronously inside `register` / `unregister`. `instance:added` fires before `createAIConversation()` returns. For `instance:removed`, the entry is deleted from the map *before* the event is emitted — a subscriber that calls `listInstances()` from inside the handler sees the instance already gone, but the event payload carries the final `InstanceInfo` snapshot (id, sessionId, pid, meta) captured before the delete. Events are forward-only: late subscribers do not receive replayed history. Spawn-failure semantics — the wrapper registers before any async failure can fire, so an ENOENT or Codex handshake failure produces `instance:added` followed shortly by `instance:removed`. The standard `EventEmitter` listener-leak warning fires past 10 listeners; raise the cap with `instanceEvents.setMaxListeners(n)` if you actually need that many.
