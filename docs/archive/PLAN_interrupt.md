# PLAN: interrupt() — cancel an in-flight turn without losing the session

## Context & Goal

Today an `AIConversationInstance` exposes no way to cancel a turn mid-stream.
Callers can only `destroy()` (kills the child process — instance is gone) or
wait for `result` / `turn/completed`. Both providers in fact support a clean
in-band cancellation that keeps the session alive:

- **Claude** (`--print --input-format stream-json`): control protocol on the
  same stdio pipe. Send `{"type":"control_request", "request_id":<uuid>,
  "request":{"subtype":"interrupt"}}` to stdin, wait for
  `{"type":"control_response", "response":{"subtype":"success",
  "request_id":<uuid>, ...}}` on stdout. The in-flight turn then ends as a
  `result` with `is_error: true` and `subtype:"error_during_execution"`. The
  `session_id` stays valid; the next `sendMessage` continues the same
  conversation. Source: `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`
  (`SDKControlInterruptRequest`, `SDKControlRequest`).
- **Codex** (`app-server`, JSON-RPC 2.0): method `turn/interrupt` with
  `{ threadId, turnId }`. Synchronous response is `{}` (empty success). The
  in-flight turn then terminates with the regular `turn/completed`
  notification, but `turn.status === "interrupted"`. Thread stays alive. The
  caller can immediately start a new turn. Source:
  `openai/codex` `codex-rs/app-server/README.md`,
  developers.openai.com/codex/app-server.

Goal: add a uniform `interrupt(): Promise<void>` to `AIConversationInstance`
that uses the native cancel on each provider, leaves the instance ready for
the next `sendMessage`, and does not mutate the in-memory history beyond
what the provider itself records.

## Breaking Changes

**Yes.** `AIConversationInstance` gains a new required method `interrupt()`.
Anyone *implementing* the interface outside Daphnis breaks. Anyone *using*
the interface (the common case) does not — the addition is purely additive
on the consumer side.

No DB reset, no env changes, no migration code. Bump version to `v3.1.0`
(minor, additive feature; the interface change is a TypeScript-only break
that does not affect compiled JS callers).

## Reference Patterns

- `src/codex-cli-wrapper.ts:173-191` — `sendJsonRpcRequest`: id-keyed
  `pendingRequests` map, write line, resolve on matching response. The
  Claude control-protocol mechanism is structurally identical and can mirror
  this pattern.
- `src/codex-cli-wrapper.ts:115-124` — exit / stdin-error handler that
  rejects every entry in `pendingRequests` and clears the map. The Claude
  wrapper needs an equivalent path for the new
  `pendingControlRequests` map.
- `src/codex-cli-wrapper.ts:296-343` — `handleNotification`: the existing
  `turn/completed` switch is where the new `status: "interrupted"` branch
  lands.
- `src/claude-cli-wrapper.ts:164-208` — `handleParsed`: where the
  `control_response` case is added.
- `src/__tests__/claude-cli-wrapper.test.ts` and
  `src/__tests__/codex-cli-wrapper.test.ts` — test scaffolding (fake child
  process via `EventEmitter` + `PassThrough`, NDJSON feed/capture helpers).

## Dependencies

None new. `node:crypto` is already a stdlib import elsewhere; the wrappers
gain a `randomUUID` import.

## Assumptions & Risks

- **No internal timeout.** `interrupt()` waits indefinitely for the
  provider's ack and for the busy flag to clear (terminator event). The
  caller composes any timeout it wants via `Promise.race` /
  `AbortController` and decides itself whether to escalate to `destroy()`.
  Daphnis stays a thin wrapper and does not invent a recovery story it
  cannot keep — if the CLI hangs, *we* cannot heal it from inside the
  wrapper, and a forced `destroy()` plus "resume via `getSessionId()`"
  would be a chain of further failure modes (unwritten session id,
  half-written JSONL, resume spawn failure, undefined conversation
  state) that we would have to lie about. Single source of truth for
  the "give up" decision: the caller.
