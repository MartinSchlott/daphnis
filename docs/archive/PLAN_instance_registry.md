# PLAN: Instance Registry with User Metadata

## Context & Goal

Callers that spawn more than one `AIConversationInstance` today re-implement
the same bookkeeping: a `Map<id, instance>`, a parallel map for domain data
(project name, label, external id), a `listAll()` helper, and cleanup wiring
that keeps both maps in sync on child exit. Daphnis already owns the
lifecycle and holds the only stable handle; a small, passive registry on
top of that lifecycle removes the duplicated boilerplate.

Goal: add a module-level registry that

- auto-registers every instance produced by `createAIConversation`,
- auto-deregisters on child exit and on `destroy()`,
- exposes `listInstances()` (DTOs) and `getInstance(id)` (live ref),
- lets callers hang an opaque `meta` payload on an instance via
  `setMeta` / `getMeta<T>()`,
- exposes a stable Daphnis-assigned id via `getInstanceId()`.

The registry is strictly **passive**: list + metadata, no orchestration,
no role management, no dispatch. This preserves the scope boundary from
`definition.md` ("orchestrating several is the caller's job").

See `docs/PREPLAN_instance_registry.md` for the full design brief and
decision rationale (D1–D9). This plan implements those decisions as-is.
The PREPLAN is archived alongside this PLAN in Step 7 (both move to
`docs/archive/` in the same commit).

## Breaking Changes

**Yes — additive interface extension.**

`AIConversationInstance` gains three new methods: `getInstanceId()`,
`setMeta(value)`, `getMeta<T>()`. Any consumer that *implements* the
interface (not just uses it) will fail to compile. Consumers that only
*call* the interface are unaffected.

The wrapper class constructors gain a required `instanceId: string` as
their third positional parameter (between `cwd` and `handlers?`). This
is an internal boundary — the factory is the supported call site — but
it does break direct instantiation in tests; see Step 3 and Step 6 for
the mechanical updates that accompany this change.

There is no migration code and no compatibility shim (per CLAUDE.md
Rule 2 — breaking is the default).

Human recovery: none required beyond rebuilding and updating any
in-house mocks/fakes of `AIConversationInstance`.

## Reference Patterns

- `src/factory.ts` — the single construction point that all new instances
  flow through. This is where the Daphnis-assigned id is generated.
- `src/claude-cli-wrapper.ts` and `src/codex-cli-wrapper.ts` — existing
  `onExit` / `destroy()` wiring. The new registration call and
  deregistration hooks slot into the same spots.
- `src/sessions.ts` — closest example of a module-level function export
  (`listSessions`). The registry follows the same style: plain functions,
  no class.
- `src/__tests__/factory.test.ts` and `src/__tests__/claude-cli-wrapper.test.ts` —
  existing test patterns with mocked `node:child_process`.

## Dependencies

**None.** Uses `node:crypto.randomUUID()` (already available on Node ≥ 18,
which is the declared floor in `architecture.md`). No new packages.

## Assumptions & Risks

- **Assumption:** `crypto.randomUUID()` collisions are effectively zero
  for a per-process in-memory Map. No collision handling needed.
- **Assumption:** The `exit` event fires exactly once per child process.
  The existing code relies on this (see `this.proc.on('exit', ...)` in
  both wrappers); the registry follows the same assumption.
- **Risk — double deregistration:** `destroy()` removes the entry, then
  the subsequent `exit` event would try again. Mitigation: `Map.delete`
  is naturally idempotent; no guard needed.
- **Risk — Codex init failure leaves a stale registry entry:** Currently
  `CodexCLIWrapper.initialize()` catches JSON-RPC init/thread errors,
  calls `onError`, but does *not* destroy the child; no `exit` event is
  guaranteed. A failed, non-ready Codex instance would therefore remain
  in the registry indefinitely. Resolution: Step 3 amends
  `initialize()` to call `this.destroy()` after `onError(...)` in the
  catch block, which triggers the existing exit path and unregisters the
  entry. A test in Step 6 verifies this.
- **Risk — race between `destroy()` and in-flight message:** Q4 / D4
  resolves this: `destroy()` removes the entry immediately; the later
  `exit` does not re-add it.
