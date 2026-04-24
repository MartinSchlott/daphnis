# Daphnis — Definition

## What

Daphnis is a thin, provider-agnostic TypeScript wrapper around the official
Claude CLI and OpenAI Codex CLI. It exposes a single, small surface for two
use cases:

- **Persistent conversation** — spawn a CLI, send messages, receive streamed
  replies, resume prior sessions, retrieve transcripts.
- **One-shot prompting** — run a single prompt, optionally schema-enforced,
  with timeout and cancellation.

Daphnis uses the CLIs exactly as their vendors intended. It does not ship a
custom protocol, does not embed credentials, does not virtualise the user's
home directory. This is what makes it TOS-conform: it is a wrapper, not a
proxy or re-implementation.

## Why

Existing abstractions over AI coding agents tend to grow in two directions:
either they expose hundreds of parameters to cover every provider-specific
knob, or they add capabilities that only a subset of providers support and
then fall back to per-provider branching in user code. Both end up leaking
the distinction they tried to hide.

Daphnis takes the opposite path: expose only what *both* Claude and Codex
support cleanly, and expose it uniformly. Anything provider-specific that
cannot be modelled without compromise is out of scope.

## Scope

### In scope

- `createAIConversation(options)` — persistent session with streaming
  callbacks, resume by session id, transcript retrieval.
- `runOneShotPrompt(options)` — single-shot prompt with optional JSON
  schema, timeout, and `AbortSignal` cancellation.
- `listSessions(provider, cwd)` — enumerate persisted sessions for the
  given working directory.
- `listInstances()` / `getInstance(id)` — passive registry of live
  instances. Per-instance `getInstanceId()`, `setMeta(value)`, and
  `getMeta<T>()` let callers hang an opaque payload on an instance and
  look it up without keeping their own map.
- Uniform effort levels (`default | min | low | medium | high | xhigh |
  max`) mapped to the closest provider-supported gear.
- Uniform `ConversationTurn` shape (`role`, `content`, `timestamp`).
- An environment-variable blacklist applied at spawn to prevent the parent
  Claude Code / VS Code state from leaking into the child process.

### Out of scope (deliberately)

- **Authentication / token management.** The caller sets
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` etc. via
  the `env` option. Daphnis does not read config files, does not prompt,
  does not store credentials.
- **Git integration.** Credential helpers, `GH_TOKEN` injection, account
  resolution — not here. Caller passes whatever env it wants.
- **Multi-agent orchestration.** Role management (coder/reviewer/architect),
  state machines, auto-dispatch — not here. Daphnis gives you one instance
  and a passive registry to enumerate several; *orchestrating* them (who
  does what, when) is the caller's job.
- **Portable / remote sessions.** Claude and Codex persist sessions under
  `~/.claude/projects/…` and `~/.codex/sessions/…`, keyed by
  `(host user, cwd)`. Daphnis honours that. Sessions are not portable
  between machines or users. This is a consequence of using the CLIs as
  intended, not a bug.
- **Provider-specific features that do not generalise.** If a feature only
  works on one side, it stays out unless the asymmetry can be hidden
  without lying about behaviour.

## Entities

- **Provider** — `'claude' | 'codex'`. The only branch point in the public
  API.
- **Session** — a persistent conversation with a CLI process. Identified
  by `sessionId` (Claude) / `threadId` (Codex), both exposed uniformly as
  `getSessionId()`.
- **Turn** — `{ role: 'user' | 'assistant', content: string, timestamp:
  Date }`. Intermediate tool-use / reasoning events are not surfaced in
  v1.
- **Effort** — abstract reasoning level, mapped per provider. `'default'`
  passes no flag and lets the CLI decide.
- **Instance** — a live `AIConversationInstance` produced by
  `createAIConversation`. Identified by a Daphnis-assigned UUID
  (`getInstanceId()`), independent of the provider's `sessionId`. Carries
  one opaque caller-supplied `meta` slot.

## Success criteria

- A caller can swap `provider: 'claude'` for `provider: 'codex'` without
  changing any other option, and both work.
- The entire public API fits in `src/index.ts` without re-exports from
  deep modules.
- Adding a third provider would require one new file plus a branch in
  `factory.ts` and `one-shot.ts` — nothing else.
- No hidden side effects: spawn, read stdio, parse, call back. That is
  the whole contract.
