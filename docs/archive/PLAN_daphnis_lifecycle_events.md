# PLAN: Daphnis Lifecycle Events

## Context & Goal

Daphnis exposes a passive instance registry (`listInstances`, `getInstance`,
`setMeta` / `getMeta`) but no way to observe when entries appear or
disappear. Consumers that want to react to lifecycle changes today have to
poll `listInstances()` and diff, or wrap every `createAIConversation` call
site with custom callback logic. Both patterns leak daphnis internals into
the consumer and prevent multiple consumers in the same process from
observing the same instance coherently.

Goal: expose a typed `EventEmitter` from the registry that fires
`instance:added` and `instance:removed` events. Consumers subscribe once
and react to lifecycle without polling and without coupling to call-site
wiring. The registry remains passive — events are derived from the existing
`register` / `unregister` operations, no new lifecycle tracking.

The change is purely additive: a new export alongside the existing API.
No existing public function changes signature. Bumping `engines.node`
to `>=22` is the only non-additive aspect (see Breaking Changes).

See `docs/PREPLAN_daphnis_lifecycle_events.md` for the full design brief.
This plan implements those decisions, with the open questions resolved
during Discussion:

- **Public API shape:** named export `instanceEvents`. No singleton facade.
- **Event scope (v1):** `instance:added` and `instance:removed` only.
  Future events (`instance:ready`, `instance:state-changed`,
  `instance:meta-changed`) become backlog cards.
- **Spawn-failure semantics:** documented honestly — the wrapper registers
  before any async failure path can fire, so an ENOENT or Codex handshake
  failure produces `instance:added` followed shortly by `instance:removed`.
- **Engine bump:** `engines.node` from `>=18` to `>=22`. Lets us use the
  generic `EventEmitter<T>` from Node 22 directly, no subclass.
- **Version:** 2.0.0 → 2.1.0 (minor; additive API).

The PREPLAN is archived alongside this PLAN in Step 7.

## Breaking Changes

**Yes — `engines.node` field only. Recorded as a Human-approved semver
exception: minor bump (2.0.0 → 2.1.0) despite the engine narrowing.**

The `engines.node` constraint moves from `>=18` to `>=22`. npm only warns
on engine mismatches by default; it does not block install. No public API
breaks. No source-level breakage in consumer code. The `EventEmitter`
runtime behaviour itself is identical across Node 18+ — the engine bump
exists so we can rely on the **typed** `EventEmitter<T>` shipped with
`@types/node@^22` without compile-time hacks (subclassing, `as` casts).

A strict semver reading would treat any `engines` narrowing as a major
bump. The Human explicitly approved a minor bump in the Discussion phase
(weighing: the project itself runs on Node 22, npm only warns, the public
API is purely additive, and a major bump would be disproportionate to the
actual change). This is recorded here per CLAUDE.md Hard Rule 13.

Human recovery: consumers running Node < 22 either upgrade Node or pin
to `@ai-inquisitor/daphnis@2.0.x`. Future patches to the 2.0.x line are
not planned but not actively prevented either — the engine bump applies
to 2.1.x onward.

## Reference Patterns

- `src/registry.ts` — the module that gains the `EventEmitter`. Existing
  `register` / `unregister` are the only emit sites.
- `src/__tests__/registry.test.ts` — existing test style with plain-object
  fake instances and `__resetForTests` in `afterEach`. The new event tests
  follow the same pattern.
- `src/__tests__/claude-cli-wrapper.test.ts` and
  `src/__tests__/codex-cli-wrapper.test.ts` — existing wrapper-level tests
  with mocked `node:child_process`. The end-to-end "wrapper construction
  emits added; destroy emits removed" assertions slot in there.
- `node:events` `EventEmitter<T>` — Node ≥ 22 generic typed emitter.
  `@types/node@^22` already exposes it; no new dependency.

## Dependencies

**None.** `node:events` is the standard library. No new packages, no
dev-dependency changes. `@types/node@^22.0.0` is already declared.