- **Process death while `interrupt()` is pending.** Without a timeout, a
  hung CLI would leak a forever-pending promise. We compensate at the
  *real* failure boundary: every pending control-request promise (Claude)
  and every pending JSON-RPC promise (Codex, already done) is rejected
  in the `proc.on('exit')` and `proc.on('error')` handlers, plus the
  stdin-error handler. The promise then surfaces a real cause (`Process
  exited with code …`, `ENOENT`, etc.) instead of hanging.
- **Codex `turnId` capture.** The current wrapper discards the result of
  `turn/start`. The documented response shape mirrors `thread/start`:
  `{ turn: { id: string, ... } }`. We capture `result.turn.id`, store it
  as `currentTurnId`, and clear it when the turn terminates (regular
  `completed` *or* `interrupted` *or* any other terminal status). If a
  future Codex version changes the shape, `interrupt()` rejects with a
  clear error and the caller can fall back to `destroy()`.
- **Codex partial-content buffer.** `turnBuffer` accumulates
  `item/agentMessage/delta` chunks. On `status:"interrupted"` we
  explicitly clear it, otherwise the partial cancelled content would
  leak into the next turn (today's reset at the top of `sendMessage` is
  a defensive net, but the interrupt path should clean up its own
  state).
- **Persisted-history semantics differ across providers and are silent in
  the docs.** Claude writes a `result` event with
  `error_during_execution`; whether it lands in
  `~/.claude/projects/.../<session>.jsonl` is not documented. Codex's
  `~/.codex/sessions/.../rollout-*.jsonl` behaviour for an interrupted
  turn is not documented either. `getTranscript()` for a live instance
  is in-memory only — it does **not** re-read the on-disk JSONL after
  the initial resume-time load (see `claude-cli-wrapper.ts:252-260`,
  `codex-cli-wrapper.ts:387-395`). We do not invent a uniform marker
  and do not edit the on-disk JSONL; the in-memory transcript is
  authoritative for the lifetime of the instance. Documented in the new
  "Interrupt protocol" section of `architecture.md`.
- **In-memory history on interrupt.** The user turn is already pushed in
  `sendMessage` (Claude after stdin write callback; Codex after
  `turn/start` resolves). For the *interrupt-terminator* event (Claude:
  `result` with `is_error=true` *and* `subtype="error_during_execution"`;
  Codex: `turn/completed` with `status="interrupted"`) no assistant turn
  is appended — the dangling user turn stays. For the *natural-completion
  race* (turn finished before the cancel landed; Claude: `is_error=false`;
  Codex: `status="completed"`) the assistant turn **is** pushed and the
  normal callbacks fire, because `getTranscript()` is in-memory only —
  silently dropping it would erase a successfully produced answer. The
  `interrupt()` promise resolves in either case (the turn is over and
  the busy flag is clear). For *real provider failures* during the cancel
  race (Claude: `is_error=true` with any other subtype; Codex:
  `status="failed"` or any other non-`interrupted`/non-`completed`
  status) the normal `onError` path runs **and** the `interrupt()`
  promise rejects with that error — masking a real failure as a
  successful cancel would hide a real bug.
- **`interrupt()` while not busy.** Rejects with `Error('Not busy')`. We
  do not silently no-op — caller misuse is signalled.
- **`interrupt()` after `destroy()`.** Rejects with `Error('Destroyed')`.
- **Concurrent `interrupt()` calls.** A second concurrent call rejects
  with `Error('Interrupt already in progress')`.

## Steps

### 1. Extend the public type

In `src/types.ts`, add to `AIConversationInstance`:

