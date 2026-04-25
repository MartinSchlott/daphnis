# PREPLAN: Async Lifecycle (green-field redesign)

## Status

Architect-authored design brief. Seeds the Coder's next Discussion phase
(CLAUDE.md §PREPLAN). The Coder may revise any decision below by raising
it in Discussion; "fixed" here means "current best understanding", not
"immutable".

## 1. Story so far — what failed and why

### Discussion (Phase 1)

The backlog card `rvsugmwcbnufknm1ap39le8t` requested an
`instance:state-changed` event. The card was parked behind an explicit
state machine (`spawning | ready | busy | exiting`). In Discussion the
Coder and Human agreed on:

- four states, no `interrupting` substate
- single source of truth (private `state` field per wrapper, mutated
  only via a `transitionTo` helper)
- `[info, prev, next]` payload, consistent with `instance:meta-changed`
- failure ordering: `state-changed → exiting` always fires before
  `instance:removed`
- `instance:ready` semantics unchanged: at most once per instance, on
  `spawning → ready`
- breaking change to `InstanceInfo` (gain a required `state` field) →
  major bump 3.2.0 → 4.0.0

### Plan (`PLAN_instance_state_machine_FAILED.md`)

The plan was written, reviewed, approved, and implemented end-to-end.
All 229 tests passed. The implementation is currently sitting
**uncommitted** in the working tree. Concretely shipped:

- `src/registry.ts` — `InstanceState` type, `LEGAL_TRANSITIONS` table,
  `state` field on `RegistryEntry` and `InstanceInfo`,
  `transitionState(id, next)` helper that emits
  `instance:state-changed` and folds the `instance:ready` emission for
  `spawning → ready`. `emitReady` removed.
- `src/claude-cli-wrapper.ts` — `ready`/`busy`/`destroyed` booleans
  replaced by `private state: InstanceState`, all mutations via
  `transitionTo`. Guard order in `sendMessage`/`interrupt` reordered
  (`exiting → busy → ready`).
- `src/codex-cli-wrapper.ts` — same refactor. `tearDownChild` performs
  the `→ exiting` transition + `unregister`. `destroy()` guarded by a
  separate `terminationScheduled` flag (process-level idempotency
  decoupled from lifecycle state).
- `src/index.ts` — `InstanceState` exported.
- `package.json` / `package-lock.json` — bumped to 4.0.0.
- Tests — 229 green, including new `state machine` blocks in registry,
  Claude, and Codex test files.
- Docs — `definition.md`, `architecture.md`, `README.md`,
  `backlog.kanban.md` (card moved to Done) updated.

### Validation — the finding

The Reviewer caught one Hoch finding plus one Mittel:

**Hoch — Claude spawn-failure contract not honoured.** The plan
required `proc.emit('error', ENOENT)` from Claude's `spawning` phase
to yield `state-changed(spawning → exiting)` with no
`instance:ready`. The implementation flips Claude to `ready`
synchronously at the end of the constructor, so by the time any real
or simulated `proc.on('error')` fires, state is already `'ready'` and
the only possible path is `ready → exiting`. The matching Claude test
was silently dropped from the validation block.

**Mittel — stale boolean wording in docs.** Several doc references
to `busy = false`, `destroyed = true`, and "transitions to
`ready=true`" survived the Step 7 sweep. Fixed in-place during
validation.

### The contradiction in the FAILED plan

The plan contained two incompatible statements about Claude:

1. **§Reference Patterns:** "Claude wrapper — three transition points
   (constructor → `ready`; …)" — i.e. ready is set **synchronously**
   inside the constructor.
2. **Step 6 / line 516–519:** "`proc.emit('error', ENOENT)` from
   `spawning` emits `state-changed(spawning → exiting)` …" — i.e. state
   must still be **`spawning`** when the error event arrives.

Node `child_process.spawn` returns synchronously even on failure; the
`'error'` event is emitted on a later tick (`process.nextTick`). The
constructor therefore always finishes — running `register()` then
`transitionTo('ready')` — *before* any real ENOENT event can fire. The
`'spawning'` window is **not observable from outside the constructor**.
Two mental models — Codex's genuine async handshake and Claude's
synchronous ready — were stacked onto a single state machine without
verifying that `spawning` was actually observable in both.

The Plan-Reviewer who approved the plan did not catch the contradiction
either. Both lines were read independently; they were never reconciled.

### Human decision

Option (b): green field. No migration concerns, no consumer
compatibility, no half-measures. Daphnis is internal-only at this
point — exploit that. Design the lifecycle the way it should have been
designed from the start, and let the new PLAN ship 4.0.0 as a real
break.