## Assumptions & Risks

- **Assumption:** `register` is called exactly once per instance (enforced
  in Step 1 with a `has()` guard). `unregister` is idempotent today and
  remains so; the new emit path only fires when a delete actually
  removes something.
- **Assumption:** Sync emission is acceptable. `register` runs inside the
  wrapper constructor *before* the constructor returns, so subscribers see
  `instance:added` before the caller has the instance reference. The
  payload (`InstanceInfo`) carries `id`, so a subscriber that needs the
  live wrapper can call `getInstance(info.id)` — but only *outside* the
  emit handler if they want to see the same instance the caller will get
  (inside the handler, `getInstance` already works because `entries.set`
  ran before the emit). This is acceptable and matches Node's
  `EventEmitter` convention (synchronous dispatch).
- **Risk — `instance:removed` payload after delete:** if we `delete` first
  and emit second, the snapshot data must be captured *before* delete or
  the payload would have to re-derive from a now-gone entry. Resolution:
  build the `InstanceInfo` snapshot before `entries.delete(id)`. Encoded
  in Step 1.
- **Risk — double events on idempotent `unregister`:** today `unregister`
  is called from three sites (`destroy`, `proc.on('exit')`,
  `proc.on('error')`). Without a guard, two of those three could each fire
  `instance:removed`. Resolution: the new code path emits **only when the
  delete actually removed an entry** (i.e., after a successful `entries.get(id)`
  precheck). Step 1 wires the guard.
- **Risk — late subscribers miss historical events:** documented as
  forward-only behaviour. Consumers compose `listInstances()` with
  `instanceEvents.on('instance:added', ...)` for full coverage. No replay.
- **Risk — listener leak from forgotten `off()`:** standard `EventEmitter`
  leak warning kicks in at >10 listeners. Default left unchanged; consumers
  who attach many listeners can call `instanceEvents.setMaxListeners(n)`
  themselves. Documented in README.
- **Risk — engine bump rejection:** consumers locked to Node 18 / 20 see
  npm warnings. Acceptable — the project itself runs on Node 22 and the
  engine declaration should reflect reality. Documented as a (minor)
  breaking change above.

## Steps

### Step 1 — Extend `src/registry.ts` with the typed event emitter

Add the event map type, the singleton emitter, and the snapshot-build
helper. Wire `register` and `unregister` to emit.

```typescript
import { EventEmitter } from 'node:events';
import type { AIConversationInstance } from './types.js';

// ... (existing InstanceInfo, RegistryEntry, entries Map, etc.)

export interface InstanceEventMap {
  'instance:added':   [info: InstanceInfo];
  'instance:removed': [info: InstanceInfo];
}

export const instanceEvents = new EventEmitter<InstanceEventMap>();

function buildInfo(entry: RegistryEntry): InstanceInfo {
  return {
    id:        entry.instance.getInstanceId(),
    provider:  entry.provider,
    cwd:       entry.cwd,
    sessionId: entry.instance.getSessionId(),
    pid:       entry.instance.getPid(),
    createdAt: entry.createdAt,
    meta:      entry.meta,
  };
}
```

Refactor `listInstances` to use `buildInfo` (collapses duplicated mapping
code) and update `register` / `unregister`:

```typescript
export function register(entry: RegistryEntry): void {
  const id = entry.instance.getInstanceId();
  if (entries.has(id)) return; // defensive — re-register is a no-op
  entries.set(id, entry);
  instanceEvents.emit('instance:added', buildInfo(entry));
}

export function unregister(id: string): void {
  const entry = entries.get(id);
  if (!entry) return; // idempotent — no entry, no event
  const snapshot = buildInfo(entry);
  entries.delete(id);
  instanceEvents.emit('instance:removed', snapshot);
}

export function listInstances(): InstanceInfo[] {
  const result: InstanceInfo[] = [];
  for (const entry of entries.values()) result.push(buildInfo(entry));
  return result;
}
```