```ts
/**
 * Cancel the in-flight turn while keeping the session alive. Resolves
 * once the provider has acknowledged the cancellation *and* the
 * terminator event has cleared the busy flag — i.e. the instance is
 * actually ready for the next `sendMessage`. There is no internal
 * timeout: if you want to give up, race this promise against your own
 * `AbortSignal`/timer and call `destroy()` after.
 *
 * Rejects if the instance is not currently busy, was destroyed, an
 * interrupt is already in progress, the provider's ack carries an
 * error, the child process exits/errors before the cancel completes,
 * or the in-flight turn fails for a reason unrelated to the cancel
 * (i.e. a real provider error races the interrupt — the underlying
 * `onError` still fires and `interrupt()` rejects with that same
 * error).
 *
 * Ordering: do not call `sendMessage` before the returned promise
 * resolves — it will fail with `Already processing`.
 *
 * History semantics: the in-memory user turn of the cancelled exchange
 * is retained. If the cancel actually interrupted the turn (Claude:
 * `result` with `is_error=true` and `subtype="error_during_execution"`;
 * Codex: `turn` with `status="interrupted"`), no assistant turn is
 * appended. If the turn finished naturally during the cancel race
 * (Claude: `is_error=false`; Codex: `status="completed"`), the
 * assistant turn **is** appended and the normal `onMessage` /
 * `onConversation` callbacks fire, because `getTranscript()` is
 * in-memory only and silently dropping it would erase a successfully
 * produced answer; `interrupt()` still resolves in that case.
 */
interrupt: () => Promise<void>;
```

### 2. Claude wrapper — `src/claude-cli-wrapper.ts`

a. Add `import { randomUUID } from 'node:crypto';` at the top.

b. Add fields:

```ts
private pendingControlRequests = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
private interrupting = false;
private busyClearedResolve: (() => void) | null = null;
```

c. Extend `handleParsed` with a dedicated branch for `control_response`,
emitted *before* the existing `switch` on `msg['type']`:

```ts
if (msg['type'] === 'control_response') {
  const response = msg['response'] as Record<string, unknown> | undefined;
  const requestId = response?.['request_id'] as string | undefined;
  if (!requestId) return;
  const pending = this.pendingControlRequests.get(requestId);
  if (!pending) return;
  this.pendingControlRequests.delete(requestId);
  if (response?.['subtype'] === 'success') {
    pending.resolve();
  } else {
    const errMsg = (response?.['error'] as string) ?? 'control_request failed';
    pending.reject(new Error(errMsg));
  }
  return;
}
```

d. In the existing `case 'result'`, restructure the branch so **every**
terminator settles a pending interrupt. The interrupt-terminator
classification is *subtype-based*: only Claude's documented interrupt
result (`is_error=true` *and* `subtype="error_during_execution"`)
counts as the cancel terminator; any other `is_error=true` is a real
provider failure. Concrete shape:

- Read `subtype = msg['subtype']` alongside `isError`.
- Compute `isInterruptTerminator = isError && subtype === 'error_during_execution'`.
- Reset `busy = false` (as today, before callbacks).
- If `this.interrupting === true`:
  - Clear `interrupting = false`.
  - If `isInterruptTerminator`:
    - Resolve `busyClearedResolve`, null both
      `busyClearedResolve` / `busyClearedReject`. Skip `onError`,
      skip pushing an assistant turn — the interrupt promise's
      resolution is the only signal the caller needs.
  - Else if `isError === true` (real provider failure during the
    cancel race):
    - Reject `busyClearedReject` with `new Error(resultText)`, null
      both. Also call `onError(new Error(resultText))` — masking a
      real failure as a successful cancel would hide a real bug.
  - Else (`isError === false` — turn finished naturally before the
    cancel landed):
    - Resolve `busyClearedResolve`, null both. **Push the assistant
      turn and fire `onConversation` / `onMessage` as in the normal
      path** — `getTranscript()` is in-memory only (see
      `claude-cli-wrapper.ts:252-260`), so silently dropping a
      successfully produced answer would erase it permanently.
- Else (no interrupt in flight): existing behaviour unchanged —
  `is_error=true` → `onError`; `is_error=false` → push assistant turn,
  fire callbacks.

The control-channel ack (`control_response`) and the terminator
(`result`) can arrive in either order, and both the natural-completion
and the failure race above can also race with the ack. `interrupt()`
waits for `Promise.all([ack, busyCleared])`, so resolution requires
both halves regardless of ordering; on the failure-race path the
`busyCleared` half rejects, which surfaces through `Promise.all` as
the rejection reason of `interrupt()` itself.

e. Reject all pending control requests on process death. In each of:

- `proc.stdin!.on('error', …)`
- `proc.on('exit', …)` (also when `busy === true`)
- `proc.on('error', …)`

