# PLAN: Instance State Machine + `instance:state-changed` Event

Refs: backlog card `rvsugmwcbnufknm1ap39le8t` (`instance:state-changed event`,
column `Open` in `docs/backlog.kanban.md`).

## Context & Goal

Both wrappers (`ClaudeCLIWrapper`, `CodexCLIWrapper`) currently track lifecycle
through two independent boolean fields, `ready` and `busy`, plus a `destroyed`
flag. Mutations are scattered across the constructor, the `handleParsed` /
`handleNotification` paths, `sendMessage`, `interrupt`, `destroy`, and the
`proc.on('exit' | 'error')` handlers. There is no single source of truth for
"what state is this instance in?" and no way for a consumer to observe
transitions — `instance:ready` is the only lifecycle event today.

The backlog card asks for an `instance:state-changed` event but explicitly
parks the work until an explicit state machine exists. This plan does both:
introduce the state machine `spawning | ready | busy | exiting`, replace the
two booleans with a single `state` field, and emit `instance:state-changed`
on every transition.

**Decisions taken in Discussion (Phase 1):**

- **Zustandsmenge:** exactly four — `spawning | ready | busy | exiting`.
  No `interrupting` substate; `interrupt()` does not change state, the wrapper
  stays in `busy` throughout the cancel.
- **Failure ordering:** the final `state-changed → exiting` event fires
  **before** `instance:removed`. Subscribers see the full lifecycle even on
  ENOENT / handshake failure.
- **`InstanceInfo` shape:** a new `state: InstanceState` field is added.
  Halbe Wahrheit (event-only without snapshot exposure) is rejected. This is
  a breaking change to the public type.
- **Event payload:** tuple `[info, prev, next]`, consistent with
  `instance:meta-changed`'s `[info, prev]`. `info.state === next` is
  intentionally redundant.
- **`instance:ready` semantics:** unchanged. Fires at most once per instance,
  on the first `spawning → ready` transition. Subsequent `busy → ready`
  transitions emit `instance:state-changed` but **not** `instance:ready`.
- **Single source of truth:** each wrapper carries `private state:
  InstanceState`; mutations only through a `transitionTo(next)` helper that
  emits via the registry. The booleans `ready`, `busy`, and the `destroyed`
  flag are removed.
- **Illegal transitions throw.** Defensive wiring; silent ignore would re-
  introduce drift the state machine is meant to eliminate.

## Breaking Changes

**Yes.** Two breaking aspects, justifying a major bump (`3.2.0 → 4.0.0`):

1. **`InstanceInfo` gains a required `state: InstanceState` field.** Any
   consumer destructuring `InstanceInfo` and forwarding its shape (e.g. a
   wrapper layer that re-emits a typed projection) will see a TypeScript
   compile error. Runtime objects gain a property, so JS-only consumers
   that read existing fields are unaffected, but the published type
   declaration changes.
2. **`InstanceState` is a new public type** exported from `src/index.ts`.
   This is purely additive but counts as part of the public surface for
   future semver decisions.

What the Human must do: bump the dependency to `4.0.0` and, if any code
spreads or maps `InstanceInfo` into a custom shape, ensure the new `state`
field is handled. No DB resets, no env-var changes, no on-disk format
changes. No recovery steps needed beyond the version bump.

This must be confirmed by the Human at Approval (CLAUDE.md §Breaking Changes).

## Reference Patterns

- `src/registry.ts` — gains the state-machine helpers and the new event.
  The existing `register` / `unregister` / `setMetaFor` / `emitReady`
  pattern is the model for `transitionState`.
- `src/claude-cli-wrapper.ts` — three transition points (constructor →
  `ready`; `sendMessage` write → `busy`; `result` terminator → `ready`)
  plus three exiting paths (`destroy`, `proc.on('exit')`, `proc.on('error')`,
  `stdin.on('error')`).
- `src/codex-cli-wrapper.ts` — same three transition points (handshake →
  `ready`; `sendMessage` turn/start → `busy`; `turn/completed` → `ready`)
  plus the same exiting paths via `tearDownChild`.
