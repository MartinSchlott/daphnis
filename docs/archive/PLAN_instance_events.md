# PLAN: instance:ready + instance:meta-changed events

## Context & Goal

Extend the typed `instanceEvents` EventEmitter (introduced in commit `3467e02`)
with two additional lifecycle events:

- **`instance:ready`** — fires when a wrapper transitions to `ready=true`.
- **`instance:meta-changed`** — fires when `setMetaFor` / `instance.setMeta`
  updates the meta slot.

Both are mechanical, additive extensions following the established pattern of
`instance:added` / `instance:removed`. Consumers gain "instance is usable"
semantics and meta-mutation notifications without polling `listInstances()` /
`getSessionId()`.

Closes backlog cards:
- `m550net7oica0f6h40e71rog` (instance:ready event)
- `cpc29053sk678m4mh2t1obol` (instance:meta-changed event)

The third related card `rvsugmwcbnufknm1ap39le8t` (instance:state-changed) is
**not** in scope — it is explicitly deferred until an explicit state machine
(`spawning | ready | busy | exiting`) is designed.

## Breaking Changes

**No.** Both additions are purely additive:
- New entries in `InstanceEventMap` — TypeScript consumers unaffected unless
  they explicitly assert key exhaustiveness (uncommon).
- New emissions on `instanceEvents` — listeners that do not subscribe to the
  new event names ignore them.

Version bump: `3.1.0` → `3.2.0` (minor, additive).

## Reference Patterns

- `src/registry.ts:22-25` — current `InstanceEventMap` definition
- `src/registry.ts:47, 55` — current emission sites for `added` / `removed`
- `src/__tests__/registry.test.ts:121-265` — test pattern for event listeners
  with `vitest.fn()` and snapshot verification

## Dependencies

None. No new packages, no build changes.

## Assumptions & Risks

**Assumptions:**

- `ready` flag in both wrappers is set to `true` exactly once and never reset.
  Verified at `src/claude-cli-wrapper.ts:174` and `src/codex-cli-wrapper.ts:173`
  (single assignment site each; no `this.ready = false` anywhere after the
  initial declaration).
- At each `ready=true` transition, the instance is already registered in the
  registry (Claude: `register()` runs earlier in the constructor; Codex:
  `register()` runs in the constructor, well before the `thread/start`
  handshake that sets `ready=true`). Therefore `buildInfo(entry)` succeeds
  and the emitted `InstanceInfo` is complete.

**Risks:**

- **Listener throws during emit.** Node's `EventEmitter` propagates synchronous
  throws to the emitter. The `ready` emission sites are inside the wrapper
  constructor (Claude) or the async `thread/start` flow (Codex); a throwing
  listener could disrupt construction. Mitigation: this is the same risk the
  existing `instance:added` emission already carries — we accept identical
  semantics. Document in README that listeners must not throw.

## Steps

### 1. Extend `InstanceEventMap`

`src/registry.ts:22-25`: add two entries.

```ts
export interface InstanceEventMap {
  'instance:added': [info: InstanceInfo];
  'instance:removed': [info: InstanceInfo];
  'instance:ready': [info: InstanceInfo];
  'instance:meta-changed': [info: InstanceInfo, prev: unknown];
}
```

### 2. Emit `instance:meta-changed` from `setMetaFor`

`src/registry.ts:58-61`: capture `prev`, assign, emit. Unknown id remains a
silent no-op (no event).

```ts
export function setMetaFor(id: string, value: unknown): void {
  const entry = entries.get(id);
  if (!entry) return;
  const prev = entry.meta;
  entry.meta = value;
  instanceEvents.emit('instance:meta-changed', buildInfo(entry), prev);
}
```