…iterate `pendingControlRequests`, reject each with the relevant error
(`stdin error`, `Process exited with code <n>[: <stderr>]`, the spawn
error), and clear the map. If `busyClearedReject` is set, also reject
the surrounding interrupt promise via that channel; null both
`busyClearedResolve` and `busyClearedReject` and clear
`interrupting = false`.

f. Extend `destroy()`. In addition to today's behaviour (set
`destroyed`, end stdin, schedule kill), reject the pending interrupt
state synchronously inside `destroy()` itself — do not rely on the
`exit` handler, since callers may give up before the child has had a
chance to die:

- Iterate `pendingControlRequests`, reject each with
  `new Error('Destroyed')`, clear the map.
- If `busyClearedReject` is set, call it with `new Error('Destroyed')`,
  null both `busyClearedResolve` / `busyClearedReject`, set
  `interrupting = false`.

g. Implement `interrupt()`:

```ts
async interrupt(): Promise<void> {
  if (this.destroyed) throw new Error('Destroyed');
  if (!this.busy) throw new Error('Not busy');
  if (this.interrupting) throw new Error('Interrupt already in progress');
  this.interrupting = true;

  const requestId = randomUUID();
  const message = JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' },
  });

  const ack = new Promise<void>((resolve, reject) => {
    this.pendingControlRequests.set(requestId, { resolve, reject });
  });

  const busyCleared = new Promise<void>((resolve, reject) => {
    this.busyClearedResolve = resolve;
    this.busyClearedReject = reject;
  });

  try {
    this.proc.stdin!.write(message + '\n');
    await Promise.all([ack, busyCleared]);
  } catch (err) {
    this.interrupting = false;
    throw err;
  } finally {
    this.busyClearedResolve = null;
    this.busyClearedReject = null;
  }
}
```

(Field declarations: also add `private busyClearedReject: ((e: Error) =>
void) | null = null;`.)

### 3. Codex wrapper — `src/codex-cli-wrapper.ts`

a. Add fields:

```ts
private currentTurnId: string | null = null;
private interrupting = false;
private busyClearedResolve: (() => void) | null = null;
private busyClearedReject: ((e: Error) => void) | null = null;
```

b. In `sendMessage`, capture the turn id from the `turn/start` response.
The response shape mirrors `thread/start` (`{ thread: { id } }`), i.e.
`{ turn: { id: string, ... } }`:

```ts
const result = await this.sendJsonRpcRequest('turn/start', turnParams) as
  { turn?: { id?: string } };
if (typeof result?.turn?.id === 'string') {
  this.currentTurnId = result.turn.id;
}
```

If the response shape lacks `turn.id`, leave `currentTurnId = null`;
`interrupt()` will reject cleanly with `No active turn to interrupt`.

c. In the `turn/completed` handler, restructure so **every** terminal
turn event settles a pending interrupt. The interrupt-terminator
classification is *status-based*: only `status="interrupted"` counts
as the cancel terminator; `status="completed"` is a natural completion
that races the cancel; any other status (e.g., `"failed"`) is a real
provider failure and must be surfaced. Concrete shape:

- Snapshot `completedContent = this.turnBuffer` and reset
  `busy = false`, `currentTurnId = null`, `turnBuffer = ''` (as today,
  before callbacks).
- If `this.interrupting === true`:
  - Clear `interrupting = false`.
  - If `status === 'interrupted'`:
    - Resolve `busyClearedResolve`, null both
      `busyClearedResolve` / `busyClearedReject`. Do not push an
      assistant turn, do not call `onError`.
  - Else if `status === 'completed'` (natural-completion race):
    - Resolve `busyClearedResolve`, null both. **Push the assistant
      turn from `completedContent` and fire `onConversation` /
      `onMessage` as in the normal path** — `getTranscript()` is
      in-memory only (see `codex-cli-wrapper.ts:387-395`), so
      silently dropping a successfully produced answer would erase
      it permanently.
  - Else (real provider failure during the cancel race):
    - Reject `busyClearedReject` with
      `new Error('Turn failed with status: ' + (status ?? 'unknown'))`,
      null both. Also call `onError` with the same error — masking a
      real failure as a successful cancel would hide a real bug.
