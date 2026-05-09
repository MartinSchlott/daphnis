# PLAN: Mumble callback

## Context & Goal

Today the only signal a Daphnis caller gets while a turn is in flight is
"nothing" until the final `'message'` event arrives. With slower models
this is indistinguishable from a hung child. Both CLIs already stream
intermediate output we currently discard:

- **Claude** (`--output-format stream-json --verbose`) emits
  `type: "assistant"` frames during a turn whose `message.content` is
  an Anthropic block array (`text`, `thinking`, `tool_use`, …). Today
  ignored in `claude-cli-wrapper.ts` (`case 'assistant'` → comment
  *"Intermediate verbose output — ignore in v1"*).
- **Codex** (`app-server` JSON-RPC) sends `item/agentMessage/delta`
  notifications carrying token-level text deltas. Today only buffered
  into `turnBuffer` for the final `'message'` event.

Goal: an opt-in side-channel called **Mumble**. The caller registers a
callback on an instance via `setMumble(cb)`. Whenever intermediate
generation arrives during a `busy` turn, Daphnis throttles the stream
to ≤ 1 emit / second and invokes the callback with a short opaque
text-tail and the elapsed milliseconds since the previous emit.

Design constraints (decided in discussion):

- **Opt-in via callback presence.** No event on the main
  `EventEmitter`. If `setMumble` is never called, no buffer is built,
  no timer is armed, no work is done.
- **Nothing configurable.** Throttle is hardcoded at 1000 ms. Sample
  length is hardcoded at 120 chars. No options on the call site.
- **Sample is opaque.** It is a tail snippet for human eyes only.
  Daphnis does not document how it is composed beyond "what looks
  like the model's in-progress output". Consumers must not parse it.
- **Asymmetry is acceptable.** Claude includes `thinking` blocks in
  the sample (when extended thinking is active); Codex has no
  equivalent. `tool_use` blocks are excluded on Claude — JSON arg
  payloads are noise, not mumble.
- **Mumble fires only while `state === 'busy'`.** No idle
  heartbeats, no final mumble at turn end (the `'message'` event
  fills that role). Setting `setMumble` mid-turn takes effect
  immediately for incoming frames; setting it to `undefined`
  cancels any pending throttle timer and stops emissions.

## Breaking Changes

**No.** Additive: a new optional method on `AIConversationInstance`,
a new exported type. Existing callers who never call `setMumble` see
zero behavioural change.

## Reference Patterns

- `setMeta(value)` / `getMeta<T>()` in
  `src/claude-cli-wrapper.ts:386-392` and
  `src/codex-cli-wrapper.ts:481-487` — same setter style as `setMumble`.
- The terminator-side state cleanup in
  `claude-cli-wrapper.ts:240-300` (`case 'result'`) and
  `codex-cli-wrapper.ts:353-411` (`case 'turn/completed'`) — mumble
  cleanup hooks into the same code paths.
- `src/__tests__/claude-cli-wrapper.test.ts` and
  `src/__tests__/codex-cli-wrapper.test.ts` for the existing
  `vi.mock('node:child_process')` + `PassThrough` test fixtures.
- `vitest`'s `vi.useFakeTimers()` for throttle-window assertions.

## Dependencies

None. Pure TypeScript inside existing modules.

## Assumptions & Risks

- **Claude `assistant`-frame shape.** We assume
  `msg.message.content` is an array of objects, each with a `type`
  field of `'text' | 'thinking' | 'tool_use' | …`. Text-blocks expose
  `.text: string`; thinking-blocks expose `.thinking: string` (per
  current Anthropic Messages API). The implementation must be
  defensive: unknown block types and missing string fields are
  silently skipped. A schema deviation only degrades mumble fidelity
  — it must not throw or break the main `'message'` channel.
- **Throttle correctness under bursts.** Codex deltas can arrive
  ~20–30/s. The throttle uses a single pending `setTimeout`; new
  frames during an active timer just update the buffer and do not
  schedule extra timers. Risk: if the test fixture fires deltas
  synchronously back-to-back and we do not advance fake timers, the
  test must assert "at most one emit" not "exactly one".
- **Listener throws.** A user callback that throws would propagate
  into the parser path and could destabilise the wrapper. The
  implementation wraps the call in `try/catch` and silently swallows
  — the mumble channel is best-effort, not a control plane.