- **Risk — module-level state leaking across tests:** Registry state is
  a single `Map` at module scope, so tests that register instances
  without cleanup would poison later tests. Resolution: internal
  `__resetForTests()` helper (Step 1) called in `afterEach` of every
  registry-touching test file. Not exported from `src/index.ts`.

## Steps

### Step 1 — New module: `src/registry.ts`

Create a module-level store and its API. No class.

Internal state:

```typescript
interface RegistryEntry {
  instance: AIConversationInstance;
  provider: 'claude' | 'codex';
  cwd: string;
  createdAt: Date;
  meta: unknown;
}

const entries = new Map<string, RegistryEntry>();
```

Functions (all in this file):

- **Internal (not re-exported from `src/index.ts`):**
  - `register(entry: RegistryEntry): void` — stores under
    `entry.instance.getInstanceId()`. Last-write-wins; UUID collisions
    are effectively zero.
  - `unregister(id: string): void` — `entries.delete(id)`. Idempotent.
  - `setMetaFor(id: string, value: unknown): void` — mutates
    `entry.meta` in place; no-op for unknown id.
  - `getMetaFor(id: string): unknown` — returns `entry?.meta`.
  - `__resetForTests(): void` — clears the map. Documented as
    test-only. Not exported from `src/index.ts`.

- **Public (re-exported from `src/index.ts`):**
  - `listInstances(): InstanceInfo[]` — iterates `entries`, builds a
    fresh `InstanceInfo[]` each call using `entry.instance.getSessionId()`,
    `entry.instance.getPid()`, `entry.instance.getInstanceId()`,
    plus `entry.provider`, `entry.cwd`, `entry.createdAt`, `entry.meta`.
  - `getInstance(id: string): AIConversationInstance | undefined` —
    returns `entries.get(id)?.instance`.

Public type:

```typescript
export interface InstanceInfo {
  id: string;
  provider: 'claude' | 'codex';
  cwd: string;
  sessionId: string | null;
  pid: number;
  createdAt: Date;
  meta: unknown;
}
```

Meta lives on the `RegistryEntry`, not on the wrapper instance. The
wrapper's `setMeta` / `getMeta` methods proxy to `setMetaFor` /
`getMetaFor` (see Step 3). This keeps meta out of per-wrapper state.

### Step 2 — Extend `AIConversationInstance` in `src/types.ts`

Add three methods to the interface:

```typescript
getInstanceId(): string;
setMeta(value: unknown): void;
getMeta<T = unknown>(): T | undefined;
```

Document `getMeta<T>` with a one-line JSDoc as an unchecked cast.

### Step 3 — Wrapper changes (Claude and Codex)

Constructor signature change: **insert `instanceId: string` as the third
positional parameter**, between `cwd: string` and the existing optional
`handlers?` parameter. This keeps the type legal (required before
optional) and is a narrow, mechanical change.

New signatures:

```typescript
// ClaudeCLIWrapper
constructor(
  binary: string, cwd: string, instanceId: string,
  handlers?: AIConversationHandlers,
  systemPrompt?: string, sessionId?: string, effort?: Effort, model?: string,
  envExtra?: Record<string, string>,
)

// CodexCLIWrapper
constructor(
  binary: string, cwd: string, instanceId: string,
  handlers?: AIConversationHandlers,
  systemPrompt?: string, clientInfo?: { name: string; title?: string; version: string },
  sessionId?: string, effort?: Effort, model?: string,
  envExtra?: Record<string, string>,
)
```

Both wrappers (edits apply to each, in order):

1. Store `instanceId` in a `private readonly instanceId: string` field.
2. Implement three new methods:
   - `getInstanceId(): string` — returns `this.instanceId`.
   - `setMeta(value: unknown): void` — calls `setMetaFor(this.instanceId, value)`.
   - `getMeta<T = unknown>(): T | undefined` — returns
     `getMetaFor(this.instanceId) as T | undefined`.
3. **Self-register early.** Immediately after the handlers are wired
   (step 1 in the existing comments, "Set no-op defaults") and
   **before** anything that can fire a user callback, call:
   ```typescript
   register({
     instance: this,
     provider: 'claude', // or 'codex'
     cwd,
     createdAt: new Date(),
     meta: undefined,
   });
   ```
   For Claude this must come before `this.onReady()` at the end of the
   constructor (Claude fires `onReady` synchronously — user code inside
   `onReady` can call `listInstances()` and must see the entry). For
   Codex `onReady` is async (fires after the handshake), so the ordering
   is trivially safe, but the same placement is used for symmetry.