- Else (no interrupt in flight): existing behaviour unchanged —
  `status === "completed"` pushes the assistant turn and fires
  callbacks; any other status calls `onError`.

The JSON-RPC ack for `turn/interrupt` and the terminator notification
can arrive in either order, and both the natural-completion and the
failure race above can also race with the ack. `interrupt()` waits for
`Promise.all([ack, busyCleared])`, so resolution requires both halves
regardless of ordering; on the failure-race path the `busyCleared`
half rejects, which surfaces through `Promise.all` as the rejection
reason of `interrupt()` itself.

d. Extend the existing `proc.stdin!.on('error', …)` and **extend the
existing `proc.on('exit', …)` / `proc.on('error', …)`** handlers so
that an externally killed child leaves the wrapper in a fully
consistent terminal state — not just "interrupt promise no longer
hangs" but "no live state pretends a turn is still in flight".

Concrete teardown applied to all three handlers (idempotent — guard
on `this.destroyed` for the parts that should not double-run):

1. Reject every entry in `pendingRequests` with the appropriate error
   (`Process exited with code <n>`, the spawn `Error`, the stdin
   error) and clear the map. Today only `stdin.on('error')` does
   this; `proc.on('exit')` and `proc.on('error')` currently leave
   pending JSON-RPC promises hanging.
2. If `busyClearedReject` is set, call it with the same error and
   null both `busyClearedResolve` / `busyClearedReject`. Also set
   `interrupting = false`.
3. Reset turn-level state: `busy = false`, `currentTurnId = null`,
   `turnBuffer = ''`. (Mirrors what Claude's `proc.on('exit')`
   already does for `busy`, and what Codex's own `destroy()` does
   for `turnBuffer`.) Without this, a wrapper whose child died
   externally would still report `busy=true` and carry stale
   `turnBuffer` / `currentTurnId`, which a subsequent caller could
   observe via `getTranscript()` semantics or via a follow-up
   `sendMessage` that would wrongly reject with `Already
   processing`.
4. For `proc.on('exit')` specifically: if the wrapper was busy at
   exit time, also call `onError(new Error(<exit message>))` before
   `onExit`, mirroring the Claude wrapper's existing behaviour
   (`claude-cli-wrapper.ts:128-140`).
5. `proc.on('error')` keeps its existing `destroy()` call, which
   covers `unregister` + stdin teardown; the explicit state reset
   above runs before that so `destroy()` sees a clean slate.

Together these halves ensure `Promise.all([ack, busyCleared])` inside
`interrupt()` rejects with a real cause on process death rather than
hanging, *and* the wrapper does not leak a zombie state where
`busy`/`currentTurnId`/`turnBuffer` outlive the child.

e. Extend `destroy()`. Today the Codex `destroy()` already rejects
`pendingRequests` (line 423-427) but does not know about the new
interrupt state. Add — synchronously inside `destroy()`, not via the
exit handler — a reject of `busyClearedReject` (if set) with
`new Error('Destroyed')`, null both `busyClearedResolve` /
`busyClearedReject`, and set `interrupting = false`,
`currentTurnId = null`, `busy = false`. Callers may give up before
the child has died, so the rejection must surface from `destroy()`
itself.

f. Implement `interrupt()`:

```ts
async interrupt(): Promise<void> {
  if (this.destroyed) throw new Error('Destroyed');
  if (!this.busy) throw new Error('Not busy');
  if (!this.threadId || !this.currentTurnId) {
    throw new Error('No active turn to interrupt');
  }
  if (this.interrupting) throw new Error('Interrupt already in progress');
  this.interrupting = true;

  const ack = this.sendJsonRpcRequest('turn/interrupt', {
    threadId: this.threadId,
    turnId: this.currentTurnId,
  });

  const busyCleared = new Promise<void>((resolve, reject) => {
    this.busyClearedResolve = resolve;
    this.busyClearedReject = reject;
  });

  try {
    await Promise.all([ack, busyCleared]);
  } catch (err) {
    this.interrupting = false;
    throw err;
  } finally {
    this.busyClearedResolve = null;
    this.busyClearedReject = null;
  }
}
```

### 4. Factory and exports

