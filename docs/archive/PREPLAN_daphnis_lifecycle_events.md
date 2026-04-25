# PREPLAN: Daphnis Lifecycle Events

> **Note for porting:** This PREPLAN is written in the cortex repository as a porting source. It will be moved into the daphnis repository and resolved into a `PLAN_daphnis_lifecycle_events.md` there, following the same workflow defined in CLAUDE.md (which daphnis shares with cortex). Path references and exact module names are written to schema — the Coder confirms them against the daphnis source during Discussion.

## Context & Goal

Daphnis maintains a process-wide registry of CLI instances. Today, consumers of daphnis that want to react to instance lifecycle changes — a session ending, a new session starting, a state transition — have only two options:

1. **Poll the registry** at some interval and diff. Wasteful, latency-bound, and the diff logic is reinvented in every consumer.
2. **Wrap each `spawn()` call in custom callback logic** at the call site. Couples consumer code to daphnis internals, makes it impossible for a second consumer in the same process to observe the same instance, and produces inconsistent observation across the codebase.

Both approaches force daphnis consumers to assume too much about daphnis internals and produce duplicated, drift-prone observation logic.

**Goal:** Add lifecycle events to daphnis' existing instance registry. Consumers subscribe to a single event stream and react to instance lifecycle without polling and without coupling to call-site-specific callback wrapping. Multiple consumers in the same process see a coherent shared view of the registry.

This is a standard Node.js EventEmitter pattern. The change is additive — no existing daphnis API is broken or repurposed — so it lands as a minor version bump rather than a major one.

## Breaking Changes

**No.** The change is purely additive: a new EventEmitter is exposed alongside the existing API. Existing consumers continue to work without modification. The release is a minor version bump (e.g., 1.x → 1.(x+1)).

## Reference Patterns

- **Node.js `EventEmitter`** — the standard pattern for in-process pub/sub. See `node:events`.
- **`process.on('exit', …)`** — example of a process-wide event registry consumed by multiple subscribers without coupling.
- Internal: whichever module today owns the daphnis instance registry (the file with the in-memory list of running instances and the `spawn`/`kill` entry points). The PREPLAN does not name the file because the Coder confirms it during Discussion against the daphnis source.

## Dependencies

- **No new runtime dependencies.** `EventEmitter` is in the Node.js standard library.
- **No new dev dependencies.** Existing test infrastructure is sufficient.

## Assumptions & Risks

### Assumptions

- Daphnis already has an internal data structure tracking running instances with their lifecycle (spawn, ready, exit). Events are derived from existing internal state transitions, not from new tracking work.
- Daphnis is consumed in a single Node.js process per consumer (no IPC across processes within daphnis). Events fire in the process where the instance was spawned.
- Consumers are responsible for unsubscribing when they shut down. Daphnis does not track subscribers (standard `EventEmitter` behavior).

### Risks

- **Event ordering vs. promise resolution.** A consumer of `spawn()` (which returns a Promise resolving to the new instance) might receive the `instance:added` event *before* its own `await spawn()` resolves, depending on microtask ordering. The plan must specify the contract: is `instance:added` guaranteed to fire before, after, or in any order relative to `spawn()`'s resolution? Recommendation: events fire *after* the corresponding promise resolves, so consumers that prefer the imperative style see no observable surprise. If implementation requires the opposite, document it.
- **Late subscribers.** A consumer that subscribes after some instances are already running misses the historical `instance:added` events for those instances. The plan must decide: do we offer a `replayExistingInstances()` helper that synthesizes events for currently-running instances, or do consumers that need a snapshot use the existing registry-list API and then subscribe to events for new ones? Recommendation: no replay — keep events as forward-only; consumers compose `listInstances()` with `on('instance:added', …)` for full coverage. The combination is idiomatic and avoids replay-vs.-live-event ordering complications.
- **Error events.** What happens if an instance crashes during spawn (e.g., the CLI binary is missing)? The plan must specify whether `instance:added` fires followed quickly by `instance:removed`, or whether spawn-failures emit a separate `instance:spawn-failed` event without ever firing `instance:added`. Recommendation: spawn-failures do not emit `instance:added` — only successfully-registered instances appear in the event stream. Spawn-failures continue to surface via the existing `spawn()` Promise rejection.