## 2. Working-tree status (as of this PREPLAN)

The implementation from the FAILED plan is still uncommitted. The new
Coder will inherit a working tree that:

- builds clean (`npm run build`)
- passes 229 tests (`npm test`)
- matches `4.0.0` in `package.json` and `package-lock.json`
- ships a half-correct state machine (the `spawning` state exists in
  types but is not externally observable for Claude)

The Coder's first job is to decide whether to **build on this** (keep
the registry types and the basic `transitionState` helper, layer the
async-ready redesign on top) or **revert and restart**. The PREPLAN
recommends the former — see §6.

## 3. Green-field design

### D1 — `spawning` is always externally observable

The state machine is only worth having if every state in it is
observable from outside the wrapper. Claude's synchronous-ready design
makes `spawning` invisible. The fix: **defer the
`spawning → ready` transition by at least one microtask in every
wrapper**. Claude joins Codex in genuine async-ready land. The
spawning window is short for Claude (a single microtask) and longer
for Codex (the handshake), but in both cases any subscriber attached
synchronously after `createAIConversation()` returns can observe it.

Consequence: an async ENOENT for Claude — which arrives via
`process.nextTick` — has a real chance of beating the `spawning →
ready` microtask, and the deferred ready transition is guarded with
`if (state === 'spawning')` so it self-cancels when the error path
already moved state to `exiting`.

### D2 — `createAIConversation()` returns a sync handle, ready is async

```ts
const inst = createAIConversation({ provider: 'claude', cwd: '...' });
// inst.state === 'spawning'
// inst.id is already known
// instanceEvents has already fired 'instance:added'

await inst.ready;
// inst.state === 'ready' (or threw, if spawn failed)

await inst.sendMessage('hi');
```

`inst.ready: Promise<void>` resolves on the `spawning → ready`
transition and rejects with the same error that drove
`spawning → exiting` if the wrapper dies during spawn. The promise is
created synchronously inside the constructor, so attaching `.then` /
`.catch` / `await` is always safe.

### D3 — One uniform async surface for `sendMessage`

Currently Claude's `sendMessage` returns `void` and reports errors
through `onError`; Codex's `sendMessage` is `async`. This is a leak
of the underlying transports. Green field: **both providers expose
`sendMessage(text: string): Promise<void>`**, both reject if state is
not `'ready'`, both resolve when the user turn is durably written.

`interrupt()` already returns `Promise<void>` and stays.
`destroy()` stays synchronous and idempotent — it is "I don't want
this anymore", not "do work".

### D4 — Per-instance EventEmitter, drop the handlers bag

Today the API has two parallel reception channels:

- `AIConversationHandlers` — a callback bag (`onReady`, `onMessage`,
  `onConversation`, `onError`, `onExit`) passed at construction
- `instanceEvents` — a registry-wide `EventEmitter` for lifecycle

The handlers bag is set-once, per-instance, can't be unsubscribed, and
duplicates events that already exist on the registry side. Green
field: **the wrapper instance itself is an `EventEmitter`** with a
typed event map:

```ts
interface InstanceEventMap {
  message:      [text: string];                      // assistant final text
  conversation: [turn: ConversationTurn];            // both user and assistant
  error:        [err: Error];                        // anything that's not a turn-failure rejection
}
```

`onReady` is replaced by `await inst.ready`. `onExit` is replaced by
the registry-wide `instance:removed` event (which already carries
`InstanceInfo`; we add `exitCode` to the snapshot for the kill path).
`onError` becomes `inst.on('error', …)`. `onMessage` /
`onConversation` become `inst.on('message', …)` / `inst.on('conversation', …)`.

The `AIConversationHandlers` interface is removed entirely. The
`AIConversationOptions.handlers` field is removed.

### D5 — Wrapper holds no local state mirror