`src/factory.ts` — no change (it wires constructor args, the new method
is on the prototype). `src/index.ts` — no new symbol; `interrupt` rides
on `AIConversationInstance`.

### 5. Tests

`src/__tests__/claude-cli-wrapper.test.ts` — add cases:

- `interrupt() rejects when not busy`.
- `interrupt() rejects when destroyed`.
- `interrupt() writes the correct control_request NDJSON line` (capture
  stdin, parse, assert shape).
- `interrupt() resolves only after BOTH control_response success AND
  result(is_error=true) arrive`. Verify ordering: feed only the
  control_response → promise still pending; then feed the result → now
  resolves.
- `interrupt() suppresses onError for the interrupt-terminator result`
  — `is_error=true` *with* `subtype="error_during_execution"` and
  `interrupting=true` does not call `onError`, does not push an
  assistant turn.
- **Natural-completion race:** `interrupt() resolves when the turn
  finishes naturally during the cancel race` — feed `control_response`
  success, then a `result` with `is_error: false`. Assert the promise
  resolves, **the assistant turn IS appended to history**, `onMessage`
  and `onConversation` ARE fired for that result (because
  `getTranscript()` is in-memory only — see the
  `claude-cli-wrapper.ts:252-260` reference), and `subsequent sendMessage`
  still works.
- **Failure race:** `interrupt() rejects (and onError fires) when the
  turn fails for an unrelated reason during the cancel race` — feed
  `control_response` success, then a `result` with `is_error: true` and
  some other subtype (e.g. `"error_max_turns"` — anything other than
  `"error_during_execution"`). Assert: `onError` IS called with the
  result text, `interrupt()` rejects with the same error, no assistant
  turn appended, `subsequent sendMessage` still works.
- `subsequent sendMessage works after interrupt() resolves`.
- `interrupt() rejects on control_response error subtype`.
- `interrupt() rejects when child exits before completion` — feed
  control_request, then emit `proc.emit('exit', 1)`; the promise rejects
  with the process-exit error.
- `interrupt() rejects when child errors before completion` — emit
  `proc.emit('error', new Error('ENOENT'))`; reject mirrors the cause.
- **Destroy race:** `interrupt() rejects with Destroyed when destroy()
  is called while interrupt is pending` — start interrupt, call
  `destroy()` synchronously before any stdout response; assert the
  promise rejects with `Error('Destroyed')` and that
  `pendingControlRequests` is cleared.
- `concurrent interrupt() rejects second call with "Interrupt already in
  progress"`.

`src/__tests__/codex-cli-wrapper.test.ts` — add cases:

- Mirror the not-busy / destroyed / concurrent-call rejections.
- `sendMessage captures turn.id from turn/start response`. The mock
  must return `{ turn: { id: 'turn-xyz' } }`, mirroring the existing
  `thread/start` shape `{ thread: { id } }`.
- `interrupt() rejects with "No active turn to interrupt" when
  turn/start response lacks turn.id` — mock returns `{}` (or
  `{ turn: {} }`), assert the early rejection.
- `interrupt() sends turn/interrupt JSON-RPC with correct
  threadId+turnId`.
- `interrupt() resolves only after BOTH the JSON-RPC ack AND the
  turn/completed status="interrupted" notification arrive`. Verify the
  ordering as for Claude.
- `interrupt() suppresses onError for status="interrupted"`,
  `currentTurnId` and `turnBuffer` are cleared, no assistant turn
  pushed.
- **Natural-completion race:** `interrupt() resolves when turn/completed
  arrives with status="completed" during the cancel race` — feed the
  JSON-RPC ack, then a `turn/completed` with `status: "completed"` and
  a non-empty `turnBuffer` (set up via prior `item/agentMessage/delta`
  events). Assert resolution, **the assistant turn IS pushed with the
  buffered content**, `onMessage` and `onConversation` ARE fired
  (because `getTranscript()` is in-memory only — see the
  `codex-cli-wrapper.ts:387-395` reference), `turnBuffer` and
  `currentTurnId` are cleared, and `subsequent sendMessage` works.
