# Daphnis — Architecture

## Tech stack

- **Language**: TypeScript, `strict: true`, target ES2022.
- **Module system**: ESM (`"type": "module"`, `moduleResolution: "Node16"`).
- **Runtime**: Node.js ≥ 22 (uses `node:child_process`, `node:fs/promises`,
  `node:os`, `node:crypto`, `node:events` — no native deps). The typed
  generic `EventEmitter<T>` from `@types/node@^22` is used by the
  instance registry.
- **Build**: `tsc` → `dist/`, declaration + declaration maps + source maps.
- **Tests**: `vitest`, mocked `node:child_process` + `node:fs/promises`.
- **No runtime dependencies.** The only deps are `@types/node`,
  `typescript`, `vitest`.

## Repository layout

```
daphnis/
├── src/
│   ├── index.ts              # public API surface (exports only)
│   ├── types.ts              # AIConversationInstance (EventEmitter), Options, Effort
│   ├── factory.ts            # createAIConversation → provider switch
│   ├── claude-cli-wrapper.ts # persistent Claude session (stream-json)
│   ├── codex-cli-wrapper.ts  # persistent Codex session (JSON-RPC app-server)
│   ├── one-shot.ts           # runOneShotPrompt for both providers
│   ├── sessions.ts           # listSessions + loadSessionHistory
│   ├── registry.ts           # listInstances, getInstance, meta slot
│   ├── effort-mapping.ts     # Effort → provider flag
│   ├── ndjson-parser.ts      # line-buffered NDJSON
│   └── __tests__/            # vitest, excluded from build
├── docs/                     # definition, architecture, limitations, plans
├── dist/                     # tsc output (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

Flat layout, single package. No monorepo, no workspaces.

## Public API

`src/index.ts` re-exports exactly:

- `createAIConversation` + `AIConversationInstance`, `AIConversationOptions`,
  `ConversationTurn`, `Effort`, `InstanceMessageEventMap`
- `runOneShotPrompt` + `OneShotOptions`, `OneShotResult`
- `listSessions` + `SessionInfo`
- `listInstances`, `getInstance`, `instanceEvents` + `InstanceInfo`,
  `InstanceEventMap`, `InstanceState`

Nothing else is exported. Internal helpers (NDJSON parser, effort mapping)
are implementation detail.

## Data flow

### Persistent conversation (Claude)

```
spawn claude --print --input-format stream-json
             --output-format stream-json --verbose
             [--dangerously-skip-permissions if fullAccess]
             [--resume <id>] [--system-prompt ...]
             [--effort ...] [--model ...] [...extraArgs]
  ↓ stdin: JSON line per user message
                   {"type":"control_request",...subtype:"interrupt"} for cancel
  ↑ stdout: NDJSON stream
      type=system/init       → capture session_id
      type=result            → emit assistant turn, reset busy BEFORE event
      type=control_response  → resolve/reject the matching interrupt() ack
```

Claude's `--print` accepts stdin instantly, so the `spawning → ready`
transition is scheduled via `setImmediate(...)` rather than fired
synchronously. `setImmediate` runs in the check phase of the event loop,
**after** the `process.nextTick` queue and the microtask queue have
drained — so any `nextTick`-emitted spawn `'error'` (ENOENT and friends)
deterministically wins the race and rejects `inst.ready` before the
deferred ready transition can fire. The deferred callback re-checks
`getState(id) === 'spawning'` and self-cancels if the error path already
moved state to `'exiting'`. `queueMicrotask` would not be sufficient:
caller contexts that sit between `createAIConversation()` returning and
the listener attachment (top-level await, `await Promise.resolve()`,
etc.) drain microtasks early and do not give the same ordering guarantee
against `nextTick`. The `system/init` event only arrives after the first
user message, so `getSessionId()` returns `null` (or the resumed id, if
passed) until then.

### Persistent conversation (Codex)

```
spawn codex [global flags] app-server

  global flags = [--dangerously-bypass-approvals-and-sandbox if fullAccess]
                 [-c model_reasoning_effort=...] [-m <model>]
                 [...extraArgs]

  ↓↑ JSON-RPC 2.0 over stdio
      initialize → thread/start or thread/resume → ready
      turn/start (capture turn.id) → item/agentMessage/delta (buffer)
        → turn/completed (status: completed | interrupted | failed)
      turn/interrupt(threadId, turnId) — sent by interrupt() to cancel
      Server-initiated requests (approval, tool/call) auto-responded