`__resetForTests` gets one extra line to clear listeners between tests so
that a leftover subscription from a prior test does not leak:

```typescript
export function __resetForTests(): void {
  entries.clear();
  instanceEvents.removeAllListeners();
}
```

`setMetaFor`, `getMetaFor`, and `getInstance` are unchanged — they do not
emit. Meta mutations are explicitly *not* a v1 event (see the backlog card
created in Step 5).

No changes to `src/types.ts`, `src/factory.ts`, `src/claude-cli-wrapper.ts`,
or `src/codex-cli-wrapper.ts` — all emission flows through `register` /
`unregister`, which the wrappers already call.

### Step 2 — Public API: `src/index.ts`

Add the runtime export and the type export:

```typescript
export { listInstances, getInstance, instanceEvents } from './registry.js';
export type { InstanceInfo, InstanceEventMap } from './registry.js';
```

`InstanceEventMap` is exported so consumers can write strongly-typed
helper functions over it (e.g. wrappers that re-emit). `register`,
`unregister`, `setMetaFor`, `getMetaFor`, `__resetForTests`, `buildInfo`,
and `RegistryEntry` remain internal.

### Step 3 — Engine bump and version

In `package.json`:

- `"engines": { "node": ">=22" }`
- `"version": "2.1.0"`

In `package-lock.json` (currently shows `version: 1.0.0`,
`engines.node: >=18` — already drifted from `package.json`):

- Top-level `"version": "2.1.0"`.
- `packages[""].version: "2.1.0"`.
- `packages[""].engines.node: ">=22"`.

Edit these three fields by hand. No `npm install`, no `npm i
--package-lock-only` — those would be package-manager operations under
CLAUDE.md Hard Rule 11. The three fields are pure metadata and do not
touch `dependencies` or `node_modules`. After the edit, confirm the diff
touches only the three fields named above.

No changes to `dependencies` or `devDependencies` (`@types/node@^22.0.0`
is already in place). No changes to `tsconfig.json` (`target: ES2022`
already covers Node 22 features daphnis uses; the typed `EventEmitter`
generic comes from `@types/node`, not from a `lib` setting).

### Step 4 — Tests

Three test files are touched. All new tests use the existing
`__resetForTests()` cleanup (now also clears listeners — see Step 1).

#### Extend `src/__tests__/registry.test.ts`

New `describe('instance lifecycle events', ...)` block. Cases:

- **`instance:added` fires on `register` with the correct snapshot.**
  Subscribe, register a fake, assert the listener was called once with
  an `InstanceInfo` matching the registered entry (id, provider, cwd,
  sessionId, pid, createdAt, meta).
- **`instance:removed` fires on `unregister` with the final snapshot.**
  Register, mutate `meta` via `setMetaFor`, subscribe to `removed`,
  unregister, assert payload reflects the *last* meta value (snapshot
  built before delete).
- **`unregister` for an unknown id fires no event.** Subscribe, call
  `unregister('nope')`, assert listener was never called.
- **Second `register` for the same id fires no second `added` event.**
  Register twice with the same id, assert the listener was called once.
- **Second `unregister` for the same id fires no second `removed` event.**
  Register, unregister, unregister, assert listener was called once.
- **Multiple subscribers all receive the same event.** Two listeners,
  one register, both fire.
- **`off()` removes the subscriber.** Subscribe, off, register, assert
  not called.
- **Snapshot stability:** capture the payload, then mutate the underlying
  fake instance's `getSessionId` return, assert the captured payload's
  `sessionId` is unchanged (the `InstanceInfo` is a value, not a live
  view).
- **`__resetForTests` clears listeners.** Subscribe, call
  `__resetForTests`, register, assert not called.

The existing `makeFake` helper extends with optional `getSessionId` /
`getPid` / `getInstanceId` overrides as needed.

#### Extend `src/__tests__/claude-cli-wrapper.test.ts`