- `src/__tests__/registry.test.ts` — new event tests follow the existing
  `instance:meta-changed` test shape: subscribe, mutate, assert payload.
- `src/__tests__/claude-cli-wrapper.test.ts` /
  `src/__tests__/codex-cli-wrapper.test.ts` — wrapper-level lifecycle
  tests (`construction emits added → state-changed → ready` etc.) follow
  the existing pattern in those files for verifying registry-side effects.
- The completed plan `docs/archive/PLAN_daphnis_lifecycle_events.md` is
  the canonical reference for how lifecycle events are wired through the
  registry, including the snapshot-before-delete invariant and the
  forward-only / no-replay rule. Both rules carry over unchanged.

## Dependencies

**None.** No new packages, no `npm install`, no `devDependencies` changes.
Only TypeScript edits to existing source files plus version bumps in
`package.json` and `package-lock.json`.

## Assumptions & Risks

- **Assumption:** the four states cover every meaningful lifecycle phase a
  consumer would react to. `interrupting` is intentionally not a state
  (Discussion decision); a consumer that needs to distinguish "cancel in
  flight" can still observe `interrupt()` directly via the returned
  promise.
- **Assumption:** `transitionTo(prev → prev)` (same-state self-transition)
  is a no-op, not an error. The wrapper's exit / error handlers may fire
  after `destroy()` already moved the state to `exiting`; treating that
  as illegal would force every handler to guard. A no-op is the correct
  default.
- **Risk — illegal transition during a crash race.** If `proc.on('error')`
  and `proc.on('exit')` both fire and both try to transition, the second
  one hits `exiting → exiting` (no-op, fine). If a hypothetical bug tries
  `busy → spawning`, the throw surfaces a real bug rather than silently
  proceeding. Mitigation: the throw is the desired behaviour; tests cover
  every legal transition; the registry's no-op short-circuit covers the
  legitimate idempotent path.
- **Risk — listener throws inside `state-changed` corrupt the wrapper.**
  Same risk as the existing `instance:ready` event. Node's
  `EventEmitter` propagates synchronous throws back to the emit site,
  which sits inside the Claude constructor / Codex async handshake /
  `sendMessage` / `result`-handler / `destroy()`. The README contract
  ("listeners must not throw") is extended to cover `state-changed`.
- **Risk — `instance:ready` semantics drift.** Folding the `instance:ready`
  emission into `transitionState` (when `prev === 'spawning' && next ===
  'ready'`) means one wrong condition would silently break the existing
  guarantee. Mitigation: a registry test asserts that `busy → ready`
  does NOT emit `instance:ready`, and that `spawning → ready` DOES.
- **Risk — race between local `state` mirror and registry entry state.**
  Mitigated by routing every transition through one method
  (`transitionTo` on the wrapper) which (a) calls `registry.transitionState`
  and only on success (b) updates the local `this.state` mirror. If the
  registry throws (illegal transition), the local mirror stays consistent
  with the registry; the throw surfaces the bug.
- **Risk — `package-lock.json` drift.** As in the previous lifecycle-events
  plan, the lock file's top-level and `packages[""]` `version` fields
  must both be updated by hand (no `npm install`, per Hard Rule 11).

## Steps

### Step 1 — Extend `src/registry.ts`

Add the state type, the legality table, the new event, the `state` field
on `RegistryEntry` and `InstanceInfo`, and the `transitionState` helper.
Remove `emitReady` (functionality folded into `transitionState`).

```typescript
export type InstanceState = 'spawning' | 'ready' | 'busy' | 'exiting';

const LEGAL_TRANSITIONS: Record<InstanceState, ReadonlySet<InstanceState>> = {
  spawning: new Set(['ready', 'exiting']),
  ready:    new Set(['busy', 'exiting']),
  busy:     new Set(['ready', 'exiting']),
  exiting:  new Set(),
};

export interface InstanceInfo {
  id: string;
  provider: 'claude' | 'codex';
  cwd: string;
  sessionId: string | null;
  pid: number;
  createdAt: Date;
  meta: unknown;
  state: InstanceState;          // NEW
}

export interface RegistryEntry {
  instance: AIConversationInstance;
  provider: 'claude' | 'codex';
  cwd: string;
  createdAt: Date;
  meta: unknown;
  state: InstanceState;          // NEW; initial 'spawning'
}

export interface InstanceEventMap {
  'instance:added':         [info: InstanceInfo];
  'instance:removed':       [info: InstanceInfo];
  'instance:ready':         [info: InstanceInfo];
  'instance:meta-changed':  [info: InstanceInfo, prev: unknown];
  'instance:state-changed': [info: InstanceInfo, prev: InstanceState, next: InstanceState]; // NEW
}
```

