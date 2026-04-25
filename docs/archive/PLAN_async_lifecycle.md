# PLAN: Async Lifecycle (green-field redesign)

## Context & Goal

Daphnis 4.0.0 (uncommitted in working tree) shipped a state machine
(`spawning | ready | busy | exiting`) but Claude's `spawning` window is
not externally observable: the constructor synchronously transitions to
`ready` before any `await` / event-loop turn can run. The state machine
is therefore half-real — `spawning → exiting` for spawn failures cannot
fire on Claude.

The fix is structural: **make the `spawning → ready` transition async
in every wrapper**, expose readiness via `inst.ready: Promise<void>`,
and replace the per-instance callback bag (`AIConversationHandlers`)
with a typed `EventEmitter` on the wrapper itself. A handful of
adjacent decisions (uniform `sendMessage: Promise<void>`, drop the
local state mirror, deferred `unregister`, `exitCode` on
`InstanceInfo`, `unregister` throws on non-`exiting` state) round out
the redesign so the lifecycle is uniform across providers and
self-consistent.

This is a green-field break. No migration, no compatibility shims.
Daphnis is internal-only at this point. Version bumps to **4.0.0**
(already set in `package.json` from the FAILED plan; this plan ships
the bump as one coherent commit).

The PREPLAN behind this plan is `docs/PREPLAN_async_lifecycle.md`. It
will be archived alongside this PLAN at completion.

## Breaking Changes

Yes. The entire public lifecycle surface changes.

### What breaks

1. `AIConversationHandlers` is **removed**. The `handlers` field on
   `AIConversationOptions` is removed. Constructors no longer accept a
   handlers bag.
2. `AIConversationInstance` is no longer a plain object literal. It is
   now an `EventEmitter` with a typed event map. The mutable callback
   fields (`onReady`, `onMessage`, `onConversation`, `onError`,
   `onExit`) are **removed**.
3. `inst.ready: Promise<void>` is the only readiness channel.
4. `inst.sendMessage(text): Promise<void>` is uniformly async. Claude's
   previous `void`-return-with-`onError` contract is gone.
5. `inst.state: InstanceState` is exposed as a getter (read-through to
   the registry).
6. `InstanceInfo` gains `exitCode: number | null` (null until child
   exits).
7. `instance:removed` is emitted on **actual proc exit**, not on
   `destroy()`. Between `destroy()` and proc exit, the entry stays in
   the registry with `state: 'exiting'`.
8. `unregister(id)` throws if the entry's state is not `'exiting'` at
   call time. This is a wrapper-bug surfacer, not a recoverable case.
9. `onExit(exitCode)` is gone. Consumers read `exitCode` from the
   `instance:removed` snapshot or subscribe to
   `instance:state-changed` for the `→ exiting` transition.

### What the Human must do

- Reset any consumer code that uses Daphnis. There are no consumers
  outside this repo at this point.
- After implementation: run `npm run build && npm test` — no manual
  reset of state, no env var changes, no DB.

### Recovery

The previous lifecycle is captured in
`docs/archive/PLAN_instance_state_machine_FAILED.md` and the working
tree before this PLAN starts. `git stash` / branch off if you want a
fallback.

## Reference Patterns

- `src/registry.ts` — current state machine + `transitionState`
  helper. Carries over almost unchanged. Only `unregister` tightens
  and `InstanceInfo` gains `exitCode`.
- `docs/archive/PLAN_instance_state_machine_FAILED.md` — for context
  on what the previous design intended; **do not re-read for
  implementation details**, this PLAN is self-contained.
- `docs/archive/PLAN_daphnis_lifecycle_events.md` — invariants that
  carry over: snapshot-before-delete, forward-only / no-replay,
  handler exceptions don't kill the wrapper.

## Dependencies

None. Pure refactor within the existing `node:events`-based code.

## Assumptions & Risks

### Assumptions

