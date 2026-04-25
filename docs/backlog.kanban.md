# Backlog

## Backlog

### instance:ready event

Fires when the wrapper transitions to `ready=true`. Claude: synchronously after
`register` (the wrapper fires `onReady` immediately on construction). Codex:
after the `thread/start` / `thread/resume` handshake completes and a thread id
is captured.

Payload: `InstanceInfo`. Requires a new emission point in each wrapper plus an
entry in `InstanceEventMap`. Consumers who want "instance is usable" semantics
get them without polling `getSessionId()` from `instance:added`.

### instance:state-changed event

Requires modelling an explicit state machine first
(`spawning | ready | busy | exiting`). Today the wrappers only have
`ready` / `busy` booleans without a single source of truth for transitions.
Out of scope until the state model is decided. Once the states exist, the
event fires on every transition with `{ prev, next }`.

### instance:meta-changed event

Fires when `setMetaFor` / `instance.setMeta` updates the meta slot. Payload:
`[info: InstanceInfo, prev: unknown]`. Mechanical change in `setMetaFor`, plus
an entry in `InstanceEventMap`. Consumers can react to label / project tag
changes without polling `listInstances()`.

## In Progress

## Done