- **Mid-turn registration.** When `setMumble(cb)` is called while
  busy, the buffer is empty (we did not collect retroactively).
  First emit happens on the next incoming frame. Acceptable.

## Steps

### 1. `src/types.ts` — public type surface

Add the callback type and extend `AIConversationInstance`:

```ts
export type MumbleCallback = (sample: string, msSinceLast: number) => void;

export interface AIConversationInstance
  extends EventEmitter<InstanceMessageEventMap> {
  // … existing members unchanged …

  /**
   * Register an opt-in side-channel for intermediate generation output.
   * The callback is invoked at most once per second while a turn is in
   * flight. `sample` is an opaque tail snippet (~120 chars) of what the
   * model is producing; do not parse it. `msSinceLast` is the elapsed
   * milliseconds since the previous mumble call on this instance, or
   * 0 for the first call of a turn.
   *
   * Pass `undefined` to disable. Setting mid-turn takes effect on the
   * next incoming frame.
   */
  setMumble(cb: MumbleCallback | undefined): void;
}
```

### 2. `src/index.ts` — re-export

Add `MumbleCallback` to the type re-exports.

### 3. Shared constants and helper

In **both** wrappers (no shared helper module — keeps each wrapper
self-contained, matches existing `ENV_BLACKLIST` duplication pattern):

```ts
const MUMBLE_THROTTLE_MS = 1000;
const MUMBLE_SAMPLE_CHARS = 120;
```

State on the wrapper class:

```ts
private mumbleCb: MumbleCallback | undefined;
private mumbleBuffer = '';
private mumbleLastEmitAt = 0;          // 0 means "no emit yet this turn"
private mumbleTimer: NodeJS.Timeout | null = null;
```

Helpers (private methods on the wrapper):

```ts
setMumble(cb: MumbleCallback | undefined): void {
  this.mumbleCb = cb;
  if (cb === undefined) {
    // Full reset on disable: a later re-enable mid-turn must not emit
    // stale text captured before the disable, and the throttle clock
    // restarts from "no emit yet this turn".
    if (this.mumbleTimer) {
      clearTimeout(this.mumbleTimer);
      this.mumbleTimer = null;
    }
    this.mumbleBuffer = '';
    this.mumbleLastEmitAt = 0;
  }
}

private mumbleAppend(text: string): void {
  if (!this.mumbleCb) return;
  if (text.length === 0) return;
  this.mumbleBuffer += text;
  this.scheduleMumble();
}

private scheduleMumble(): void {
  if (!this.mumbleCb) return;
  if (this.mumbleTimer) return;          // already scheduled
  let wait: number;
  if (this.mumbleLastEmitAt === 0) {
    // First emit of the turn: schedule a full throttle window into the
    // future so the buffer can fill. Otherwise we would emit on the very
    // first byte and degrade mumble into a token-stream.
    wait = MUMBLE_THROTTLE_MS;
  } else {
    const elapsed = Date.now() - this.mumbleLastEmitAt;
    wait = Math.max(0, MUMBLE_THROTTLE_MS - elapsed);
  }
  this.mumbleTimer = setTimeout(() => this.fireMumble(), wait);
}

private fireMumble(): void {
  this.mumbleTimer = null;
  const cb = this.mumbleCb;
  if (!cb) return;
  if (this.mumbleBuffer.length === 0) return;
  const sample = this.mumbleBuffer.slice(-MUMBLE_SAMPLE_CHARS);
  const msSinceLast = this.mumbleLastEmitAt === 0
    ? 0
    : Date.now() - this.mumbleLastEmitAt;
  this.mumbleLastEmitAt = Date.now();
  try { cb(sample, msSinceLast); } catch { /* swallow */ }
}

private mumbleResetTurn(): void {
  if (this.mumbleTimer) {
    clearTimeout(this.mumbleTimer);
    this.mumbleTimer = null;
  }
  this.mumbleBuffer = '';
  this.mumbleLastEmitAt = 0;
}
```

Note on the first-emit branch in `scheduleMumble`: on the first frame
of a turn (`mumbleLastEmitAt === 0`) we schedule the emit a full
`MUMBLE_THROTTLE_MS` into the future. This gives the buffer time to
fill and prevents an emit-on-first-byte that would reduce mumble to a
token-stream. Second and subsequent emits use real elapsed time, so a
slow stream still gets ~1 Hz mumbles, not 0.

