# Backlog

id: g5klko9nmmfbgnu7oco4cbaq
template: backlog

## Someday
id: vu6ntxrwrntgs4n17elgj33u

## Open
id: h6co89r6x8vq2ileek28kxyi

## In Progress
id: j1rji73h7kju0kjp3avcbqdm

## Done
id: na2518i666ngoh9fwzsfkzuq

### instance:state-changed event
id: rvsugmwcbnufknm1ap39le8t
priority: low

Shipped together with the explicit state machine
(`spawning | ready | busy | exiting`). `InstanceInfo` carries a
required `state` field; the registry's `transitionState(id, next)`
helper is the single mutation point and emits
`instance:state-changed` with payload
`[info: InstanceInfo, prev: InstanceState, next: InstanceState]` on
every legal transition. Illegal transitions throw, same-state
self-transitions and unknown ids are silent no-ops. `instance:ready`
emission is folded into the same helper and fires only on
`spawning → ready`; subsequent `busy → ready` transitions emit
`instance:state-changed` without re-emitting `instance:ready`.
Failure-ordering invariant: `state-changed → exiting` always fires
before `instance:removed`.

### instance:ready event
id: m550net7oica0f6h40e71rog
priority: medium

Fires on the `spawning → ready` transition (emission folded into the
registry's `transitionState` helper). Claude: synchronously inside the
constructor — after `instance:added`, before `createAIConversation()`
returns. Codex: after the `thread/start` / `thread/resume` handshake
completes and a thread id is captured. Subsequent `busy → ready`
transitions emit `instance:state-changed` but **not** `instance:ready`.

Payload: `InstanceInfo`. Consumers who want "instance is usable"
semantics get them without polling `getSessionId()` from
`instance:added`.

### instance:meta-changed event
id: cpc29053sk678m4mh2t1obol
priority: medium

Fires when `setMetaFor` / `instance.setMeta` updates the meta slot. Payload:
`[info: InstanceInfo, prev: unknown]`. Mechanical change in `setMetaFor`, plus
an entry in `InstanceEventMap`. Consumers can react to label / project tag
changes without polling `listInstances()`.

<!-- markdown-kanban
# Writers use id: {new} for new boards, columns, and cards.
# Processing systems replace {new} with generated IDs on parse.
name: backlog
description: |
  Tracks ideas and pending work through four stages: from rough
  wishlist (Someday), through deliberate intent (Open), to active
  work (In Progress), to delivery (Done). Cards move left to right
  as commitment grows. The Someday column is the only column whose
  cards are not expected to advance — most stay there indefinitely
  or get deleted when no longer relevant.
columnsLocked: false
columns:
  - key: someday
    title: Someday
    description: |
      Ideas that probably will not happen, but deserve to be written
      down. Cards here are not failures — they are honestly-marked
      wishlist items.
  - key: open
    title: Open
    description: Considered, scoped enough, ready to be picked up.
  - key: inprogress
    title: In Progress
    description: Being actively worked on.
  - key: done
    title: Done
    description: Completed and shipped.
cardFields:
  - key: priority
    type: select
    options: [none, low, medium, high]
    description: |
      How important the card is, independent of which column it sits in.
      Required on every card — pick "none" if you have not yet decided,
      so unknown priority is an explicit statement rather than a missing
      field.

      none — not yet decided. Default for fresh cards. Triage later.
      low — nice to have, low impact if delayed
      medium — meaningful, should not sit indefinitely
      high — important, work on this before lower-priority items
-->