Always emit on every call — no equality check between `prev` and `value`
(`unknown` has no meaningful equality; filtering is the consumer's concern).

The initial `meta` value set by `register()` does **not** trigger a
`meta-changed` event; the initial value is already carried by the
`instance:added` payload's `info.meta`.

### 3. Add a registry helper for the ready event

Add to `src/registry.ts` (next to `setMetaFor`):

```ts
export function emitReady(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  instanceEvents.emit('instance:ready', buildInfo(entry));
}
```

Rationale: keeps the wrappers free of direct `instanceEvents.emit` calls —
all registry-level event emission stays in `registry.ts`. Mirrors the
existing pattern where `register` / `unregister` own their emissions.

### 4. Wire `emitReady` into the Claude wrapper

`src/claude-cli-wrapper.ts:174` — directly after `this.ready = true;`:

```ts
this.ready = true;
emitReady(this.instanceId);
```

Add `emitReady` to the import on line 7.

### 5. Wire `emitReady` into the Codex wrapper

`src/codex-cli-wrapper.ts:173` — directly after `this.ready = true;`:

```ts
this.ready = true;
emitReady(this.instanceId);
```

Add `emitReady` to the import on line 6.

### 6. Tests — registry events

Extend `src/__tests__/registry.test.ts` (in the existing `instanceEvents`
describe block):

- **`instance:meta-changed` fires with `(info, prev)`** — register, set
  initial meta via `setMetaFor`, attach listener, call `setMetaFor` with a
  new value, assert listener received `(info, prev)` with the old value as
  `prev` and `info.meta` reflecting the new value.
- **`instance:meta-changed` fires on every call (no equality check)** —
  call `setMetaFor` twice with the same value, assert listener fires twice.
- **`instance:meta-changed` does not fire for unknown id** — call
  `setMetaFor('nope', …)`, assert listener was not called. (Pairs with the
  existing silent-no-op test on line 117.)
- **`instance:meta-changed` does not fire on initial `register`** — attach
  listener before `register`, register an instance with default meta,
  assert listener was not called.

### 7. Tests — ready event

Extend the existing event tests in `src/__tests__/claude-cli-wrapper.test.ts`
and `src/__tests__/codex-cli-wrapper.test.ts`:

- **Claude `instance:ready` fires once after construction** — attach
  listener before `createAIConversation('claude', …)`, assert exactly one
  call with `InstanceInfo` matching the new instance.
- **Codex `instance:ready` fires once after `thread/start` handshake** —
  same pattern; assert the listener fires after the handshake completes
  (use the existing test harness's mock for `thread/start`).
- **Ordering** — for Claude, assert `instance:added` fires before
  `instance:ready` (collect both into a single array of event names and
  check the order).

### 8. Update README

`README.md:42-48`: extend the lifecycle events paragraph and the example
block to include `instance:ready` and `instance:meta-changed`. Note in the
text that listeners must not throw.

`README.md:203`: this paragraph currently states "Lifecycle events fire
synchronously inside `register` / `unregister`" — a blanket claim that
becomes false once `instance:ready` rides on the wrappers' `ready=true`
transition and `instance:meta-changed` rides on `setMetaFor`. Rewrite the
opening so it covers all four events: `added` / `removed` continue to fire
synchronously inside `register` / `unregister`; `instance:ready` fires
synchronously after the wrapper's internal `ready` flag flips (Claude:
inside the constructor, after `instance:added`; Codex: after the
`thread/start` handshake completes); `instance:meta-changed` fires
synchronously inside `setMetaFor` whenever the meta slot is updated for a
known id. Keep the existing notes on snapshot-before-delete, forward-only
semantics, and the listener-cap warning.

`README.md:168` (one-paragraph summary): no change needed — it already
references "one public `EventEmitter`".

### 9. Update `docs/definition.md` and `docs/architecture.md`

`docs/definition.md:46-48`: currently names only `instance:added` and
`instance:removed`. Update the bullet to enumerate all four events
(`instance:added`, `instance:removed`, `instance:ready`,
`instance:meta-changed`) and adjust the "Subscribers see lifecycle
transitions without polling" wording to also cover meta updates.

`docs/architecture.md:249-265`: the current paragraph claims "Lifecycle
events ride on the same code paths" (i.e. only `register` / `unregister`)
and that "Dispatch is synchronous — `instance:added` fires before
`createAIConversation()` returns". Both statements become inaccurate
once `instance:ready` and `instance:meta-changed` exist. Rewrite the
paragraph to describe all four events and their emission sites:

- `instance:added` / `instance:removed` — unchanged: fire inside
  `register` / `unregister`, snapshot-before-delete for `removed`.
- `instance:ready` — fires from a `registry.emitReady(id)` helper invoked
  by each wrapper immediately after its internal `ready` flag flips to
  `true`. For Claude this happens inside the constructor (after
  `instance:added`), so the `added` → `ready` order is observable on the
  same tick as `createAIConversation()` returns. For Codex this happens
  later, after the `thread/start` handshake resolves, so subscribers may
  see `instance:added` first and `instance:ready` only after the
  handshake completes. The flag is set exactly once per instance
  lifetime; the event therefore fires at most once per id.
- `instance:meta-changed` — fires inside `setMetaFor` after the meta
  slot is overwritten, with payload `[info, prev]`. Suppressed for
  unknown ids (silent no-op preserved). Not emitted on initial
  `register` — the initial meta value is carried by the
  `instance:added` payload.

Keep the existing notes on no-replay-for-late-subscribers and the
`listInstances()` composition pattern.

### 10. Move backlog cards to Done

In `docs/backlog.kanban.md`, move both cards to the `Done` column:
- `m550net7oica0f6h40e71rog` (instance:ready event)
- `cpc29053sk678m4mh2t1obol` (instance:meta-changed event)

Card `rvsugmwcbnufknm1ap39le8t` (instance:state-changed) **stays in Open**.

### 11. Version bump

`package.json:3`: `3.1.0` → `3.2.0`.

`package-lock.json` is currently drifted (still on `3.0.0` while
`package.json` is on `3.1.0`). Bump both occurrences directly to `3.2.0`
so the metadata is consistent after this plan ships:

- `package-lock.json:3` — `"version": "3.0.0"` → `"version": "3.2.0"`
- `package-lock.json:9` — `"version": "3.0.0"` → `"version": "3.2.0"`

Edit the two version fields in place; do **not** run `npm install` to
regenerate the lockfile (no dependency changes in this plan, and Rule 11
forbids unauthorized package-manager operations).

## Verification

Run from the project root:

```bash
npm run build   # tsc must pass — verifies InstanceEventMap typing
npm test        # vitest run — all existing tests + new tests must pass
```

**Expected:**

- Build succeeds with no TypeScript errors.
- All pre-existing tests still pass (no regression in `instance:added`,
  `instance:removed`, or any wrapper test).
- New tests from steps 6 and 7 pass:
  - `meta-changed` fires with correct `(info, prev)` payload
  - `meta-changed` fires on repeated identical-value calls
  - `meta-changed` does not fire for unknown id or on initial register
  - `ready` fires exactly once per instance (Claude + Codex)
  - For Claude: `added` fires before `ready`

**Manual sanity check** (optional):

```ts
import { instanceEvents, createAIConversation } from '@ai-inquisitor/daphnis'

instanceEvents.on('instance:ready',        info       => console.log('ready', info.id))
instanceEvents.on('instance:meta-changed', (info, p) => console.log('meta', p, '→', info.meta))

const inst = createAIConversation({
  provider: 'claude',
  cwd: process.cwd(),
  handlers: {
    onConversation: () => {},
    onError:        err => console.error(err),
    onExit:         () => {},
  },
})
inst.setMeta({ label: 'first' })
inst.setMeta({ label: 'second' })
```

`createAIConversation` is synchronous and takes a single options object
(see `src/factory.ts:6` and `AIConversationOptions` in `src/types.ts:73`).

Expected output (order, two `meta` lines):
```
ready <id>
meta undefined → { label: 'first' }
meta { label: 'first' } → { label: 'second' }
```