Add a `describe('lifecycle events', ...)` block, using
`createAIConversation` (the factory path) so the full wrapper-level wiring
is exercised:

- **Construction emits `instance:added` exactly once.** Subscribe before
  `createAIConversation`, assert one call after the constructor returns,
  payload matches.
- **`destroy()` emits `instance:removed` exactly once.** Subscribe, call
  `destroy()`, assert one call. Subsequent `proc.emit('exit')` does **not**
  emit a second `removed` (idempotency proof).
- **`proc.emit('exit')` without prior `destroy` emits `instance:removed`
  exactly once.** Mirror of the previous case for the natural-exit path.
- **`proc.emit('error', new Error('ENOENT…'))` emits `added` then
  `removed`.** Subscribe to both events, construct the wrapper, then have
  the fake child emit `'error'`. Assert exactly one `added` (from
  construction) followed by exactly one `removed` (the `error` handler
  calls `this.destroy()`, which unregisters). This locks in the
  documented ENOENT / spawn-error contract — without this test, the
  ordering claim in the docs is asserted only in the Codex
  handshake-failure case.

#### Extend `src/__tests__/codex-cli-wrapper.test.ts`

Same four cases as in the Claude section above (construction emits
`added` once; `destroy()` emits `removed` once and a subsequent
`proc.emit('exit')` does not double-emit; `proc.emit('exit')` without
prior `destroy` emits `removed` once; `proc.emit('error', new
Error('ENOENT…'))` emits `added` then `removed`). Plus one
Codex-specific case:

- **Codex handshake failure emits `added` then `removed`.** Simulate the
  existing handshake-failure scenario (already covered by an `onError`
  test), subscribe to both events, assert exactly one `added` followed by
  exactly one `removed`. This locks in the documented spawn-failure
  semantics.

`afterEach(__resetForTests)` is already present in these files (or added
by the registry plan); no change needed there beyond verifying it.

### Step 5 — Backlog cards for future event extensions

Create `docs/backlog.kanban.md` (does not exist yet) with three cards in
the `Backlog` column. Format follows the `markdown-kanban` skill — three
heading levels: `# Backlog`, `## Backlog`, `### <card title>`.

Cards:

- **`instance:ready` event** — fires when the wrapper transitions to
  `ready=true` (Claude: synchronously after register; Codex: after the
  `thread/start` / `thread/resume` handshake completes). Payload:
  `InstanceInfo`. Requires a new emission point in each wrapper plus an
  entry in `InstanceEventMap`.
- **`instance:state-changed` event** — requires modelling an explicit
  state machine first (`spawning | ready | busy | exiting`). Today the
  wrappers only have `ready` / `busy` booleans. Out of scope until the
  state model is decided.
- **`instance:meta-changed` event** — fires when `setMetaFor` /
  `instance.setMeta` updates the meta slot. Payload:
  `[info: InstanceInfo, prev: unknown]`. Mechanical change in
  `setMetaFor`, plus an entry in `InstanceEventMap`.

The `Done` and `In Progress` columns are empty. Three-level heading
example for the file:

```markdown
# Backlog

## Backlog

### instance:ready event
...

### instance:state-changed event
...

### instance:meta-changed event
...

## In Progress

## Done
```

### Step 6 — Docs (only after build + tests pass)

Per CLAUDE.md Rule 12. Updates:

- **`docs/definition.md`:** under "In scope", add a sub-bullet to the
  registry entry mentioning `instanceEvents` and the two events. Brief —
  the README carries the example.
- **`docs/architecture.md`:** in the existing "Instance registry"
  subsection, add a paragraph describing the `EventEmitter`, the
  emission-from-`register`/`unregister` model, the snapshot-before-delete
  invariant, and the spawn-failure semantics (added followed by removed
  on Codex init failure or ENOENT). Mention the engine bump in the "Tech
  stack" section: `Node.js ≥ 22` (was `≥ 18`).