## Steps

The Coder confirms the exact module paths and existing class names against the daphnis source during Discussion.

1. **Locate the instance registry module.** Find the daphnis module that owns the in-process list of running instances and exposes `spawn`/`kill` (or equivalent) entry points. Confirm with Human if uncertain.

2. **Add an `EventEmitter` to the registry singleton.** The emitter is a property of the singleton (or a module-level export) and is exposed via the daphnis public API. Suggested name: `daphnis.events`. The exact API surface (whether `events` is a public property of the singleton, or whether daphnis exposes `on`, `off`, `once` directly as a forwarding facade) is decided in the plan.

3. **Define the event contract.** At minimum:
   - `instance:added` — fired when an instance has been successfully registered. Payload: the instance object (same shape as `listInstances()` returns).
   - `instance:removed` — fired when an instance has exited or been killed. Payload: the instance object (final state) or its identifier — decide based on whether consumers need the full final state.
   - `instance:state-changed` — fired when an instance transitions between internal states (e.g., spawning → ready → busy → exiting), if daphnis tracks intermediate states. If daphnis only knows added/removed, this event is omitted from the initial release. The Coder confirms during Discussion.

4. **Wire emitters into existing lifecycle code.** At each existing point where daphnis updates the registry (instance added, instance exit, instance kill), emit the corresponding event *after* the registry update completes. Events fire after the corresponding Promise (e.g., `spawn()`) resolves.

5. **Document the contract.** Update daphnis' `definition.md` (if maintained) and the README to describe the events, their payloads, and the late-subscriber behavior (no replay; combine with `listInstances()`). Include an example in the README:
   ```ts
   import { daphnis } from '@ai-inquisitor/daphnis'

   daphnis.events.on('instance:added', (instance) => {
     console.log('New instance:', instance.id)
   })
   ```

6. **Add tests.** Cover:
   - Subscribing before spawn → receiving `instance:added`.
   - Subscribing after spawn → not receiving the historical event.
   - Spawn failure → no `instance:added` fired; existing `spawn()` rejection still works.
   - Instance exit → `instance:removed` fired.
   - Multiple subscribers receive the same event.

7. **Bump the package version (minor).** Update `package.json` to the next minor version. No major bump — the change is additive.

## Verification

- New tests pass.
- Existing daphnis test suite passes unchanged. (Confirms the additive nature of the change.)
- Build succeeds.
- A manual smoke test consuming the new events from a small local script confirms the contract behaves as documented.
- Published to npm under `@ai-inquisitor/daphnis@<new-version>`.

## Open Questions for Discussion

These are explicitly not pre-decided in this PREPLAN. The Coder resolves them during Discussion with the Human:

1. **Public API shape.** Is the EventEmitter exposed as `daphnis.events` (property), as direct `daphnis.on/off/once` (facade), or as a returned subscriber from a `subscribe()` call? Recommendation in the PREPLAN: `daphnis.events` property. Discussion confirms.

2. **State-change granularity.** Does daphnis track intermediate states (spawning, ready, busy, exiting), or only added/removed? If intermediate states exist, are they events too? The Coder confirms by reading daphnis source.

3. **Event payload shape.** Does `instance:added` carry the full instance object, or a lightweight identifier-plus-metadata struct? Consumers can call `listInstances()` for full state, so the payload could be small. Discussion decides.

4. **Backward compatibility for the singleton accessor.** Where is the daphnis singleton imported from today? If consumers import `daphnis` directly, the events property is added. If consumers go through a factory or class instance, the events live on the instance. The Coder confirms by reading daphnis source.