1. `node:child_process.spawn` returns synchronously even on failure;
   `'error'` events fire on `process.nextTick`. We schedule the
   deferred `spawning → ready` transition via **`setImmediate`** (not
   `queueMicrotask`). `setImmediate` runs in the check phase of the
   event loop, **after** the nextTick queue *and* the microtask queue
   have drained. This guarantees that any nextTick-emitted spawn
   `'error'` (ENOENT and friends) fires before our deferred ready,
   independent of caller context (top-level await, async function,
   sync caller). The `if (state === 'spawning')` guard then
   self-cancels the ready transition. `queueMicrotask` would not be
   sufficient: in caller contexts where an `await` checkpoint sits
   between `createAIConversation()` returning and the listener
   attachment, microtask drain ordering vs. nextTick drain ordering
   is not the deterministic "nextTicks first" contract one might
   expect across Node versions and ESM top-level execution.
2. `EventEmitter<T>` from `@types/node@^22` supports class extension
   with a typed event map (already used by `instanceEvents`).
3. The mocked `child_process` in tests can drive both the
   `setImmediate`-deferred ready and the spawn-failure paths
   deterministically. Vitest exposes `vi.useFakeTimers({ toFake:
   ['setImmediate'] })` + `await vi.runAllTimersAsync()` (or
   `vi.advanceTimersToNextTimer()`) for `setImmediate` flushing.
   Real timers + a single `await new Promise(r => setImmediate(r))`
   also work where no other timing is mocked.

### Risks

1. **Codex `initialize()` race.** The Codex constructor calls
   `this.initialize()` (async) without awaiting. Today, `initialize()`
   resolves the wrapper's readiness via `onReady()`. New design:
   `initialize()` resolves/rejects the `ready` deferred. If the child
   dies during initialization, `tearDownChild` already rejects pending
   JSON-RPC promises, which propagates through the `await` in
   `initialize()` and rejects `ready`. **Mitigation**: keep
   `initialize()`'s try/catch but route the catch to ready-reject +
   `transition→exiting`, not `onError`+`destroy`.

6. **`'exit'` not guaranteed after `'error'`.** Node's
   `child_process` docs explicitly state that `'exit'` may or may not
   fire after an `'error'` event; ENOENT spawn-failures are the
   classic case where only `'error'` arrives. Routing `unregister`
   exclusively through `proc.on('exit')` would leak entries into
   `listInstances()` forever as `state: 'exiting'` zombies.
   **Mitigation**: every terminal handler (`proc.on('error')`,
   `stdin.on('error')`, `proc.on('exit')`) ends with
   `unregister(this.instanceId)`. First-fires-wins; subsequent calls
   hit the "unknown id" silent no-op. `setExitCodeFor` is only
   called from `proc.on('exit')`, so spawn-failure
   `instance:removed` snapshots carry `exitCode: null` (correct —
   no real exit code).

2. **EventEmitter `'error'` crash.** Node's `EventEmitter` throws if
   `'error'` is emitted without a listener. **Mitigation**: do not
   emit `'error'` while `state === 'spawning'` — spawn failures
   surface via `inst.ready` rejection only. Document that consumers
   who care about post-ready errors must attach `'error'` listeners
   synchronously before the first `sendMessage`.

3. **Test rewrite scope.** Existing tests rely on the callback bag
   and synchronous ready. A large fraction will be rewritten, not
   patched. **Mitigation**: budget Step 6 explicitly for test
   rewrite. No skipped tests.

4. **Deferred unregister window.** `destroy()` no longer removes the
   entry instantly. A consumer that calls `destroy()` and then
   immediately calls `listInstances()` will still see the entry with
   `state: 'exiting'`. **Mitigation**: this is the correct behavior;
   document it in `architecture.md`.

5. **Listener ordering for `instance:state-changed` and
   `instance:ready`.** Both fire during the same
   `transitionState` call, in the order `state-changed → ready`.
   This is preserved.

## Steps

### Step 1 — Registry: extend `InstanceInfo`, tighten `unregister`, add `getState`

File: `src/registry.ts`

1. Add `exitCode: number | null` to `InstanceInfo` and
   `RegistryEntry`. Initialize to `null` in `register`. Include in
   `buildInfo`.