`buildInfo` includes `state: entry.state`. The `register` function takes
the existing `RegistryEntry`-shaped argument minus `state` (the registry
sets the initial state to `'spawning'`):

```typescript
export function register(entry: Omit<RegistryEntry, 'state'>): void {
  const id = entry.instance.getInstanceId();
  if (entries.has(id)) return;
  const full: RegistryEntry = { ...entry, state: 'spawning' };
  entries.set(id, full);
  instanceEvents.emit('instance:added', buildInfo(full));
}
```

`transitionState` is the new public helper:

```typescript
export function transitionState(id: string, next: InstanceState): void {
  const entry = entries.get(id);
  if (!entry) return;                        // unknown id → silent no-op
  const prev = entry.state;
  if (prev === next) return;                 // idempotent no-op
  if (!LEGAL_TRANSITIONS[prev].has(next)) {
    throw new Error(`Illegal state transition: ${prev} → ${next}`);
  }
  entry.state = next;
  const info = buildInfo(entry);
  instanceEvents.emit('instance:state-changed', info, prev, next);
  if (prev === 'spawning' && next === 'ready') {
    instanceEvents.emit('instance:ready', info);
  }
}
```

`emitReady` is **removed** from the registry's exports. The Claude and
Codex wrappers no longer import or call it.