4. **Deregister on `exit` before `onExit`.** In the existing
   `this.proc.on('exit', (code) => { ... })` handler, insert
   `unregister(this.instanceId);` immediately before the final
   `this.onExit(code);` line. In Claude's handler, where a `busy` branch
   may trigger `this.destroy()` (which *also* unregisters), this is
   safe — `unregister` is idempotent.
5. **Deregister on `destroy()` synchronously.** In `destroy()`, insert
   `unregister(this.instanceId);` immediately after the
   `if (this.destroyed) return;` guard, before `this.destroyed = true`.
   The guard ensures `destroy()` is still a no-op on re-entry.

**Codex-specific additional change (Finding 3):** In
`CodexCLIWrapper.initialize()`, the existing `catch (err) { ... }` block
calls `this.onError(...)` but does not destroy the process. Amend it to
call `this.destroy()` after `this.onError(...)`:

```typescript
} catch (err) {
  this.onError(err instanceof Error ? err : new Error(String(err)));
  this.destroy();
}
```

Rationale: without this, an init failure leaves an alive-but-unready
child process plus a stale registry entry with no guaranteed exit.
`this.destroy()` triggers the existing unregister path (Step 3.5).

### Step 4 — Factory: generate id and pass it in

In `src/factory.ts`:

1. Import `randomUUID` from `node:crypto`.
2. Generate `const id = randomUUID();` at the top of the function.
3. Pass `id` as the third positional argument to both wrapper
   constructors, matching the new signatures from Step 3.
4. Do **not** call `register` from the factory — registration happens
   inside the wrapper constructor (Step 3.3). The factory's only
   responsibility is id generation and construction.

### Step 5 — Public API: `src/index.ts`

Add runtime re-exports:

```typescript
export { listInstances, getInstance } from './registry.js';
export type { InstanceInfo } from './registry.js';
```

Do **not** export `register`, `unregister`, `setMetaFor`, `getMetaFor`,
`__resetForTests`, or `RegistryEntry` — those are internal.

### Step 6 — Tests

Four test files are touched or created.

#### New: `src/__tests__/registry.test.ts`

`afterEach(() => __resetForTests())` at the top of the describe block.

Cases (using plain-object fake instances — no child process needed):

- Empty state: `listInstances()` returns `[]`, `getInstance('x')`
  returns `undefined`.
- After `register({ instance: fake, provider: 'claude', cwd: '/tmp',
  createdAt: someDate, meta: undefined })`:
  - `listInstances()` has one entry with the expected fields.
  - `getInstance(fakeId)` returns the fake instance.
  - `meta: undefined` in the DTO.
- `setMetaFor(id, { foo: 42 })` then `getMetaFor(id)` returns that value;
  DTO reflects it.
- `setMetaFor` overwrites (not merges) — second call replaces.
- `unregister(id)` removes; second `unregister(id)` is a no-op.
- `listInstances()` returns a fresh array each call (mutating the
  returned array does not affect the next call).
- `getInstance` / `getMetaFor` on an unknown id return `undefined`;
  `setMetaFor` on an unknown id is a silent no-op.

The fake instance is a plain object exposing `getInstanceId`,
`getSessionId`, `getPid`. No spawn.

#### Existing: `src/__tests__/claude-cli-wrapper.test.ts`

All existing direct `new ClaudeCLIWrapper('claude', '/tmp', ...)` calls
(≈30 sites) gain a third-argument string id. Use a per-test counter or
a literal like `'test-id-1'` — the value does not matter for most
assertions. Two patterns:

- Tests that do not care about the id: pass a shared constant, e.g.
  `const TEST_ID = 'test-id';` at the top, then
  `new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, ...)`.
- Tests that construct multiple wrappers (rare) pass distinct ids.

Add `afterEach(() => { __resetForTests(); })` at describe scope so
the registry is empty before each test. Import `__resetForTests` from
`../registry.js`.

New `describe('registry integration')` block in the same file, using
`createAIConversation` (not direct construction) so the factory-assigned
id flows through naturally:

- After `createAIConversation({ provider: 'claude', ... })`, the
  returned instance is in `listInstances()`; `getInstance(instance.getInstanceId())`
  returns the same reference.