2. Add a setter helper `setExitCodeFor(id: string, code: number |
   null): void`. No event — `exitCode` is folded into the
   `instance:removed` snapshot when `unregister` runs.
3. Add `getState(id: string): InstanceState`. If the entry is gone,
   return `'exiting'` (terminal fallback — once removed, the wrapper
   is effectively dead).
4. Tighten `unregister(id)`: if the entry exists and `entry.state !==
   'exiting'`, **throw** `new Error('unregister called with state
   ${entry.state}; must be exiting')`. Unknown id remains a silent
   no-op (idempotent at the entry level).
5. Export `getState` and `setExitCodeFor` from the module. Do **not**
   re-export from `src/index.ts` — they are internal.

### Step 2 — Types: drop handlers, restructure `AIConversationInstance`

File: `src/types.ts`

1. Remove the `AIConversationHandlers` interface entirely.
2. Remove the `handlers` field from `AIConversationOptions`.
3. Replace the `AIConversationInstance` interface with the new shape.
   The new instance extends `EventEmitter<InstanceMessageEventMap>`.
   Define the event map alongside the interface:

   ```ts
   import type { EventEmitter } from 'node:events';
   import type { InstanceState } from './registry.js';

   export interface InstanceMessageEventMap {
     message:      [text: string];
     conversation: [turn: ConversationTurn];
     error:        [err: Error];
   }

   export interface AIConversationInstance
     extends EventEmitter<InstanceMessageEventMap> {
     readonly ready: Promise<void>;
     readonly state: InstanceState;

     sendMessage(text: string): Promise<void>;
     interrupt(): Promise<void>;
     destroy(): void;

     getTranscript(): Promise<ConversationTurn[]>;
     getSessionId(): string | null;
     getPid(): number;
     getInstanceId(): string;
     setMeta(value: unknown): void;
     getMeta<T = unknown>(): T | undefined;
   }
   ```

   The `interrupt()` JSDoc block from the previous interface carries
   over verbatim.

### Step 3 — Claude wrapper: EventEmitter, async ready, async sendMessage

File: `src/claude-cli-wrapper.ts`

1. Import `EventEmitter` from `node:events`. Make the class extend
   `EventEmitter<InstanceMessageEventMap>`. Call `super()` first in
   the constructor.
2. Remove the constructor's `handlers` parameter. Remove the five
   mutable callback fields (`onReady`, `onExit`, `onError`,
   `onMessage`, `onConversation`).
3. Remove the private `state: InstanceState` field. Add a `get state():
   InstanceState` getter that returns `getState(this.instanceId)`.
4. Remove the private `transitionTo` helper. Use `transitionState(id,
   next)` directly from the registry — there is no local mirror to
   keep in sync.
5. Add `ready: Promise<void>` as a public readonly field. Create it
   in the constructor with the deferred pattern:

   ```ts
   let resolveReady!: () => void;
   let rejectReady!: (err: Error) => void;
   this.ready = new Promise<void>((resolve, reject) => {
     resolveReady = resolve;
     rejectReady = reject;
   });
   // Swallow unhandled-rejection if no one awaits ready.
   this.ready.catch(() => {});
   ```

   Store `resolveReady` / `rejectReady` as private fields for use in
   the spawn flow.

6. **Async ready transition.** After `register(...)`, schedule the
   `spawning → ready` transition via **`setImmediate`** (chosen over
   `queueMicrotask` for hard ordering against `process.nextTick`-emitted
   spawn errors — see §Assumptions):

   ```ts
   setImmediate(() => {
     if (getState(this.instanceId) === 'spawning') {
       transitionState(this.instanceId, 'ready');
       this.resolveReady();
     }
     // else: spawn failure beat us, ready was already rejected.
   });
   ```