### 4. `src/claude-cli-wrapper.ts` — wire into parser

In `handleParsed`, replace the existing `case 'assistant'` no-op with:

```ts
case 'assistant': {
  if (!this.mumbleCb) break;
  if (getState(this.instanceId) !== 'busy') break;
  const message = (msg['message'] as Record<string, unknown> | undefined);
  const content = message?.['content'];
  if (!Array.isArray(content)) break;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const type = b['type'];
    if (type === 'text' && typeof b['text'] === 'string') {
      this.mumbleAppend(b['text']);
    } else if (type === 'thinking' && typeof b['thinking'] === 'string') {
      this.mumbleAppend(b['thinking']);
    }
    // tool_use, server_tool_use, redacted_thinking, etc. — skip
  }
  break;
}
```

In the `case 'result'` branch (terminator) — both the `interrupting`
sub-branch and the regular completion path — add `this.mumbleResetTurn()`
after the `transitionState(this.instanceId, 'ready')` call. (The `interrupting
+ isInterruptTerminator` early-return path also needs the reset before its
`return`.) Same for the natural-completion-during-cancel sub-branch.

In `destroy()` add `this.mumbleResetTurn()` after the state transition,
so a `destroy()` mid-turn clears the timer.

**Also reset on the `proc.on('exit')` path.** Claude's exit handler
transitions to `'exiting'` inline without calling `destroy()`, so a
mumble timer scheduled by an earlier `assistant`-frame would otherwise
fire after the child is gone. Add `this.mumbleResetTurn()` inside the
exit handler — placement: right after the `transitionState(...,
'exiting')` call (or at the top of the handler, since reset is
state-agnostic and idempotent). The same applies to the
`stdin.on('error')` and `proc.on('error')` paths in this wrapper, which
also bypass `destroy()` in some branches; call `mumbleResetTurn()` in
each before unregistering. (The reset is cheap and idempotent; calling
it on every teardown path is the simpler invariant than auditing which
ones eventually flow through `destroy()`.)

### 5. `src/codex-cli-wrapper.ts` — wire into notification handler

In `handleNotification`'s `case 'item/agentMessage/delta'` branch, after
`this.turnBuffer += delta;` add:

```ts
if (getState(this.instanceId) === 'busy') {
  this.mumbleAppend(delta);
}
```

The state gate is defensive symmetry with the existing late-terminator
guard on `turn/completed` (`codex-cli-wrapper.ts:359`): a late or
malformed `item/agentMessage/delta` arriving after teardown must not
schedule a mumble against a dead wrapper. `mumbleAppend` already gates
on `mumbleCb`; the state gate sits in front of it.

In `case 'turn/completed'` — both the `interrupting` sub-branch and
the regular completion path — add `this.mumbleResetTurn()` immediately
after `transitionState(this.instanceId, 'ready')`. Each `return`/end
of those sub-branches must have already reset.

In `tearDownChild(err)` add `this.mumbleResetTurn()` after the
`transitionState` (or near the existing `this.turnBuffer = ''` reset).
This covers `destroy()`, `proc.on('exit')`, and the error paths
uniformly.

### 6. Tests

**`src/__tests__/claude-cli-wrapper.test.ts`** — add a describe block
`Mumble`:

- `setMumble undefined → no callback fires` — push assistant frames
  with text content; no buffer growth visible (callback never set).
  Use a spy to confirm zero invocations.
- `text-block content reaches the callback` — set callback, push
  assistant frame with `text` block, advance fake timers by 1000 ms,
  assert callback invoked once with `sample` containing the text.
- `thinking-block content reaches the callback` — same, with
  `thinking` block.
- `tool_use blocks are skipped` — push only a `tool_use` block,
  advance timers, assert callback not invoked.
- `throttled to 1 Hz` — push 5 assistant frames in quick succession,
  advance timers by 1000 ms, assert callback invoked exactly once
  with sample being the tail of all concatenated text.
- `tail is at most 120 chars` — push a frame whose text exceeds 200
  chars, advance timers, assert sample length ≤ 120.
- `msSinceLast is 0 on first emit, ~1000 on second` — push, advance
  1000 ms, push, advance 1000 ms, assert two calls with
  `msSinceLast === 0` and `msSinceLast ≈ 1000`.
- `terminator clears pending timer` — push frame, advance 500 ms (no
  emit yet), push terminator `result`, advance 1000 ms, assert
  callback never fires for that turn.