`unregister` is unchanged in shape but its snapshot now naturally carries
`state: 'exiting'` because the wrapper transitions before calling it.
Defensive backstop: if `entry.state !== 'exiting'` at unregister time,
treat that as a wrapper bug — no auto-recovery, the snapshot is built
as-is and the test suite catches the missing transition. (Adding an
implicit fallback transition would mask bugs and contradict the "single
source of truth" decision.)

`__resetForTests` is unchanged (already calls
`instanceEvents.removeAllListeners()` from the previous lifecycle-events
plan).

### Step 2 — Refactor `src/claude-cli-wrapper.ts`

Remove `private ready = false;` (line 35), `private busy = false;` (line
36), and `private destroyed = false;` (line 37). Replace with:

```typescript
private state: InstanceState = 'spawning';
```

Add the import: `import { transitionState, register, unregister, setMetaFor, getMetaFor } from './registry.js';`
(drop `emitReady`).

Add a private helper:

```typescript
private transitionTo(next: InstanceState): void {
  const prev = this.state;
  transitionState(this.instanceId, next);   // throws on illegal
  this.state = next;
  // prev kept for parity with codex; not used here
  void prev;
}
```

Rationale for the helper: a single chokepoint makes accidental direct
assignment impossible during refactors, and it parallels the codex shape
where the local mirror is read on the hot path (`sendMessage` /
`interrupt` guards).

Map every existing mutation site to a `transitionTo` call:

| Site (current code) | Current mutation | New call |
|---|---|---|
| Constructor, end of body (line 174) | `this.ready = true; emitReady(...); this.onReady()` | `this.transitionTo('ready'); this.onReady()` |
| `proc.on('exit')` while busy (line 145–149) | `this.busy = false; this.onError(exitError); this.destroy();` | drop the `busy = false` line — `destroy()` will transition to `exiting`. Keep `this.onError(exitError); this.destroy();`. |
| `proc.on('exit')` after busy branch (line 150) | `unregister(this.instanceId);` | unchanged — `destroy()` already transitioned to `exiting` for the busy branch; for the not-busy branch, add `if (this.state !== 'exiting') this.transitionTo('exiting');` immediately before `unregister`. |
| `proc.on('error')` (line 154–159) | `... this.onError(err); this.destroy();` | unchanged — `destroy()` handles the transition. |
| `stdin.on('error')` (line 128–133) | `... this.onError(err); this.destroy();` | unchanged — `destroy()` handles the transition. |
| `sendMessage` write success (line 312) | `this.busy = true;` | `this.transitionTo('busy');` |
| `sendMessage` write callback error (line 315) | `this.busy = false;` | `if (this.state === 'busy') this.transitionTo('ready');` |
| `handleParsed` `result` terminator (line 218) | `this.busy = false;` | `this.transitionTo('ready');` (always — both natural-completion and interrupt paths land here, and both should return to ready before the callback fires) |
| `destroy()` (line 398–420) | `if (this.destroyed) return; unregister(...); this.destroyed = true; ...` | `if (this.state === 'exiting') return; this.transitionTo('exiting'); unregister(this.instanceId); ...` |

Replace every read of `this.ready` / `this.busy` / `this.destroyed`:

| Current | New |
|---|---|
| `if (!this.ready)` (line 292) | `if (this.state === 'spawning')` (the only non-ready non-exiting non-busy state at sendMessage time) — but to keep the existing error message semantically equivalent, use `if (this.state !== 'ready')` and let the destroyed-guard below catch the `exiting` case explicitly with the existing `'Destroyed'` error. Concretely: keep two separate checks, with the same string outputs as today: |
| | `if (this.state === 'exiting') { this.onError(new Error('Destroyed')); return; }` |
| | `if (this.state === 'busy') { this.onError(new Error('Already processing')); return; }` |
| | `if (this.state !== 'ready') { this.onError(new Error('Not ready')); return; }` |
| `if (this.busy)` (line 296) | folded into the block above |
| `if (this.destroyed)` (line 300) | folded into the block above |
| `if (this.busy)` (interrupt(), line 366) | `if (this.state !== 'busy') throw new Error('Not busy');` |
| `if (this.destroyed)` (interrupt(), line 365) | `if (this.state === 'exiting') throw new Error('Destroyed');` |

The order of checks in `sendMessage` matters: `exiting` must be tested
first (otherwise a destroyed wrapper that was previously busy would
return `'Already processing'`, which is misleading). The plan above
fixes the order at the same time as the refactor — this is an
intentional behavioural improvement, not a regression.

`interrupting`, `pendingControlRequests`, `busyClearedResolve`,
`busyClearedReject`, and the `destroy()` `setTimeout` cleanup are
unchanged.

### Step 3 — Refactor `src/codex-cli-wrapper.ts`

Same shape as Step 2, applied to the Codex wrapper, with one structural
adjustment: the `exiting` transition + `unregister` move **into**
`tearDownChild` (not into `destroy()`). This is required because
`stdin.on('error')` and `proc.on('error')` both call
`tearDownChild(err); ...; this.destroy();`. If `tearDownChild` performs
the transition and `destroy()` early-returns on `state === 'exiting'`,
those two paths would never reach `unregister` and the registry entry
would leak. By placing the transition+unregister inside `tearDownChild`,
the registry-side cleanup happens regardless of whether `destroy()`
runs to completion.

Remove `private ready = false;` (line 38), `private busy = false;` (line
39), `private destroyed = false;` (line 40). Add:

```typescript
private state: InstanceState = 'spawning';
private terminationScheduled = false;     // process-level kill idempotency
```

`terminationScheduled` is intentionally separate from `state`. `state`
is the lifecycle answer ("what phase is this instance in?");
`terminationScheduled` is the process-cleanup answer ("did we already
schedule the SIGTERM/kill timer?"). Conflating them with the same flag
breaks the stdin-error path (see above) — the wrapper may legitimately
need to schedule the kill timer **after** `state === 'exiting'` was set
by `tearDownChild`.

Adjust import: `import { transitionState, register, unregister, setMetaFor, getMetaFor } from './registry.js';`
(drop `emitReady`).

Add the same `transitionTo` helper as in the Claude wrapper.

Map every mutation site:

| Site (current code) | Current mutation | New call |
|---|---|---|
| `initialize()` after handshake (line 173) | `this.ready = true; emitReady(...); this.onReady();` | `this.transitionTo('ready'); this.onReady();` |
| `initialize()` catch block (line 176–179) | `this.onError(...); this.destroy();` | unchanged — `destroy()` calls `tearDownChild`, which performs the `spawning → exiting` transition + unregister. |
| `sendMessage` start (line 402) | `this.busy = true;` | `this.transitionTo('busy');` |
| `sendMessage` catch (line 429) | `this.busy = false;` | `if (this.state === 'busy') this.transitionTo('ready');` |
| `handleNotification` `turn/completed` (line 331) | `this.busy = false;` | `this.transitionTo('ready');` |
| `tearDownChild` (line 500–514) | reset live state | rewritten — see below |
| `proc.on('exit')` (line 125–136) | `tearDownChild(...); if (wasBusy) onError; unregister(...); onExit(code);` | drop the explicit `unregister` line — `tearDownChild` now handles it. Order becomes: `tearDownChild(exitError); if (wasBusy) onError; this.onExit(code);`. |
| `destroy()` (line 516–536) | `if (this.destroyed) return; unregister(...); this.destroyed = true; this.tearDownChild(...); stdin.end; setTimeout kill;` | rewritten — see below |

`tearDownChild` rewritten:

```typescript
private tearDownChild(err: Error): void {
  if (this.state !== 'exiting') {
    this.transitionTo('exiting');
    unregister(this.instanceId);
  }
  for (const [id, pending] of this.pendingRequests) {
    pending.reject(err);
    this.pendingRequests.delete(id);
  }
  if (this.busyClearedReject) {
    this.busyClearedReject(err);
  }
  this.busyClearedResolve = null;
  this.busyClearedReject = null;
  this.interrupting = false;
  this.currentTurnId = null;
  this.turnBuffer = '';
  // No more `this.busy = false;` — the transition replaced the boolean.
}
```

`destroy()` rewritten:

```typescript
destroy(): void {
  if (this.terminationScheduled) return;
  this.terminationScheduled = true;
  if (this.state !== 'exiting') {
    this.tearDownChild(new Error('Destroyed'));
  }
  try { this.proc.stdin!.end(); } catch { /* stdin may be closed */ }
  setTimeout(() => {
    try { this.proc.kill(); } catch { /* process may be dead */ }
  }, 3000);
}
```

This split has the properties:

- A standalone `destroy()` call (state was `ready`/`busy`) goes through
  `tearDownChild` (which transitions + unregisters), then schedules the
  kill timer. Idempotent on second call via `terminationScheduled`.
- `stdin.on('error')` / `proc.on('error')` flow:
  `tearDownChild(err) → onError(err) → destroy()`. By the time
  `destroy()` runs, `state === 'exiting'` and the entry is already
  unregistered, so the `if (this.state !== 'exiting')` guard skips the
  redundant `tearDownChild` call but **still** schedules the kill
  timer (because `terminationScheduled` was false). No leak.
- `proc.on('exit')` flow does not call `destroy()`; `tearDownChild` is
  called inline, which transitions + unregisters. The kill timer is
  unnecessary (the process already exited) and is correctly skipped.
- A second external `destroy()` call returns immediately via
  `terminationScheduled`, never re-emitting state events or scheduling
  a second kill.

Replace every guard:

| Current | New |
|---|---|
| `if (!this.ready)` (line 389) | `if (this.state === 'exiting') { this.onError(new Error('Destroyed')); return; }` |
| `if (this.busy)` (line 393) | `if (this.state === 'busy') { this.onError(new Error('Already processing')); return; }` |
| `if (this.destroyed)` (line 397) | covered by the `exiting` check above |
| | finally: `if (this.state !== 'ready') { this.onError(new Error('Not ready')); return; }` |
| `if (this.destroyed)` (interrupt(), line 466) | `if (this.state === 'exiting') throw new Error('Destroyed');` |
| `if (!this.busy)` (interrupt(), line 467) | `if (this.state !== 'busy') throw new Error('Not busy');` |

Same ordering note as Claude: `exiting` first, then `busy`, then `ready`.

`interrupting`, `currentTurnId`, `pendingRequests`, `turnBuffer`,
`busyClearedResolve`, `busyClearedReject` are unchanged.

### Step 4 — Public API: `src/index.ts`

Add the new type export. The runtime export `instanceEvents` already
exists.

```typescript
export type { InstanceInfo, InstanceEventMap, InstanceState } from './registry.js';
```

`transitionState` is **internal**. Wrappers and the registry are the
only legitimate emitters; exposing it would let consumers fake state
transitions and corrupt the registry. The event is consumer-visible;
the mutator is not.

### Step 5 — Version bump

In `package.json`:

- `"version": "3.2.0"` → `"version": "4.0.0"`.

In `package-lock.json`:

- Top-level `"version"` → `"4.0.0"`.
- `packages[""].version` → `"4.0.0"`.

Edit by hand. No `npm install`, no `npm i --package-lock-only` (CLAUDE.md
Hard Rule 11). Confirm the diff touches only these three numeric fields.

### Step 6 — Tests

#### Extend `src/__tests__/registry.test.ts`

**Update existing assertions first.** The breaking change adds a
required `state` field to `InstanceInfo`. Every existing structural
comparison against a full `InstanceInfo` shape must include
`state: 'spawning'` (or whatever state was set by the test). Concrete
sites:

- `registry.test.ts:60` — the `expect(list[0]).toEqual({...})` block in
  the "register adds an entry" test. Add `state: 'spawning'` to the
  expected object.
- `registry.test.ts:131` — the `instance:added` payload comparison in
  the existing "lifecycle events" block. Add `state: 'spawning'`.
- Any other `.toEqual({ id, provider, cwd, sessionId, pid, createdAt, meta })`
  block discovered while running the test suite — sweep with the
  full-suite run and update each in the same commit.

The structural-equality semantics of `toEqual` mean a missing field on
the expected side fails as soon as the actual gains the field; this
must not be left as a discovery during CI.

New `describe('state machine', ...)` block. Fake instances use the
existing `makeFake` helper.

- **Initial state on `register` is `'spawning'`.** Subscribe to
  `instance:added`, register a fake, assert payload `state === 'spawning'`.
- **`transitionState` updates `entry.state` and emits
  `instance:state-changed`.** Register, subscribe, transition to `ready`,
  assert listener called once with `[info, 'spawning', 'ready']` and
  `info.state === 'ready'`.
- **`spawning → ready` also emits `instance:ready`.** Subscribe to both
  events, transition, assert both fired.
- **`busy → ready` does NOT emit `instance:ready`.** Sequence
  `spawning → ready → busy → ready`. Count `instance:ready` fires:
  exactly 1.
- **Illegal transition throws.** Each pair from the legality table
  inverted: `spawning → busy`, `ready → spawning`, `busy → spawning`,
  `exiting → ready`, `exiting → busy`, `exiting → spawning`. Assert
  `Error('Illegal state transition: ...')` and that no event fired.
- **Same-state self-transition is a no-op.** `transitionState(id, 'ready')`
  on an already-ready entry: no event fired, no throw.
- **Unknown id is a silent no-op.** `transitionState('nope', 'ready')`:
  no throw, no event.
- **`unregister` payload reflects current state.** Sequence
  `spawning → ready → busy → exiting`, then `unregister`.
  `instance:removed` payload has `state === 'exiting'`.
- **`InstanceInfo.state` round-trips through `listInstances()`.**
  Register, transition to `ready`, assert `listInstances()[0].state ===
  'ready'`.

#### Extend `src/__tests__/claude-cli-wrapper.test.ts`

Add a `describe('state machine', ...)` block:

- **Construction emits `added → state-changed(spawning→ready) →
  ready`.** Subscribe to all three, construct via `createAIConversation`,
  assert order and payloads. The `instance:ready` payload has
  `state === 'ready'`.
- **`sendMessage` emits `state-changed(ready→busy)` then on result
  emits `state-changed(busy→ready)`.** Drive a fake stdout `result`
  message, assert two state-changed events with the expected pair.
- **`destroy()` emits `state-changed(*→exiting)` then `removed`.**
  Subscribe to both, call `destroy()`, assert order and that the
  `removed` payload has `state === 'exiting'`.
- **Mid-turn child crash emits exactly one `state-changed(busy→exiting)`
  followed by `removed`.** Send a message, fake a `proc.emit('exit')`
  while busy, assert no `busy→ready` event, only `busy→exiting`.
- **`proc.emit('error', ENOENT)` from `spawning` emits
  `state-changed(spawning→exiting)` then `removed` (no
  `instance:ready` ever fires).** This locks in the
  spawn-failure contract.
- **`sendMessage` while `state === 'exiting'` calls `onError('Destroyed')`,
  not `'Already processing'` or `'Not ready'`.** New behaviour
  guarantee from the guard reordering in Step 2.

#### Extend `src/__tests__/codex-cli-wrapper.test.ts`

Same five cases as in the Claude block, adapted to the Codex
construction path (handshake completion is the `spawning → ready`
trigger, not the constructor). Plus one Codex-specific case:

- **Codex handshake failure emits `state-changed(spawning→exiting)` then
  `removed` with no `instance:ready`.** Drive an `initialize` failure as
  in the existing `onError` test, subscribe to all three lifecycle
  events, assert sequence.

`afterEach(__resetForTests)` is already present in all three test files;
no change needed there.

### Step 7 — Docs (only after build + tests pass — Hard Rule 12)

All stale references to the four-event lifecycle model and to
`emitReady` as the emission site must be updated. The list below is
exhaustive for the current state of the docs — if a sweep with
`grep -rn "emitReady\|four-event\|instance:ready\|InstanceEventMap\|InstanceInfo" docs README.md`
turns up further hits, update those too.

- **`docs/definition.md`:** under "In scope", in the existing
  `instanceEvents` sub-bullet, replace the four-event list with the
  five-event list. Add one short sentence: "`InstanceInfo.state` carries
  the current lifecycle state (`spawning | ready | busy | exiting`)."
- **`docs/architecture.md`:**
  - **`docs/architecture.md:41` "Public API"** — extend the bullet that
    lists `instanceEvents + InstanceInfo, InstanceEventMap` with
    `InstanceState`. The published-export list must match `src/index.ts`.
  - **`docs/architecture.md:249` "Instance registry"** — replace the
    sentence that says `instanceEvents` exposes four events with a
    five-event sentence. Add a new paragraph describing the state
    machine: the four states, the legality table, where each transition
    is performed in each wrapper, and the relationship to
    `instance:ready` (emission folded into `transitionState`, fires
    only on `spawning → ready`). Update the existing
    `registry.emitReady(id)` reference to `registry.transitionState(id,
    'ready')` (the new emission site). Add one sentence noting that
    `interrupt()` does not change state — the wrapper stays in `busy`
    throughout the cancel. Add the failure-ordering invariant:
    `state-changed → exiting` always fires before `instance:removed`.
- **`README.md`:**
  - **`README.md:191` "Public API surface"** — append `InstanceState` to
    the export list (the line must match `src/index.ts` exactly).
  - **`README.md:208` "Lifecycle events fire synchronously..."** —
    rewrite to cover five events instead of four. Replace the
    `registry.emitReady(id)` mention with `registry.transitionState(id,
    'ready')`. Add a sentence describing `instance:state-changed`,
    its `[info, prev, next]` payload, and the failure-ordering
    invariant. Extend the listener-must-not-throw clause: "...sits
    inside the wrapper constructor / handshake / `sendMessage` /
    `result`-handler / `setMeta` / `destroy` path."
  - **README lifecycle-events subsection (the `instanceEvents` example
    block, around `README.md:48`)** — extend the example to show one
    `instance:state-changed` listener and add the new event to the
    bullet list above the example.
- **`docs/backlog.kanban.md`:** move card `rvsugmwcbnufknm1ap39le8t`
  (`### instance:state-changed event`) from the `Open` column to the
  `Done` column. **Update the card body** to reflect the actual
  payload and decisions taken: the body currently says "the event
  fires on every transition with `{ prev, next }`", but the chosen
  payload is `[info: InstanceInfo, prev: InstanceState, next:
  InstanceState]` and the underlying state machine is now in place.
  Replace the body with a short retrospective summary describing what
  was actually shipped (state set, payload tuple, relationship to
  `instance:ready`). Preserving the original "out of scope until..."
  body verbatim would leave a falsehood in the Done column.
- **No `bug.kanban.md` changes.** No deviations from target vision are
  introduced.

### Step 8 — Archive and commit

Move `docs/PLAN_instance_state_machine.md` to
`docs/archive/PLAN_instance_state_machine.md`. Single commit covers:

- `src/registry.ts`, `src/claude-cli-wrapper.ts`,
  `src/codex-cli-wrapper.ts`, `src/index.ts`
- `src/__tests__/registry.test.ts`,
  `src/__tests__/claude-cli-wrapper.test.ts`,
  `src/__tests__/codex-cli-wrapper.test.ts`
- `package.json`, `package-lock.json`
- `docs/definition.md`, `docs/architecture.md`, `README.md`
- `docs/backlog.kanban.md` (card move to `Done`)
- The plan archive move

## Verification

All commands from the repository root.

1. **Build passes.** `npm run build` completes without errors.
2. **Typecheck passes.** Covered by `npm run build`. Sanity-check
   `npx tsc --noEmit`.
3. **Tests pass.** `npm test` runs the full vitest suite. All previously
   passing tests still pass — in particular, the existing
   `instance:ready` tests must continue to assert exactly-once emission.
4. **Specific regression coverage.**
   - `busy → ready` does NOT emit `instance:ready` — registry-level test
     catches a wrong condition in `transitionState`.
   - Illegal-transition test catches accidental missing entries in
     `LEGAL_TRANSITIONS`.
   - Mid-turn crash test catches a forgotten `state` reset (would
     produce `busy → ready → exiting` instead of `busy → exiting`).
   - ENOENT / Codex handshake failure test catches a misordered
     `instance:ready` emission against an exiting state.
   - `sendMessage` guard-order test catches a regression to the
     `'Already processing'` vs `'Destroyed'` priority.
5. **Public API shape.** Grep `src/index.ts`:
   - `InstanceState` *must* appear in the `export type` line.
   - `transitionState` *must not* appear (internal).
6. **`instance:state-changed` event payload shape.** A targeted test
   asserts `listener.mock.calls[i]` has length 3 (`info, prev, next`),
   not 1.
7. **No dangling references.** `grep -r "this\.ready\b" src/` and
   `grep -r "this\.busy\b" src/` return only test-file matches (or
   nothing). `grep -r "emitReady" src/` returns nothing.
8. **Manual smoke test.**
   ```typescript
   import { createAIConversation, instanceEvents } from './dist/index.js';

   instanceEvents.on('instance:added',         info       => console.log('added',   info.id, info.state));
   instanceEvents.on('instance:ready',         info       => console.log('ready',   info.id, info.state));
   instanceEvents.on('instance:state-changed', (info, p, n) => console.log('state',   info.id, p, '→', n));
   instanceEvents.on('instance:removed',       info       => console.log('removed', info.id, info.state));

   const a = createAIConversation({ provider: 'claude', cwd: process.cwd() });
   // expect: added <uuid> spawning
   //         state <uuid> spawning → ready
   //         ready <uuid> ready
   a.destroy();
   // expect: state <uuid> ready → exiting
   //         removed <uuid> exiting
   ```
9. **Version bump correct.** `package.json` shows `"version": "4.0.0"`;
   `package-lock.json` agrees at both top-level and `packages[""]`.
10. **Backlog card moved.** `docs/backlog.kanban.md`: card
    `rvsugmwcbnufknm1ap39le8t` is in the `Done` column, no longer in
    `Open`.

<plan_ready>docs/PLAN_instance_state_machine.md</plan_ready>