7. **Spawn failure path.** In `proc.on('error')` and `stdin.on('error')`
   and `proc.on('exit')`, do:
   - reject pending control / interrupt with the error
   - if `state === 'spawning'`: `rejectReady(err)` then
     `transitionState(id, 'exiting')`
   - else if `state === 'busy'`: emit `'error'` event (only `proc.on('exit')`
     also calls `destroy()`; the error / stdin-error handlers always
     call `destroy()` to ensure the child is killed)
   - if state is not yet `'exiting'`, transition to `'exiting'`
   - **do not** emit `'error'` while `state === 'spawning'`
   - call `setExitCodeFor(this.instanceId, code)` only in
     `proc.on('exit')` (the error handlers have no exit code)
   - call `unregister(this.instanceId)` at the **end** of every
     terminal handler (`proc.on('error')`, `stdin.on('error')`,
     `proc.on('exit')`). Per Node, `'exit'` is **not** guaranteed
     after `'error'` (notably for ENOENT spawn-failures), so a
     belt-and-suspenders approach is required: whichever fires first
     unregisters; subsequent calls hit the silent "unknown id" no-op
     branch and fire no second `instance:removed`. Spawn-failure
     `instance:removed` snapshots will carry `exitCode: null`; that
     is correct (no real exit code exists).

   Concretely the new `proc.on('exit')` body:

   ```ts
   this.proc.on('exit', (code) => {
     const detail = this.stderrBuffer.trim();
     const exitMessage = detail
       ? `Process exited with code ${code}: ${detail}`
       : `Process exited with code ${code}`;
     const exitError = new Error(exitMessage);

     this.rejectPendingControl(exitError);
     this.failPendingInterrupt(exitError);

     const cur = getState(this.instanceId);
     if (cur === 'spawning') {
       this.rejectReady(exitError);
     } else if (cur === 'busy') {
       this.safeEmitError(exitError);
     }
     if (cur !== 'exiting') {
       transitionState(this.instanceId, 'exiting');
     }
     setExitCodeFor(this.instanceId, code);
     unregister(this.instanceId);
   });
   ```

   And `proc.on('error')`:

   ```ts
   this.proc.on('error', (err) => {
     this.rejectPendingControl(err);
     this.failPendingInterrupt(err);
     const cur = getState(this.instanceId);
     if (cur === 'spawning') {
       this.rejectReady(err);
       if (cur !== 'exiting') transitionState(this.instanceId, 'exiting');
     } else {
       this.safeEmitError(err);
       this.destroy();
     }
     // Always unregister: 'exit' may not fire after 'error' (Node docs).
     // If exit does fire later, its unregister() is a silent no-op.
     unregister(this.instanceId);
   });
   ```

   The `proc.on('exit')` body (above) similarly ends with
   `unregister(this.instanceId)` — same idempotency contract; whichever
   fires first wins.

   Same shape for `stdin.on('error')`: handle state, then
   `destroy()`, then `unregister(this.instanceId)` at the end.

8. **`safeEmitError(err)`**: a private helper that emits `'error'`
   only if there is at least one listener
   (`this.listenerCount('error') > 0`). If there are no listeners,
   discard silently — a wrapper that has no error listener attached
   should not crash Node. (Default Node EventEmitter would throw.)

9. **`sendMessage` becomes async.** Signature: `async sendMessage(text:
   string): Promise<void>`. State checks return rejected promises
   (`throw new Error('Destroyed' | 'Already processing' | 'Not
   ready')`). On success, resolve when the stdin write callback
   confirms delivery; on write error, reject with the same error and
   transition `busy → ready` if still busy. The user turn is appended
   to history only when the write callback fires without error (same
   as today).

   The result-handling path (`handleParsed` `case 'result'`) replaces
   `this.onMessage(...)` / `this.onConversation(...)` with
   `this.emit('message', ...)` / `this.emit('conversation', ...)`.
   The error case in `handleParsed` calls `this.safeEmitError(err)`.

10. Remove the `onReady`, `onExit`, `onMessage`, `onError`,
    `onConversation` field declarations and their assignments in the
    constructor. Remove the `handlers?: AIConversationHandlers`
    constructor parameter.

