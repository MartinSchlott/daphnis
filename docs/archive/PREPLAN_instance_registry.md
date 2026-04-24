# PREPLAN: Instance Registry with User Metadata

## Context

A caller that uses Daphnis for a single conversation gets away without any
bookkeeping: hold the returned `AIConversationInstance` in a variable, call
`sendMessage`, call `destroy`, done. The moment a caller spawns more than
one instance — a typical pattern in anything that juggles several sessions
in parallel — the same small piece of plumbing appears:

- a `Map<id, AIConversationInstance>` to remember what was spawned
- a parallel map for domain data the caller wants to attach
  (a project name, a user-facing label, an external id, whatever)
- a `listAll()` helper over both
- cleanup wiring so both maps stay in sync when a child exits

This is boilerplate every non-trivial Daphnis user re-implements. The
underlying need is general and narrow: *somewhere to hang a payload on an
instance, and a way to enumerate instances without tracking them by hand*.
Daphnis already owns the lifecycle — it spawns, it knows when a child
exits, and it holds the only stable handle. A small, opt-out-free registry
sitting on top of the existing lifecycle events removes duplicated
bookkeeping without introducing a new concept.

## Why this is still "thin"

Daphnis's scope line, from `definition.md`:

> Multi-agent orchestration. Role management (coder/reviewer/architect),
> state machines, auto-dispatch — not here. Daphnis gives you one
> instance; orchestrating several is the caller's job.

A registry sits *adjacent* to that boundary. The distinction this PREPLAN
locks:

- **In:** passive storage, enumeration, user-attached metadata. The
  registry observes; it does not decide.
- **Out:** any logic that picks which instance handles what. No roles, no
  dispatch, no routing, no state machine, no "send to the idle one".

Put differently: the registry gives callers a better lens on the
instances *they* already manage. It does not manage them for them.
If this line cannot be held during plan writing, the feature should not
ship.

## Fixed decisions

**D1 — Registry is passive.** List + metadata only. Rationale: preserves
the definition.md boundary; anything else drags Daphnis into orchestration.

**D2 — Registration is automatic, not opt-in.** Every instance produced
by `createAIConversation` is registered inside the factory. Rationale:
a registry callers have to remember to opt into is one most forget, and
the whole value is "I don't keep a map myself". There is no flag to
disable it; callers who need isolation can just ignore `listInstances()`.

**D3 — Deregistration is automatic on child exit.** The existing exit
path in each wrapper removes the entry before firing the caller's
`onExit` handler. Rationale: inside `onExit`, a caller inspecting
`listInstances()` should see a consistent "still alive" view. Ordering
this the other way round leaks dead entries into user code.

**D4 — Deregistration on `destroy()` is synchronous and idempotent.**
`destroy()` removes the entry before killing the child. Calling
`destroy()` twice is safe.

**D5 — Metadata is a single opaque slot, not key-value.**
`setMeta(value: unknown)` overwrites; `getMeta<T>(): T | undefined`
reads. Callers who want multiple fields pass an object. Rationale: a
key-value API invites callers to treat Daphnis as their application
state store; one slot says "this is a tag, not a database".

**D6 — Metadata is `unknown`, not a schema.** Daphnis does not
interpret, validate, or serialise the payload. `getMeta<T>()` is an
unchecked cast documented as such. Rationale: a typed slot would force
a shared schema and pull Daphnis into domain decisions that belong to
the caller.

**D7 — The registry is module-level, not a class.** Exposed as plain
exports (`listInstances`, `getInstance`). Rationale: Daphnis has no
other singletons and no DI story; wrapping one map in a class just to
call it `Registry` adds surface without payoff.

**D8 — Instance identity is a Daphnis-assigned id, not `sessionId`.**
Assigned at construction, stable for the lifetime of the instance.
Rationale: Claude's `sessionId` is `null` until the first reply
arrives (documented README invariant), so it cannot serve as a registry
key. A separate id is needed in any case, and exposing it via
`getInstanceId()` gives callers something stable to log and correlate.

**D9 — Registry is per-process, in-memory.** No disk persistence, no
cross-process coordination. Rationale: Daphnis does not own disk state
beyond what the CLIs already write. Multi-process orchestration belongs
one layer up.

## Open questions

**Q1 — DTO vs live instance in `listInstances()`.**
A DTO (`InstanceInfo`) is safer for observation code that shouldn't
mutate; a live instance reference is more convenient for callers who
*do* want to act on the result. Leaning: `listInstances()` returns
DTOs, `getInstance(id)` returns the live instance. That splits the two
audiences cleanly.

**Q2 — `getInstanceId()` on the instance, or only in the DTO?**
A caller who holds the instance still needs the id to correlate with
logs and with `getInstance(...)` lookups. Leaning: add
`getInstanceId()` on `AIConversationInstance`. The cost is one more
line on the public interface; the benefit is that the id is not
second-class.

**Q3 — Filtering API.**
Options: (a) ship only `listInstances()`; callers filter via
`.filter(...)`; (b) ship `listInstances({ provider?, cwd? })` as
convenience. Leaning: (a). Filtering by provider or cwd is a one-liner,
and anything domain-specific belongs in the caller's `meta` anyway.

**Q4 — Behaviour across `destroy()` race conditions.**
If `destroy()` is called while a message is mid-flight, does the
instance disappear from `listInstances()` immediately, or only after
the child actually exits? Leaning: remove immediately in `destroy()`
(see D4), since the caller has signalled intent; the child's
eventual exit does not re-add it.

## API sketch (illustrative, not normative)

```typescript
// Additions on AIConversationInstance
getInstanceId(): string;
setMeta(value: unknown): void;
getMeta<T = unknown>(): T | undefined;

// New module-level exports from src/index.ts
export function listInstances(): InstanceInfo[];
export function getInstance(id: string): AIConversationInstance | undefined;

export interface InstanceInfo {
  id: string;                          // Daphnis-assigned
  provider: 'claude' | 'codex';
  cwd: string;
  sessionId: string | null;            // null until first reply for Claude
  pid: number;
  createdAt: Date;
  meta: unknown;                       // user payload, returned as-is
}
```

The exact shape is the plan's call; this sketch is here to make the
decisions above concrete, not to pre-write the code.

## Affected docs

- `definition.md` — extend the in-scope list with the registry; tighten
  the wording around "orchestrating several is the caller's job" so that
  passive enumeration is clearly inside the line.
- `architecture.md` — one section on the module-level store, the
  registration points (factory), and the deregistration rule (before
  `onExit`, inside `destroy()`).
- `README.md` — new short subsection under "What it does"; one
  invariant added to the "things that will bite you" list covering the
  `onExit` ordering and the `null` `sessionId` on Claude.

## Out of scope for this PREPLAN

- **Rogue-process detection.** Finding CLI children that escaped this
  process's registry — for example, strays from a previous run — is a
  related but separate concern. It requires platform-specific process
  enumeration (`ps` on POSIX, `wmic`/`tasklist` on Windows) and a cross-
  platform story Daphnis does not have today. Worth a separate PREPLAN
  if the need outlives the registry.
- **Orchestration primitives.** Round-robin, least-busy dispatch, role
  tags as first-class fields — all explicitly excluded by D1. Callers
  who want this build it on top of `listInstances()` and `meta`.
- **Cross-process or persistent registries.** D9 fixes this as
  in-memory, per-process. A persistent registry is a different product.