- **Failed-status race:** `interrupt() rejects AND onError fires when
  turn/completed arrives with status="failed" during the cancel race`
  — feed the JSON-RPC ack, then a `turn/completed` with
  `status: "failed"`. Assert: `onError` IS called with `Turn failed
  with status: failed`, `interrupt()` rejects with the same error, no
  assistant turn pushed, `subsequent sendMessage` works.
- `subsequent sendMessage works after interrupt() resolves`, including
  capturing a fresh `currentTurnId` from the new `turn/start` response.
- **External child death — exit handler teardown:** start a turn so
  `busy=true`, capture a `currentTurnId`, push some `turnBuffer`
  content, then emit `proc.emit('exit', 1)` *without* calling
  `destroy()` first. Assert: `pendingRequests` is empty (rejected),
  `busy === false`, `currentTurnId === null`, `turnBuffer === ''`,
  `interrupting === false`, `onError` was called with the exit message,
  `onExit` was called.
- `interrupt() rejects when child exits before the notification arrives`
  (covers the new `pendingRequests` rejection in `proc.on('exit')` *and*
  `busyClearedReject`).
- **Destroy race:** `interrupt() rejects with Destroyed when destroy()
  is called while interrupt is pending` — start interrupt, call
  `destroy()`; assert rejection and that `busy`, `currentTurnId`,
  `turnBuffer`, `interrupting` are all cleared.

Test scaffolding stays the same (fake child process, NDJSON feed
helpers); the new helpers are a `controlResponseEvent(requestId,
subtype)` for Claude and a `turnInterruptedNotification(turnId)` for
Codex.

**Cross-cutting test updates** (mandatory because `interrupt` becomes a
required member of `AIConversationInstance`):

- `src/__tests__/registry.test.ts` — both fixture sites (`makeFake`
  helper around line 20, and the inline literal around line 225) must
  be extended with `interrupt: async () => {}` so the type-check passes
  after step 1.
- `src/__tests__/factory.test.ts` — add assertions that the instance
  returned by `createAIConversation` for both providers exposes a
  `interrupt` function (`expect(typeof instance.interrupt).toBe(
  'function')`). This locks the public-API surface; the wrapper-level
  tests still cover the behaviour.

### 6. Documentation updates (Doc Update phase, after Validation)

- `docs/definition.md` — extend the in-scope list under
  `createAIConversation`: "...with streaming callbacks, resume by
  session id, transcript retrieval, **and turn-level cancellation
  (`interrupt()`)**".
- `docs/architecture.md` — add an "Interrupt protocol" subsection under
  Design decisions, with the wire-level shapes for both providers, the
  no-internal-timeout rationale, the busy-cleared-before-resolve
  contract, and the history-semantics caveat. Update the Claude data-
  flow diagram to mention the bidirectional control-channel and the
  Codex diagram to mention the `turn/interrupt` request.
- `README.md` — one-paragraph mention with a tiny example
  (`await instance.interrupt()`), explicitly noting the no-internal-
  timeout policy.
- Bump `package.json` to `3.1.0`.

## Verification

Automated:
- `npm run build` — clean tsc.
- `npm test` — all suites pass, including the new interrupt cases.
- `npm run lint` if defined in `package.json`; otherwise skip.

Manual smoke (caller-side; not part of CI, document in the PR
description):
- Start a long-running Claude turn (e.g. ask for a 5000-word essay),
  call `await instance.interrupt()`, then immediately
  `instance.sendMessage('shorter please')`. Confirm: no error event for
  the interrupt (the cancel landed before the turn finished —
  `subtype="error_during_execution"`), the second message gets a fresh
  response, `getSessionId()` is unchanged, `getTranscript()` shows the
  dangling user turn from the cancelled exchange followed by the new
  user/assistant pair. (If the turn happens to finish naturally during
  the cancel race, `getTranscript()` will additionally contain the
  late assistant turn — that is intentional and documented.)
- Repeat for Codex.
- Negative path A: call `interrupt()` while idle — promise rejects with
  `Not busy`, no destruction.
- Negative path B: start a turn, kill the child process externally
  (`kill -9 <pid>`) while `interrupt()` is awaited — promise rejects
  with the process-exit error, no hang.