11. The `interrupt()` body is unchanged in shape but reads state via
    `getState(...)` instead of `this.state`. The
    `'Destroyed'`/`'Not busy'`/`'Interrupt already in progress'`
    rejections stay byte-identical.

12. `destroy()`:
    ```ts
    destroy(): void {
      const cur = getState(this.instanceId);
      if (cur === 'exiting') return;
      transitionState(this.instanceId, 'exiting');

      const destroyedErr = new Error('Destroyed');
      this.rejectPendingControl(destroyedErr);
      this.failPendingInterrupt(destroyedErr);
      // If we are destroying mid-spawn, the ready promise must reject.
      if (cur === 'spawning') this.rejectReady(destroyedErr);

      try { this.proc.stdin!.end(); } catch { /* may be closed */ }
      setTimeout(() => {
        try { this.proc.kill(); } catch { /* may be dead */ }
      }, 3000);
      // unregister happens in proc.on('exit') — do NOT call here.
    }
    ```

### Step 4 — Codex wrapper: EventEmitter, ready promise, deferred unregister

File: `src/codex-cli-wrapper.ts`

1. Mirror Step 3 changes 1–5 (extend EventEmitter, drop handlers,
   drop local state, add `state` getter, `ready` deferred).
2. **`initialize()` resolves/rejects ready.** On the success path,
   after `this.threadId = threadResult.thread.id`, run
   `transitionState(id, 'ready')` then `this.resolveReady()`. On the
   catch (and note: like Step 3 §7, every terminal path must end with
   `unregister(id)` because Node's `'exit'` is not guaranteed after
   `'error'`):

   ```ts
   } catch (err) {
     const e = err instanceof Error ? err : new Error(String(err));
     const cur = getState(this.instanceId);
     if (cur === 'spawning') {
       this.rejectReady(e);
       if (cur !== 'exiting') transitionState(this.instanceId, 'exiting');
     } else {
       this.safeEmitError(e);
     }
     this.destroy();
     // destroy() does not unregister synchronously; if proc.on('exit')
     // never fires (e.g. handshake failure with the child still alive
     // but unresponsive — destroy will SIGKILL after 3s and exit will
     // arrive), unregister will eventually run. The error handlers below
     // also unregister defensively.
   }
   ```

3. **`tearDownChild` no longer unregisters.** It still transitions to
   `exiting` (idempotently) and rejects pendings + clears turn state.
   The `unregister` call moves out of `tearDownChild` and into each
   terminal handler individually, so the handler decides whether to
   call `setExitCodeFor` first (`proc.on('exit')`) or not (error
   paths).

4. **`proc.on('exit')`** body:

   ```ts
   this.proc.on('exit', (code) => {
     const exitMessage = `Process exited with code ${code}`;
     const exitError = new Error(exitMessage);
     const cur = getState(this.instanceId);
     const wasBusy = cur === 'busy';
     const wasSpawning = cur === 'spawning';

     this.tearDownChild(exitError);  // transitions → exiting if not already
     setExitCodeFor(this.instanceId, code);

     if (wasSpawning) {
       this.rejectReady(exitError);
     } else if (wasBusy) {
       this.safeEmitError(exitError);
     }
     unregister(this.instanceId);
   });
   ```

5. **`proc.on('error')`** and **`stdin.on('error')`** call
   `tearDownChild(err)` then, depending on state at entry,
   reject-ready or `safeEmitError`. Call `destroy()` to ensure the
   child is killed if it isn't already. End the handler with
   `unregister(this.instanceId)` — Node does not guarantee `'exit'`
   after `'error'`, so error paths must self-unregister. The
   subsequent `proc.on('exit')` (if it fires) finds the entry already
   gone and its `unregister` call hits the silent no-op branch; no
   second `instance:removed`.

6. **`sendMessage` async.** Already async; just replace the
   `(this.state as InstanceState) === 'busy'` cast with
   `getState(this.instanceId) === 'busy'`. Replace `this.onError(...)`
   with `throw err` (uniform rejection — Q2 decision: error event is
   not doubled with sendMessage rejection). The user-turn / assistant-
   turn callbacks become `this.emit('conversation', ...)` /
   `this.emit('message', ...)`.