The FAILED plan introduced `private state: InstanceState` on each
wrapper and a `transitionTo` helper that updated both the registry and
the local mirror. This was necessary because TS narrowing of
`this.state` after early returns conflicted with later state checks
(forced an `as InstanceState` cast in Codex's `sendMessage` catch).

Green field: **the registry is the single source of truth**. The
wrapper queries `getState(id)` whenever it needs to read state. No
local mirror, no narrowing problem, no cast. The wrapper still owns
the *transition decisions* (when to go busy, when to go ready), but it
does not store the state.

### D6 — Failure ordering is a hard registry invariant

Every path that ends an instance — `destroy()`, `proc.on('exit')`,
`proc.on('error')`, `stdin.on('error')`, Codex handshake failure —
must:

1. Transition to `exiting` (via `transitionState(id, 'exiting')`).
2. Then `unregister(id)`.

`unregister` enforces the invariant defensively: if the entry's state
is not `'exiting'` at unregister time, throw — this is a wrapper bug,
not a recoverable case. The previous design treated it as "build
snapshot as-is and rely on tests to catch the missing transition".
Green field tightens it: the throw surfaces the bug at the source.

### D7 — `instance:ready` is not redundant with `state-changed`

The `instance:ready` event remains, even though it is strictly a
filter on `instance:state-changed` (`prev === 'spawning' && next ===
'ready'`). Reason: it is the most-asked-for filter ("is this instance
usable yet?") and dropping it would force every consumer to re-derive
it. Keep it. The mutator (`transitionState`) is internal; the event
is consumer-visible.

### D8 — Initial state on `register`

The registry assigns `state: 'spawning'` on `register`. Wrappers do
not pass it. They cannot pass anything else — there is no legitimate
case for an instance to enter the registry already-ready.

### D9 — `interrupt()` does not change state

Stays `busy` throughout the cancel race. Same as the FAILED plan;
this decision survives unchanged.

### D10 — `sendMessage` rejects, does not queue

If state is not `'ready'`, `sendMessage` returns a rejected promise.
No queueing. Queueing hides the real error (`'Destroyed'` vs
`'Already processing'` vs `'Not ready'`) and adds an implicit
ordering guarantee the wrapper cannot keep across child crashes.

Guard order remains: `exiting` first (→ `'Destroyed'`), `busy` second
(→ `'Already processing'`), then anything-else (→ `'Not ready'`).

### D11 — Public API surface

After the green-field PLAN ships, `src/index.ts` re-exports exactly:

- `createAIConversation`
- `AIConversationInstance`, `AIConversationOptions`
- `ConversationTurn`, `Effort`
- `InstanceMessageEventMap` (the per-instance event map)
- `runOneShotPrompt`, `OneShotOptions`, `OneShotResult`
- `listSessions`, `SessionInfo`
- `listInstances`, `getInstance`, `instanceEvents`
- `InstanceInfo`, `InstanceEventMap`, `InstanceState`

Removed: `AIConversationHandlers`. Internal: `transitionState`,
`register`, `unregister`, `setMetaFor`, `getMetaFor`,
`__resetForTests`.

## 4. Open questions for the Coder's Discussion phase

These are explicitly **not decided**. The Coder should raise them
with the Human:

- **Q1 — Promise vs lazy property for `inst.ready`?** A property
  (`inst.ready: Promise<void>`) is one less call, but creates a
  promise eagerly even when no one awaits it (unhandled-rejection
  noise on spawn failure). A method (`inst.ready(): Promise<void>`)
  delays creation but is marginally less ergonomic. Recommendation:
  property, with internal `.catch(() => {})` guard against
  unhandled-rejection if no one attached by the time `exiting` fires.

- **Q2 — Should the per-instance `error` event also receive
  `sendMessage` rejections?** Currently in the FAILED design,
  `sendMessage` errors fire `onError`. If `sendMessage` returns a
  Promise that rejects, do we *also* fire the `error` event? Doubling
  is confusing; not doubling means subscribers who don't await
  `sendMessage` miss errors. Recommendation: do NOT double. Promise
  rejection is the canonical channel for `sendMessage` errors. The
  `error` event covers parser errors, child crashes, stdin pipe
  failures — things that have no callsite to reject.

- **Q3 — Add `exitCode` to `InstanceInfo`?** The FAILED design lost
  `onExit(code)` access by routing exit through `instance:removed`,
  but `InstanceInfo` does not carry an `exitCode` field. Add it as
  `exitCode: number | null` (null until the child has exited;
  populated on the `instance:removed` snapshot). Or keep
  `instance:removed` lifecycle-only and emit exit through a new
  `instance:exited` event with `[info, code]`. Recommendation: add
  to `InstanceInfo`. One snapshot type, fewer events.

- **Q4 — Replace the registry-side `instanceEvents` with a single
  emitter strategy?** Today's split — per-instance EventEmitter for
  message/error, registry EventEmitter for lifecycle — is two
  patterns. We could route everything through the registry emitter
  with `id`-keyed payloads. Recommendation: keep the split. Per-
  instance subscription is the natural pattern for "I just spawned
  this, give me its messages"; registry subscription is the natural
  pattern for "show me all instances".

- **Q5 — Drop the local state mirror, or keep it as a perf cache?**
  D5 above prefers the registry-only approach. The cost is a `Map`
  lookup on every state read. If hot-path reads are a concern (e.g.
  in `handleParsed`), a private cache invalidated on `transitionTo`
  could be added. Recommendation: drop it; measure later if it
  hurts.

- **Q6 — One-shot affected?** `runOneShotPrompt` does not use the
  instance handle today (it spawns its own child). It is unaffected
  by D2/D3/D4. Confirmed scope: green-field PLAN does not touch
  one-shot.

## 5. Plan boundaries (in / out for the next PLAN)

**In scope:**

- Defer Claude's `spawning → ready` to a microtask, with self-cancel
  guard if state already moved to `exiting`.
- Drop `AIConversationHandlers` and the `handlers` constructor option.
- Make every wrapper instance an `EventEmitter` with a typed map.
- `inst.ready: Promise<void>`.
- Uniform `sendMessage(text): Promise<void>` (Claude becomes async).
- Drop the wrapper-local `state` mirror; read through registry.
- Tighten `unregister` to throw on non-`exiting` state at call time.
- Add `exitCode: number | null` to `InstanceInfo` (per Q3 default).
- Update all docs and tests.

**Out of scope:**

- One-shot flow changes.
- Session resume / `getTranscript()` semantics.
- Effort/model/fullAccess/extraArgs surface.
- Any new feature beyond what is needed to fix the lifecycle.
- Backwards-compatibility shims, migration helpers, or deprecation
  warnings. Green field — break cleanly.

## 6. Recommended approach for the Coder

1. **Do not revert the FAILED-plan changes.** They got the registry
   types and the `transitionState` helper right; those carry over
   unchanged. Reverting and re-doing them would be busywork and risk
   regressions.

2. **Layer the async-ready redesign on top.** Specifically:
   - Wrap `transitionTo('ready')` in `queueMicrotask` for Claude (with
     `if (state === 'spawning')` self-cancel).
   - Convert `AIConversationInstance` into an `EventEmitter` subclass.
   - Remove `handlers` and the five `on*` callback fields.
   - Add `ready: Promise<void>`.
   - Convert Claude's `sendMessage` to async.
   - Drop the local `state` field; expose `inst.state` as a getter
     that reads the registry.
   - Tighten `unregister` (throw on non-`exiting`).
   - Add `exitCode` to `InstanceInfo`; emit on the same
     `instance:removed` snapshot.

3. **Test rewrite, not extension.** The current test suite leans
   heavily on the synchronous-ready and callback-bag patterns; many
   tests will need rewriting, not just adding. Budget for it.

4. **Doc rewrite, not edit.** README and architecture sections about
   lifecycle / handlers / synchronous ready will need replacement,
   not patching. Doc-update is its own substantial step.

## 7. Affected files (preview, not exhaustive)

- `src/types.ts` — drop `AIConversationHandlers`, restructure
  `AIConversationInstance` interface.
- `src/registry.ts` — minor: tighten `unregister`; add `exitCode` to
  `InstanceInfo`.
- `src/claude-cli-wrapper.ts` — extends `EventEmitter`, async `sendMessage`,
  microtask-deferred ready, no local state, no handlers.
- `src/codex-cli-wrapper.ts` — extends `EventEmitter`, no local state,
  no handlers; `sendMessage` already async.
- `src/factory.ts` — drop `handlers` option propagation.
- `src/one-shot.ts` — no change (out of scope).
- `src/__tests__/*.ts` — substantial rewrites for callback → event
  migration and async-ready timing.
- `docs/definition.md`, `docs/architecture.md`, `README.md` —
  rewritten lifecycle and API sections.
- `docs/backlog.kanban.md` — no change beyond what FAILED plan
  already did.

## 8. Naming for the resulting PLAN

`docs/PLAN_async_lifecycle.md` (per CLAUDE.md §PREPLAN: same suffix
as the PREPLAN). Archive both PREPLAN and PLAN to
`docs/archive/` together when the PLAN completes.

## 9. References

- `docs/archive/PLAN_instance_state_machine_FAILED.md` — the failed
  plan, kept verbatim for postmortem reference.
- `docs/archive/PLAN_daphnis_lifecycle_events.md` — original
  lifecycle-events plan (3.x), source of the snapshot-before-delete
  invariant and the forward-only / no-replay rule. Both carry over
  unchanged.
- Backlog card `rvsugmwcbnufknm1ap39le8t` — already moved to Done by
  the FAILED plan. Body is current; needs no further edit.
