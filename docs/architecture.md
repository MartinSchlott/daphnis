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
│   ├── types.ts              # AIConversationInstance, Options, Handlers, Effort
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
  `AIConversationHandlers`, `ConversationTurn`, `Effort`
- `runOneShotPrompt` + `OneShotOptions`, `OneShotResult`
- `listSessions` + `SessionInfo`
- `listInstances`, `getInstance`, `instanceEvents` + `InstanceInfo`,
  `InstanceEventMap`

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
      type=result            → emit assistant turn, reset busy BEFORE callback
      type=control_response  → resolve/reject the matching interrupt() ack
```

Ready fires immediately on spawn — the `system/init` event only arrives
after the first user message, so we cannot wait for it.

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

Codex requires an initialisation handshake. Ready only fires after
`thread/start` / `thread/resume` returns a thread id.

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

### Busy flag reset before callback

Both wrappers reset `busy = false` *before* invoking `onConversation` /
`onMessage`. Callbacks may synchronously call `sendMessage` (e.g. marker
retry patterns, auto-dispatch); resetting after would fail with
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
`stdout`/`stderr`/`stdin`/`exit`/`error` listeners are wired, but still
*before* any user callback can fire — i.e. before Claude's synchronous
`onReady()` at the end of the constructor and before Codex's async
`initialize()`. Placing it after `spawn(...)` ensures a synchronously
throwing spawn cannot leak an entry.

Deregistration happens at three points, any of which is safe to run
twice because `Map.delete` is idempotent:

- Inside `destroy()`, *synchronously* — before the `destroyed = true`
  guard flips. Immediately after `destroy()` returns, the entry is gone.
  Codex `initialize()` calls `this.destroy()` in its catch block after
  `onError`, so a failed handshake does not leave a stale entry.
- In the `proc.on('exit')` handler, *before* `onExit(code)` fires. A
  caller inspecting `listInstances()` from inside `onExit` sees the
  instance already gone.
- In the `proc.on('error')` handler, via `this.destroy()` after
  `onError`. Node does not guarantee an `exit` event when `spawn` emits
  `error` (e.g. ENOENT), so without this path a missing binary would
  leave a registry entry for a process that never lived.

Meta is a single opaque slot per entry, not per-wrapper state.
`setMeta(value)` overwrites; `getMeta<T>()` is an unchecked cast. The
registry observes lifecycle; it does not decide anything. No role
management, no dispatch, no "send to the idle one" — that stays on the
caller's side of the boundary.

Lifecycle events ride on the same code paths. A module-level
`EventEmitter<InstanceEventMap>` (`instanceEvents`) emits `instance:added`
inside `register` after the entry is in the map, and `instance:removed`
inside `unregister` after the entry is deleted. The `InstanceInfo`
snapshot for `instance:removed` is built *before* the `Map.delete` call,
so subscribers receive the final session id, pid, and meta even though
the live wrapper is no longer reachable through `getInstance`. Emission
fires only when the underlying mutation actually happened: a re-register
of an existing id is a no-op (no second `instance:added`), and an
`unregister` for an unknown id is a no-op (no orphan `instance:removed`).
Dispatch is synchronous — `instance:added` fires before
`createAIConversation()` returns, and an ENOENT or Codex handshake
failure produces `instance:added` followed shortly by `instance:removed`
because the wrapper registers before any async failure path can fire.
Late subscribers do not receive replayed history; consumers compose
`listInstances()` with `instanceEvents.on('instance:added', …)` for full
coverage.

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
   `onError`, `interrupt()` resolves. The dangling user turn from the
   cancelled exchange stays.
2. *Natural completion* (Claude `is_error=false`, Codex `status="completed"`):
   the turn finished before the cancel landed. The assistant turn IS
   appended and the normal `onConversation` / `onMessage` callbacks
   fire, because `getTranscript()` is in-memory only and silently
   dropping a successfully produced answer would erase it permanently.
   `interrupt()` still resolves.
3. *Real provider failure* during the cancel race (any other error
   subtype / `status="failed"`): `onError` fires AND `interrupt()`
   rejects with the same error. Masking a real failure as a successful
   cancel would hide a real bug.

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