7. The `turn/completed` notification path (currently calls
   `this.onConversation` / `this.onMessage` / `this.onError`) becomes
   `this.emit('conversation', ...)` / `this.emit('message', ...)` /
   `this.safeEmitError(...)`.

8. `destroy()`:
   ```ts
   destroy(): void {
     if (this.terminationScheduled) return;
     this.terminationScheduled = true;
     const cur = getState(this.instanceId);
     if (cur !== 'exiting') {
       this.tearDownChild(new Error('Destroyed'));
     }
     if (cur === 'spawning') this.rejectReady(new Error('Destroyed'));
     try { this.proc.stdin!.end(); } catch { /* */ }
     setTimeout(() => {
       try { this.proc.kill(); } catch { /* */ }
     }, 3000);
   }
   ```

### Step 5 — Factory: drop handlers propagation

File: `src/factory.ts`

Remove `options.handlers` from the wrapper constructor calls. Both
constructors now take `(binary, cwd, id, systemPrompt, sessionId,
effort, model, env, fullAccess, extraArgs)` — one fewer parameter.

### Step 6 — Public API surface

File: `src/index.ts`

Update the export list to match D11 of the PREPLAN:

```ts
export type {
  AIConversationInstance,
  AIConversationOptions,
  ConversationTurn,
  Effort,
  InstanceMessageEventMap,
} from './types.js';
export { createAIConversation } from './factory.js';
export { runOneShotPrompt } from './one-shot.js';
export type { OneShotOptions, OneShotResult } from './one-shot.js';
export { listSessions } from './sessions.js';
export type { SessionInfo } from './sessions.js';
export { listInstances, getInstance, instanceEvents } from './registry.js';
export type { InstanceInfo, InstanceEventMap, InstanceState } from './registry.js';
```

Removed: `AIConversationHandlers`. Internal (not exported):
`getState`, `setExitCodeFor`, `transitionState`, `register`,
`unregister`, `setMetaFor`, `getMetaFor`, `__resetForTests`.

### Step 7 — Tests rewrite

Files: `src/__tests__/registry.test.ts`,
`src/__tests__/claude-cli-wrapper.test.ts`,
`src/__tests__/codex-cli-wrapper.test.ts`. Plus any other test files
that touch the wrappers.

Drive `__resetForTests` to also clear the entries map (it already
does). No new test infrastructure needed.

**Registry tests** — extend the existing suite:

- `register` initializes `exitCode` to `null`.
- `setExitCodeFor` updates the field; appears on the next
  `instance:removed` snapshot.
- `getState` returns the current state for a known id, returns
  `'exiting'` for an unknown id.
- `unregister` throws if state is not `'exiting'`. `unregister` for
  unknown id remains a silent no-op.
- Existing state-machine tests stay; the
  `"unregister payload reflects current state ('exiting' after a full
  lifecycle)"` test continues to work because callers now must
  transition to `'exiting'` first anyway.
- Update the `'instance:removed' fires on unregister with the final
  snapshot (after meta mutation)` test to first transition to
  `'exiting'` before calling `unregister`. Same for any other test
  that calls `unregister` directly.

**Claude wrapper tests** — substantial rewrite:

- Replace handler-bag construction with `inst.on('event', listener)`.
- Replace `await new Promise(r => handlers.onReady = r)` with
  `await inst.ready`.
- Add a `'spawn failure'` test: simulate `proc.emit('error', new
  Error('ENOENT'))` immediately after `createAIConversation` returns
  (synchronously in test). Assert: `inst.ready` rejects with that
  error, the `instance:state-changed` listener saw `spawning →
  exiting`, NO `instance:ready` event fired, NO `'error'` event
  fired on the wrapper (because state was `spawning`),
  `instance:removed` fired exactly once **without** simulating a
  subsequent `'exit'`, and `listInstances()` is empty afterwards.