- **`README.md`:** add a short subsection under "Instance registry"
  describing `instanceEvents` with one TypeScript example. Add one bullet
  to the "Invariants" block: "Lifecycle events fire synchronously inside
  `register` / `unregister`. `instance:added` fires before the
  `createAIConversation()` call returns. `instance:removed` fires before
  the entry leaves `listInstances()` only conceptually — the `delete`
  precedes the emit, so subscribers reading `listInstances()` from the
  handler see the instance already gone, but the payload carries the
  final snapshot." Also document forward-only / no-replay behaviour.
- **No `bug.kanban.md` changes.** Nothing is being deliberately deviated
  from target vision.
- **Archive PREPLAN:** move `docs/PREPLAN_daphnis_lifecycle_events.md` to
  `docs/archive/PREPLAN_daphnis_lifecycle_events.md` in the same commit
  that archives the PLAN (CLAUDE.md §PREPLAN rule).

### Step 7 — Archive and commit

Move `docs/PLAN_daphnis_lifecycle_events.md` to
`docs/archive/PLAN_daphnis_lifecycle_events.md`. Move
`docs/PREPLAN_daphnis_lifecycle_events.md` to
`docs/archive/PREPLAN_daphnis_lifecycle_events.md`. Single commit covers
the source changes, doc updates, the new backlog file, and the archive
moves.

## Verification

All commands run from the repository root.

1. **Build passes.** `npm run build` completes without errors. The typed
   generic `EventEmitter<InstanceEventMap>` resolves via `@types/node@^22`.
2. **Typecheck passes.** Covered by `npm run build`. Sanity-check via
   `npx tsc --noEmit`.
3. **Tests pass.** `npm test` runs the full vitest suite. All existing
   tests remain green (no source-level changes outside `registry.ts`,
   `index.ts`, and `package.json`). The new event-related tests pass.
4. **Specific regression coverage.**
   - Snapshot-before-delete: the "removed payload reflects last meta value"
     test in `registry.test.ts` fails if the order is flipped.
   - Idempotent `unregister`: the "second `unregister` fires no second
     event" test catches accidental double emission.
   - Codex handshake-failure: the wrapper-level test locks in
     "added → removed" for init failures.
   - Listener cleanup between tests: any test that subscribes and forgets
     to clean up would be visible as cross-test pollution; the
     `__resetForTests` extension prevents this.
5. **Public API shape check.** Grep `src/index.ts`:
   - `instanceEvents` and `InstanceEventMap` *must* appear.
   - `register`, `unregister`, `setMetaFor`, `getMetaFor`,
     `__resetForTests`, `RegistryEntry`, `buildInfo` *must not* appear.
6. **Manual smoke test.**
   ```typescript
   import { createAIConversation, instanceEvents } from './dist/index.js';

   instanceEvents.on('instance:added',   info => console.log('added',   info.id));
   instanceEvents.on('instance:removed', info => console.log('removed', info.id));

   const a = createAIConversation({ provider: 'claude', cwd: process.cwd() });
   // expect: 'added <uuid>'
   a.destroy();
   // expect: 'removed <uuid>'
   ```
   Confirms wiring end-to-end without needing a real CLI binary on PATH —
   ENOENT triggers the same code path (added followed by removed).
7. **Engine declaration matches reality.** `node --version` ≥ 22.
   `package.json` `"engines.node": ">=22"`. `package-lock.json`
   `packages[""].engines.node` is `">=22"` — top-level and `packages[""]`
   `version` are both `"2.1.0"`. The lockfile and `package.json` agree on
   both fields (no drift).
8. **Version bump correct.** `package.json` shows `"version": "2.1.0"`;
   `package-lock.json` agrees at both top-level and `packages[""]`.
9. **ENOENT event coverage.** The new `proc.emit('error', ...)` test in
   each wrapper test file exercises the spawn-error path explicitly, not
   only the destroy / exit / Codex-handshake paths.

<plan_ready>docs/PLAN_daphnis_lifecycle_events.md</plan_ready>