- `mumble does not fire after destroy` — push frame, call `destroy()`,
  advance timers, assert callback not invoked.

**`src/__tests__/codex-cli-wrapper.test.ts`** — analogous suite using
`item/agentMessage/delta` notifications and `turn/completed` as
terminator. Same eight cases (skip the `thinking` and `tool_use` ones,
add a `bursting deltas → single mumble within 1 s` case).

**Fake-timer strategy.** The mumble logic reads `Date.now()` to compute
`msSinceLast` and the throttle window. If only `setTimeout`/
`clearTimeout` are faked, `Date.now()` keeps ticking in real time and
`msSinceLast` assertions become flaky.

Use `vi.useFakeTimers()` without a `toFake` restriction in the mumble
suites. Vitest's default fake-timer set faked `Date` (in addition to
the timer functions) advances in lockstep with `vi.advanceTimersByTime`,
which is exactly what the throttle assertions need. Pair with
`vi.setSystemTime(new Date(0))` at the start of the relevant tests to
fix a deterministic origin, and restore with
`vi.useRealTimers()` in `afterEach`.

Audit: this scope is wider than the surrounding test file's existing
fixtures use. Confirm none of the wrapper's other code paths exercised
by the mumble tests rely on real `Date` — at the time of writing only
`ConversationTurn.timestamp` does, and a fixed-origin `Date(0)`
timestamp on a turn object asserted only for shape (not for value)
remains valid. If a specific test combines a real-time assertion with a
mumble assertion, split it into two tests rather than mixing time
modes.

### 7. Docs

**`docs/definition.md`** — under *In scope*, add a bullet:

> - `setMumble(cb)` per instance — opt-in side-channel for
>   intermediate generation. The callback receives an opaque
>   ~120-char text tail and the milliseconds since the previous
>   emit. Throttled to ≤ 1 emit / second; fires only while the
>   instance is `busy`. Pass `undefined` to disable.

Also remove or soften the `Out of scope` line *"Intermediate
tool-use / reasoning events are not surfaced in v1"* — it is now
partially in scope (text + thinking, not tool-use, and only as an
opaque side-channel). Replace with a precise statement that
intermediate output is exposed only via `setMumble` as opaque
samples, not as structured events.

**`docs/architecture.md`** — under *Per-instance event surface*
(or in a new sibling subsection *Mumble side-channel*), document:

- Hardcoded constants: 1000 ms throttle, 120-char sample.
- Inclusion rules: Claude `text` + `thinking` blocks; Codex
  `item/agentMessage/delta` text. Claude `tool_use` excluded.
- Lifecycle: armed by `setMumble(cb)`, fires only during `busy`,
  resets at every `busy → ready` transition (terminator,
  interrupt, destroy).
- Listener-throw policy: swallowed.
- Asymmetry note: Codex deltas are token-grained; Claude blocks
  are coarser; consumers must not depend on cadence parity.
- Why it is not on the main `EventEmitter`: keeping it as a
  callback slot makes the "no listener → no work" guarantee
  trivially enforceable and avoids needing options on the
  options object.

### 8. Manual smoke test (Verification step, not implementation)

A short ad-hoc script under `examples/` is **not** required by this
plan and not added — the existing tests cover the contract, and the
caller-side script is one-off.

## Verification

1. **Build:** `npm run build` succeeds with no new TypeScript errors.
2. **Tests:** `npm test` passes, including the new mumble suites in
   both wrapper test files.
3. **Lint / type:** the project has no separate lint step; `tsc`
   strict mode in step 1 covers it.
4. **Manual sanity** (not gated, but should be performed before
   archiving): run a short Node REPL or one-file script that creates
   a Claude or Codex instance, calls `setMumble((s, ms) =>
   console.log('[mumble]', ms, JSON.stringify(s)))`, and sends a
   prompt that produces ≥ 5 s of output. Expected: ≥ 3 mumble lines
   with monotonic-ish `ms` values and human-readable `s` snippets.
   Then call `setMumble(undefined)` and a second `sendMessage` —
   expect zero mumble lines for that turn.
5. **No regression** in existing tests — particularly the
   interrupt and destroy paths in both wrappers, which now invoke
   `mumbleResetTurn` as part of their cleanup.

<plan_ready>docs/PLAN_mumble.md</plan_ready>