- Add a `'spawn failure under await'` test: insert one or two `await
  Promise.resolve()` between `createAIConversation` and the
  `proc.emit('error', ...)` to drain microtasks. Assert that ready
  still rejects (verifies `setImmediate` wins over a microtask-drain
  window).
- Add a `'destroy during spawn'` test: call `inst.destroy()` before
  the deferred `setImmediate` fires (i.e. synchronously after
  `createAIConversation` returns, before any timer flush). Assert:
  `inst.ready` rejects with `'Destroyed'`, no `instance:ready`,
  eventual `instance:removed` once the simulated proc exits.
- Update `sendMessage` tests to `await` the promise. Error cases
  assert promise rejection (`expect(...).rejects.toThrow(...)`),
  not `onError` callback.
- `interrupt()` tests stay structurally the same.

**Codex wrapper tests** — same rewrite shape:

- Replace handler-bag with EventEmitter pattern.
- Spawn-failure test: drive `initialize()` to reject (e.g. by making
  the mock JSON-RPC `initialize` response be an error). Assert
  `inst.ready` rejects, `spawning → exiting` fires, no
  `instance:ready`.
- `tearDownChild` test: assert that on `proc.on('exit')`, the entry
  is unregistered exactly once and the `instance:removed` snapshot
  carries `exitCode`.
- `sendMessage` rejection wording stays.

**Don't drop tests.** If a test maps to a removed feature
(`onReady`/`onExit`/handlers bag) but covers a real behavior, port it
to the new surface. Only delete tests that are genuinely about the
old API shape with no behavioral analogue.

### Step 8 — Build, test, lint

Run `npm run build` then `npm test`. Both must pass clean. No
unhandled-rejection warnings, no `MaxListenersExceeded` warnings.

### Step 9 — Documentation

Files: `docs/definition.md`, `docs/architecture.md`, `README.md`.

This is a doc **rewrite** for the lifecycle and API sections, not a
patch.

- `definition.md` — update the API surface section to describe
  `inst.ready`, `inst.state`, the EventEmitter event map, async
  `sendMessage`. Remove all references to `AIConversationHandlers`,
  `onReady`/`onMessage`/`onError`/`onExit`.
- `architecture.md` —
  - Replace the data-flow paragraphs that say "Ready fires immediately
    on spawn" / "Ready only fires after `thread/start`" with the new
    `setImmediate`-deferred model: the `spawning → ready` transition
    is scheduled in the check phase of the event loop, **after** the
    nextTick and microtask drains, so any `process.nextTick`-emitted
    spawn `'error'` (ENOENT etc.) deterministically wins the race and
    rejects `inst.ready` instead. Note that `setImmediate` (not
    `queueMicrotask`) is the chosen primitive precisely for this
    ordering guarantee.
  - Document the `instance:removed` timing change: fires on actual
    proc exit (carries `exitCode`), or — when Node skips `'exit'`
    after a spawn `'error'` — on the error handler that
    self-unregisters with `exitCode: null`.
  - Document the `unregister`-throws invariant.
  - Document the `'error'`-event-without-listener policy
    (`safeEmitError`).
- `README.md` — sweep **all** handler / `onReady` / `onMessage` /
  `onError` / `onExit` / `onConversation` references, not just the
  opening example. Concrete touch-list (paths in the current README):
  - the tagline / intro paragraph that mentions "same callbacks"
  - the opening code example block (handlers bag → EventEmitter +
    `await inst.ready`)
  - the **What it does** section's "streams replies through
    `onMessage` / `onConversation` callbacks" wording → event
    subscriptions
  - the **Instance registry** paragraph that says "Deregistration is
    automatic: synchronous on `destroy()`, and before `onExit` fires"
    → describe the new model (deferred `unregister` until
    `proc.on('exit')`, error paths self-unregister, `instance:removed`
    carries `exitCode`)
  - the **Lifecycle events** paragraph and any subsequent code
    example referring to handlers
  - any other example block in the README that constructs an
    instance with `handlers: {…}` — replace with the new event-based
    pattern
  - any prose mentioning `onReady` / `onExit` semantics
  Verification: `grep -nE "handlers|onReady|onMessage|onError|onExit|onConversation" README.md`
  must return zero hits after the rewrite (apart from history-section
  text, which the README does not currently have).