```

Codex requires an initialisation handshake. `inst.ready` resolves only
after `thread/start` / `thread/resume` returns a thread id; on handshake
failure it rejects with the JSON-RPC error and the wrapper transitions
straight `spawning → exiting`.

### One-shot (Claude)

```
spawn claude -p <prompt> --output-format json
             [--dangerously-skip-permissions if fullAccess]
             [--system-prompt ...] [--effort ...] [--model ...]
             [--json-schema ...] [...extraArgs]
  stdio: ['ignore', 'pipe', 'pipe']
  resolve on 'close' (not 'exit') → stdout is a single JSON envelope
```

### One-shot (Codex)

```
spawn codex [global flags] exec --output-last-message <tmpfile>
            [--output-schema <tmpfile>] <prompt>

  global flags = [--dangerously-bypass-approvals-and-sandbox if fullAccess]
                 [-c model_reasoning_effort=...] [-m <model>]
                 [...extraArgs]

  assistant text is read from the tmpfile after 'close'
  tmp directory cleaned up in finally
```

## Design decisions

### Env blacklist at spawn

```
NODE_OPTIONS, VSCODE_INSPECTOR_OPTIONS, VSCODE_PID, VSCODE_IPC_HOOK,
ELECTRON_RUN_AS_NODE, CLAUDECODE
```

These are stripped from `process.env` before merging caller-supplied env.
Without this, a Daphnis-caller running *inside* Claude Code or VS Code
leaks its host state into the child CLI and breaks auth or execution.
Caller-supplied env wins on key collisions.

### cwd + home coupling is honoured, not hidden

- Claude persists sessions under
  `~/.claude/projects/<cwd-slash-to-dash>/<session>.jsonl`.
- Codex persists under `~/.codex/sessions/**/rollout-<ts>-<uuid>.jsonl`,
  filterable by the `cwd` recorded in `session_meta`.

`listSessions` and `loadSessionHistory` read from exactly those
locations. Sessions are therefore bound to `(host user, cwd)`. This is
the TOS-conform contract with the vendors' CLIs; Daphnis does not try to
work around it.

### NDJSON parser

Line-buffered. Incomplete trailing line is retained across `feed()`
calls. Parse errors propagate as fatal — a malformed line means the
stream is corrupt.

### State reset to `'ready'` before message events fire

Both wrappers transition `busy → ready` (via the registry's
`transitionState`) *before* emitting `'conversation'` / `'message'`.
Listeners may synchronously call `sendMessage` (e.g. marker retry
patterns, auto-dispatch); transitioning after would fail with
"Already processing".

### One-shot resolves on `close`, not `exit`

`exit` can fire while stdout still has buffered data; resolving there
produces intermittent truncated envelopes that fail `JSON.parse`.
`close` guarantees all stdio streams are drained. Timeout and
`AbortSignal` both send `SIGTERM` and still wait for `close`.

### Effort mapping

Absolute levels (`min/low/medium/high/xhigh/max`) map to the nearest
supported gear per provider. `'default'` returns `null` and the flag is
omitted — the CLI uses its own default. `min` and `max` are silent
aliases: Codex `min → minimal`, `max → xhigh`; Claude `min → low`. No
validation of the `model` string — it is passed through as-is.

### Sandbox policy and pass-through args

Two knobs cover the sandbox / permissions surface uniformly across
providers:

- `fullAccess: boolean` (default `false`) — when `true`, Daphnis appends
  the provider's full-access bypass flag
  (`--dangerously-skip-permissions` for Claude,
  `--dangerously-bypass-approvals-and-sandbox` for Codex). When `false`,
  no sandbox/permission CLI flag is added; the CLI's own config decides.
- `extraArgs: string[]` — appended verbatim after Daphnis-managed args.
  No validation, no provider awareness. For Codex the list lands in the
  global flag block, *before* the `app-server` / `exec` subcommand —
  flags like `--sandbox`, `--ask-for-approval`, and `-c key=value` are
  not subcommand flags and would be rejected if placed after.
  Subcommand-specific flags are out of scope. For Claude the list is
  appended at the end of the spawn args; there is no subcommand split.

A boolean rather than an enum, because the Codex sandbox enum
(`read-only` / `workspace-write` / `danger-full-access`) has no
non-interactive Claude equivalent. A typed union that covered only one
provider would lie about behaviour. Callers who want a middle ground
combine `fullAccess: false` with the appropriate `extraArgs` recipe
(e.g. `['--sandbox', 'read-only']` for Codex,
`['--permission-mode', 'plan']` for Claude).

The pass-through-without-validation pattern matches `model` and `env`:
Daphnis treats these as opaque strings the CLI knows how to interpret.
A caller mixing `fullAccess: true` with a contradicting `extraArgs`
flag (e.g. `['--sandbox', 'read-only']`) sees both flags reach the CLI;
resolution is the CLI's job.

**Scope:** `fullAccess` toggles the CLI flag only. It does **not**
change Daphnis' JSON-RPC auto-approval layer in
`CodexCLIWrapper.handleServerRequest` (auto-`accept` for command/file
requests, fixed read/write/network/macOS grants for the permissions
request). That layer is required for the `app-server` handshake to
make progress without a human in the loop and is independent of this
option.

### Instance registry

A module-level `Map<id, RegistryEntry>` in `registry.ts` holds every live
instance produced by `createAIConversation`. The factory generates a
`crypto.randomUUID()` id and hands it to the wrapper constructor.

Registration happens *after* the child process is spawned and its
`stdout`/`stderr`/`stdin`/`exit`/`error` listeners are wired. Placing it
after `spawn(...)` ensures a synchronously throwing spawn cannot leak an
entry.

`unregister(id)` is invariant-tightened: it throws if the entry's state
is not `'exiting'` at call time. This surfaces wrapper bugs at the
source — every code path that ends an instance must transition to
`'exiting'` first. Unknown id remains a silent no-op so the deregistration
paths can fire defensively without coordination.

Deregistration paths:

- `proc.on('exit')` — captures the previous state, then runs
  `tearDownChild` (or, for Claude, transitions `→ exiting` inline),
  calls `setExitCodeFor(id, code)` so the snapshot carries the real
  exit code, and finally calls `unregister(id)`.
- `proc.on('error')` and `stdin.on('error')` — Node does not guarantee
  an `'exit'` event after an `'error'` (the classic ENOENT spawn-failure
  case). The handlers therefore self-unregister defensively. Because
  `setExitCodeFor` is only called from the `'exit'` handler, the
  `instance:removed` snapshot in this case carries `exitCode: null` —
  correct, since no real exit code exists.
- Codex `initialize()` catch — handshake failure transitions to
  `'exiting'` and self-unregisters directly (the child process is still
  alive at this point; `destroy()` schedules a SIGKILL after 3 s, but
  consumers should see the registry empty immediately, not after the
  kill grace period).

`destroy()` is non-blocking. It transitions the entry to `'exiting'`,
rejects pending control / interrupt promises, schedules `proc.stdin.end()`
plus a SIGKILL after 3 s, and returns. The entry stays in the registry
with `state: 'exiting'` until the child process actually exits. A
consumer that calls `destroy()` and immediately calls `listInstances()`
will still see the entry. This is the correct behaviour: `destroy()` is
"I don't want this anymore", not "do work" — the registry only forgets
the entry when the OS-level process is gone (or when an error handler
declares it dead).

Meta is a single opaque slot per entry, not per-wrapper state.
`setMeta(value)` overwrites; `getMeta<T>()` is an unchecked cast. The
registry observes lifecycle; it does not decide anything. No role
management, no dispatch, no "send to the idle one" — that stays on the
caller's side of the boundary.

Lifecycle events ride on the same code paths but emit from five
distinct sites. A module-level `EventEmitter<InstanceEventMap>`
(`instanceEvents`) exposes `instance:added`, `instance:removed`,
`instance:ready`, `instance:meta-changed`, and `instance:state-changed`.
All emissions are synchronous; late subscribers do not receive replayed
history.

The instance state machine is the single source of truth for "what
phase is this wrapper in?". `InstanceInfo.state` carries one of four
values:

- `spawning` — entry is registered, child process is alive, but the
  wrapper has not yet completed its handshake. Initial state on
  `register`.
- `ready` — wrapper is idle and accepts `sendMessage`.
- `busy` — a turn is in flight.
- `exiting` — terminal. The wrapper is tearing down; no further
  transitions are possible.

Legal transitions: `spawning → {ready, exiting}`,
`ready → {busy, exiting}`, `busy → {ready, exiting}`. Any other
transition throws — defensive wiring; a silent ignore would re-introduce
the drift the state machine eliminates. Same-state self-transitions and
unknown ids are silent no-ops.

Wrappers do **not** keep a local state mirror. The registry is the
single source of truth; `inst.state` is a getter that calls
`getState(id)` on every read. State mutations go through
`transitionState(id, next)` directly. Claude transitions to `ready` via
a `setImmediate(...)` callback scheduled at the end of the constructor;
Codex after the `thread/start` / `thread/resume` handshake resolves.
Both transition to `busy` on `sendMessage`'s write/turn-start success
and back to `ready` on the result/`turn/completed` terminator. The
`exiting` transition is performed by `destroy()`, by `proc.on('exit')`,
by `proc.on('error')` / `stdin.on('error')`, and by Codex's
`initialize()` catch — whichever path fires first.
`interrupt()` does not change state — the wrapper stays in `busy`
throughout the cancel.

The per-instance `'error'` event is gated by a listener-count check:
`safeEmitError(err)` only emits if at least one listener is attached.
This prevents the default Node `EventEmitter` behaviour of throwing
on unhandled `'error'` from crashing the host process when callers
choose not to subscribe. Spawn-phase failures (during `state ===
'spawning'`) **never** emit `'error'` regardless of listeners — they
surface via `inst.ready` rejection only. This split keeps the two
channels orthogonal: pre-ready failures are handled via `await
inst.ready`'s rejection; post-ready failures (parser errors, child
crashes mid-turn, stdin pipe failures) flow through the `'error'`
event.

**Late terminator contract.** A turn-result message can arrive *after*
the wrapper has been torn down — `destroy()` was called mid-turn, the
child crashed, or an error handler self-unregistered, but the result
was already in flight on the stdout buffer when the teardown happened.
Both wrappers guard the result/`turn/completed` branch with
`getState(id) !== 'busy' → return` at the top. This drops the
late terminator silently: no illegal `exiting → ready` transition
throw, no `conversation` / `message` event on a torn-down instance, no
phantom assistant turn appended to the in-memory transcript. The
`busy` check covers both an entry that is still in the registry with
state `'exiting'` *and* an entry that has already been unregistered
(unknown id falls back to `'exiting'` via `getState`).

**Spawning-phase error paths kill the child uniformly.** Both Claude
error handlers (`stdin.on('error')`, `proc.on('error')`) call
`this.destroy()` after rejecting `ready` (in the spawning branch) or
emitting `'error'` (post-ready), so the child always gets a
`stdin.end()` plus a scheduled SIGKILL — no orphan processes when the
spawn-phase rejection is the only signal. Codex follows the same
pattern via `tearDownChild` + `destroy()`. The explicit `rejectReady(err)`
runs before `destroy()` so the consumer-visible rejection carries the
real error; `destroy()`'s internal `rejectReady('Destroyed')` is a no-op
on the already-settled promise.

Failure ordering invariant: `instance:state-changed → exiting` always
fires before `instance:removed`. Subscribers see the full lifecycle even
on ENOENT or handshake failure. The `instance:removed` payload
therefore always carries `state === 'exiting'`. `InstanceInfo.exitCode`
is set on the snapshot when the deregistration runs from
`proc.on('exit')`; on the spawn-failure paths (`proc.on('error')`,
`stdin.on('error')`, Codex handshake failure) it is `null` because no
real exit code exists.

`instance:added` fires inside `register` after the entry is in the map.
`instance:removed` fires inside `unregister` after the entry is deleted —
the `InstanceInfo` snapshot is built *before* the `Map.delete` call, so
subscribers receive the final session id, pid, exitCode, and meta even
though the live wrapper is no longer reachable through `getInstance`.
Both fire only when the underlying mutation actually happened: a
re-register of an existing id is a no-op, and an `unregister` for an
unknown id is a no-op. The timing of `instance:removed` follows actual
process death: a `destroy()` call transitions the entry to `'exiting'`
but the `instance:removed` event waits for `proc.on('exit')` to fire (or
for a defensive `unregister` from an error handler / Codex handshake
catch).

`instance:ready` is emitted from inside `registry.transitionState(id,
next)`, but only when `prev === 'spawning' && next === 'ready'`.
Subsequent `busy → ready` transitions emit `instance:state-changed`
without re-emitting `instance:ready`. For Claude the
`spawning → ready` transition happens inside the constructor, after
`instance:added`, so the `added → ready` order is observable on the
same tick that `createAIConversation()` returns; `info.sessionId` is
still `null` because `system/init` only arrives after the first user
message. For Codex it happens later, after the `thread/start` /
`thread/resume` handshake resolves, so subscribers see
`instance:added` first and `instance:ready` only after the handshake
completes — by which point `info.sessionId` already carries the
captured `threadId`. The transition is exclusive; the event therefore
fires at most once per id. A handshake failure produces
`instance:added` → `instance:state-changed (spawning → exiting)` →
`instance:removed` with no intervening `instance:ready`.

`instance:state-changed` fires from `registry.transitionState` on every
legal state change, with payload `[info, prev, next]`. `info.state ===
next` is intentionally redundant. It is the consumer-visible event; the
mutator (`transitionState`) is internal.

`instance:meta-changed` fires inside `setMetaFor` after the meta slot is
overwritten, with payload `[info, prev]` — `info.meta` carries the new
value, `prev` carries whatever was stored before. Suppressed for unknown
ids (silent no-op preserved). Not emitted on initial `register` — the
initial meta value is carried by the `instance:added` payload. No
equality check between `prev` and the new value: every call emits, even
if the caller hands in the exact same reference twice (filtering is the
consumer's concern, since `unknown` has no meaningful equality).

Listeners must not throw. Node's `EventEmitter` propagates synchronous
throws back to the emit site, which on `instance:ready` /
`instance:state-changed` sits inside the wrapper constructor /
handshake / `sendMessage` / `result`-handler / `destroy` path, and on
`instance:meta-changed` sits inside `setMeta`. Consumers compose
`listInstances()` with `instanceEvents.on('instance:added', …)` for full
coverage of pre-existing plus new instances.

### Per-instance event surface

`AIConversationInstance` extends `EventEmitter<InstanceMessageEventMap>`
with three events:

- `message: (text: string)` — assistant final text, fired after
  `'conversation'` for the assistant turn.
- `conversation: (turn: ConversationTurn)` — both user and assistant
  turns. The user turn fires inside `sendMessage`'s write callback
  before the promise resolves; the assistant turn fires when the
  provider terminator arrives.
- `error: (err: Error)` — parser errors, child crashes mid-turn, stdin
  pipe failures. Gated by a listener-count check (`safeEmitError`):
  emitting without a listener is a silent no-op, not a process crash.
  Spawn-phase failures (state `'spawning'`) never emit here regardless
  of listeners — they surface via `inst.ready` rejection.

`sendMessage` rejections are NOT also fired on `'error'`. The promise
rejection is the canonical channel for `sendMessage` failures
(`'Destroyed'` / `'Already processing'` / `'Not ready'`, plus underlying
stdin / JSON-RPC errors). The `'error'` event covers failures that have
no callsite to reject.

### Interrupt protocol

`AIConversationInstance.interrupt()` cancels the in-flight turn while
keeping the session alive. Both providers expose a native cancel that
preserves the session; Daphnis surfaces it uniformly.

**Wire-level shapes:**

- **Claude** uses an in-band control protocol on the same stdio pipe.
  The wrapper writes
  `{"type":"control_request","request_id":<uuid>,"request":{"subtype":"interrupt"}}`
  and watches stdout for
  `{"type":"control_response","response":{"subtype":"success","request_id":<uuid>}}`.
  The in-flight turn then ends as a `result` with `is_error: true` and
  `subtype: "error_during_execution"`. The `session_id` stays valid.
- **Codex** uses a JSON-RPC method, `turn/interrupt({ threadId, turnId })`.
  Synchronous response is `{}`. The in-flight turn terminates with a
  regular `turn/completed` notification, but `turn.status === "interrupted"`.
  The thread stays alive. To send `turnId`, the wrapper captures
  `result.turn.id` from the `turn/start` response and clears it on every
  terminal turn event.

**Resolution contract:** `interrupt()` waits for `Promise.all([ack,
busyCleared])`. The control-channel ack and the terminator can arrive in
either order; both halves must settle before the promise resolves. This
guarantees that, by the time `await interrupt()` returns, the wrapper's
`busy` flag is already clear and the next `sendMessage` will not throw
`Already processing`.

**No internal timeout.** A hung CLI cannot be healed from inside the
wrapper — and a forced `destroy()` plus "resume via `getSessionId()`"
would chain further failure modes (unwritten session id, half-written
JSONL, resume spawn failure). The single source of truth for the "give
up" decision is the caller: race the returned promise against an
`AbortSignal`/timer and call `destroy()` after if you want a hard stop.
Pending control requests and pending interrupt promises are still
rejected at the *real* failure boundary — every `proc.on('exit')`,
`proc.on('error')`, and `stdin.on('error')` handler rejects them with
the underlying cause, so a dead child does not leak a forever-pending
promise.

**Race semantics for the in-memory transcript.** Three terminator cases
can race the cancel:

1. *Real interrupt* (Claude `is_error=true` + `subtype="error_during_execution"`,
   Codex `status="interrupted"`): no assistant turn appended, no
   `'error'` event, `interrupt()` resolves. The dangling user turn from
   the cancelled exchange stays.
2. *Natural completion* (Claude `is_error=false`, Codex `status="completed"`):
   the turn finished before the cancel landed. The assistant turn IS
   appended and the normal `'conversation'` / `'message'` events fire,
   because `getTranscript()` is in-memory only and silently dropping a
   successfully produced answer would erase it permanently.
   `interrupt()` still resolves.
3. *Real provider failure* during the cancel race (any other error
   subtype / `status="failed"`): the `'error'` event fires AND
   `interrupt()` rejects with the same error.

**Persisted-history caveat.** Whether Claude's
`error_during_execution` result lands in
`~/.claude/projects/.../<session>.jsonl` is undocumented; same for
Codex's interrupted-turn rollout files. `getTranscript()` is in-memory
only for the lifetime of an instance — it does not re-read the on-disk
JSONL after the initial resume-time load. Daphnis does not edit the
on-disk JSONL and does not invent a uniform marker; the in-memory
transcript is authoritative for the live instance.

### Codex permission handshake

Codex's `app-server` sends server-initiated JSON-RPC requests for file
system, network, and macOS permissions. Daphnis auto-grants read/write
on the session's `cwd`, enables network, and grants macOS sub-permissions
— matching what an interactive `codex` session would elicit from the
user. Unknown server-initiated methods return a JSON-RPC `-32601` error
(fail-closed).

`fullAccess: true` short-circuits both the OS-level Codex sandbox **and**
the JSON-RPC approval round-trip — Codex emits no approval requests
once the bypass flag is active, so the auto-approval layer simply does
not run. With `fullAccess: false` (default), the auto-approval policy
above stays in place unchanged; the CLI's own sandbox (or an
`extraArgs`-supplied `--sandbox …`) is what actually gates risky ops in
that mode. The auto-approver is a handshake helper, not a sandbox.

## Test strategy

- Unit tests under `src/__tests__/`, one file per module.
- `node:child_process` and `node:fs/promises` are mocked via `vi.mock`.
- Fake processes use `EventEmitter` + `PassThrough` streams to simulate
  stdout/stderr/exit/close sequencing.
- Timeout and abort paths are covered by the one-shot tests.
- Excluded from the tsc build via `tsconfig.json` `exclude`.

No integration tests against real CLIs — those are the caller's
responsibility (and require live credentials).