- `instance.setMeta({ label: 'L' })` is reflected in
  `listInstances()[0].meta` and in `instance.getMeta()`.
- Calling `instance.destroy()` removes the entry *synchronously*:
  immediately after the call, `listInstances()` is empty. (D4 test.)
- After the fake child process emits `exit`, an `onExit` callback that
  captures `listInstances().length` at call time observes `0`. (D3
  ordering test — the entry must already be gone when `onExit` runs.)

#### Existing: `src/__tests__/codex-cli-wrapper.test.ts`

Same two mechanical updates: insert `TEST_ID` (third positional arg)
into all ≈15 direct instantiations; add `afterEach(__resetForTests)`.

Mirror the same four registry-integration cases for Codex.

Additionally, a test for the Finding-3 change: when the Codex
`initialize()` handshake fails (the `initialize` JSON-RPC call errors
or `thread/start` errors), the wrapper calls `onError` **and**
`destroy()`, and the registry entry is removed (via the exit path).
The existing test harness already simulates handshake failures for
`onError` assertions — extend one of those cases to also assert
`listInstances().length === 0` after the fake process emits `exit`.

#### Existing: `src/__tests__/factory.test.ts`

Add `afterEach(() => { __resetForTests(); })` at describe scope. No
other changes needed — the existing tests go through the factory, which
keeps working identically.

### Step 7 — Docs

Per CLAUDE.md Rule 12, docs are updated only after build + tests pass.
Updates:

- **`docs/definition.md`:** Add a bullet under "In scope" for the
  registry (`listInstances`, `getInstance`, per-instance `getInstanceId`
  / `setMeta` / `getMeta`). Tighten the "orchestrating several is the
  caller's job" wording in the "Out of scope" block so that passive
  enumeration is clearly *inside* the line.
- **`docs/architecture.md`:** Add a new subsection under "Design
  decisions" titled **"Instance registry"**, covering: module-level
  store, UUID ids, where registration happens (wrapper constructor,
  before `onReady`), where deregistration happens (before `onExit`,
  inside `destroy()`, and via `destroy()` on Codex init failure), meta
  as opaque single slot. Add `registry.ts` to the repository layout box.
- **`README.md`:** Add a short subsection under "What it does" (below
  "Environment hygiene") describing the registry. Add one bullet to the
  "Invariants" block covering the `onExit` ordering guarantee and the
  `null` `sessionId` window on Claude (which is where a caller is most
  likely to trip over the registry-view).
- **`limitations.md`:** not needed — nothing is being deliberately
  omitted from target vision here.
- **Archive PREPLAN:** move `docs/PREPLAN_instance_registry.md` to
  `docs/archive/PREPLAN_instance_registry.md` as part of the same
  commit that archives the PLAN (CLAUDE.md §PREPLAN rule: "Do not
  leave the PREPLAN in `docs/` after the PLAN is archived").

## Verification

All commands run from the repository root.

1. **Build passes.** `npm run build` completes without errors.
2. **Typecheck passes.** Covered by `npm run build`; additionally verify
   via `npx tsc --noEmit` that no stray type errors remain.
3. **Tests pass.** `npm test` runs the full vitest suite; all existing
   tests stay green (with their mechanical third-arg id updates) and
   the new registry tests pass.
4. **Specific regression coverage.** The four registry-integration
   assertions in each wrapper test file cover:
   - D3 (deregister before `onExit`) — the `onExit`-callback-captures-length
     test. If a future change flips the ordering, this test fails.
   - D4 (synchronous deregister on `destroy()`) — the post-`destroy()`
     empty-list test.
   - Codex init-failure cleanup — the handshake-failure test asserts
     empty registry after exit.
5. **Public API smoke test (manual):**

   ```typescript
   import { createAIConversation, listInstances, getInstance } from './dist/index.js';
   // Spawn a real claude if credentials exist; otherwise trust the unit
   // tests — the wiring is what's being checked here.
   ```
   Confirm `listInstances()` returns an `InstanceInfo[]` shape matching
   the public type export, and `getInstance(id)` returns a functional
   instance.
6. **No accidental internal exports.** Grep `src/index.ts` for
   `register`, `unregister`, `setMetaFor`, `getMetaFor`,
   `__resetForTests`, `RegistryEntry` — none of these names may appear.

<plan_ready>docs/PLAN_instance_registry.md</plan_ready>