### Step 10 — Backlog & archive

- `docs/backlog.kanban.md` — no change. The `instance:state-changed`
  card is already in Done from the FAILED plan.
- After validation passes, move both `docs/PLAN_async_lifecycle.md`
  and `docs/PREPLAN_async_lifecycle.md` to `docs/archive/`.

## Verification

### Build & tests

```sh
npm run build   # tsc clean, no errors, no warnings
npm test        # all green, no skipped tests
```

Expected count: ~230+ tests after rewrite (rough parity with the
current 229; some get dropped for removed handler-bag behavior, some
get added for the new spawn-failure / async-ready paths).

### Behavioral assertions captured by tests

Each must have a corresponding test:

1. **Claude spawn failure observable.** After
   `createAIConversation({ provider: 'claude' })` returns, an
   asynchronously-emitted `proc.emit('error', new Error('ENOENT'))`
   causes `inst.ready` to reject and `instance:state-changed` to fire
   with `(_, 'spawning', 'exiting')`. **NO** `instance:ready` fires.
   **NO** `'error'` event fires on the wrapper.
1a. **Spawn failure unregisters even without `proc.exit`.** Drive
    `proc.emit('error', new Error('ENOENT'))` and **do not** emit
    `'exit'`. Assert: `instance:removed` fires exactly once with
    `state: 'exiting'`, `exitCode: null`; `listInstances()` is empty
    afterwards. (Covers the Node "exit may not follow error" contract.)
1b. **`setImmediate` ordering is robust under awaits.** Test:
    `const inst = createAIConversation(...); await Promise.resolve();
    proc.emit('error', new Error('ENOENT'));` — the intervening
    microtask drain must not allow ready to win. `inst.ready` still
    rejects.
2. **Codex spawn failure observable.** Same shape, driven by an
   `initialize()` JSON-RPC error. Also assert that the registry is
   empty afterwards even if `'exit'` is not simulated.
3. **`inst.ready` resolves on success.** Both providers.
4. **`inst.state` reads through to registry.** Mutating the registry
   directly is reflected in `inst.state`.
5. **`sendMessage` rejection wording.** `'Destroyed'` first,
   `'Already processing'` second, `'Not ready'` third. Both providers.
6. **`'message'` and `'conversation'` events fire.** A subscriber
   attached after `await inst.ready` receives both.
7. **`'error'` without a listener does not crash.**
   `safeEmitError(new Error('x'))` with no `.on('error', ...)`
   attached is a no-op.
8. **`unregister` throws on non-`exiting` state.** Direct registry
   call.
9. **`instance:removed` carries `exitCode`.** After a normal proc
   exit, the snapshot has the actual code, not `null`.
10. **`destroy()` does not unregister synchronously.**
    `listInstances()` immediately after `destroy()` shows the entry
    with `state: 'exiting'`. Once the simulated proc exit fires,
    `instance:removed` is emitted and the entry is gone.
11. **`destroy()` during spawn rejects ready.** `inst.ready` rejects
    with `'Destroyed'`.
12. **`interrupt()` semantics unchanged.** All existing interrupt
    tests pass — wording and history-retention rules are preserved.
13. **`instance:state-changed` ordering.** Always fires before
    `instance:ready`; always fires before `instance:removed`.

### Manual smoke test (optional, only if mocks feel insufficient)

```ts
import { createAIConversation } from 'daphnis';
const inst = createAIConversation({ provider: 'claude', cwd: '/tmp' });
inst.on('message', (t) => console.log('msg:', t));
inst.on('error', (e) => console.error('err:', e));
await inst.ready;
await inst.sendMessage('hi');
await new Promise(r => setTimeout(r, 5000));
inst.destroy();
```

This is illustrative; tests cover the paths.

<plan_ready>docs/PLAN_async_lifecycle.md</plan_ready>
