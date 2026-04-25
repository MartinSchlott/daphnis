# PLAN: `fullAccess` boolean, `extraArgs` pass-through, drop `clientInfo`

## Context & Goal

Daphnis currently treats Claude and Codex asymmetrically with respect to
sandboxing and permissions. Claude is hard-wired to
`--dangerously-skip-permissions` in both the streaming wrapper
(`claude-cli-wrapper.ts:87`) and the one-shot path (`one-shot.ts:82`), so
Claude always runs unsandboxed. Codex is invoked without any sandbox or
approval flag, so it falls back to its own `~/.codex/config.toml` defaults
(typically `workspace-write` + `on-request` approval). The result: the
same call can produce a sandboxed Codex that fails on a network test and
an unsandboxed Claude that runs anything — without the caller asking for
either.

Goal: add a single declarative knob that makes the sandbox policy
explicit and symmetric, plus a generic escape hatch for everything we
deliberately do not abstract.

- **`fullAccess: boolean`** in `AIConversationOptions` and `OneShotOptions`,
  default `false`. When `true`, Daphnis appends the provider's bypass flag
  (`--dangerously-skip-permissions` for Claude,
  `--dangerously-bypass-approvals-and-sandbox` for Codex). When `false`,
  Daphnis appends *no* sandbox/permission CLI flag — the CLI's own config
  decides. **Scope note:** `fullAccess` toggles the CLI-level flag only.
  It does **not** change Daphnis' existing JSON-RPC auto-approval
  layer in `CodexCLIWrapper.handleServerRequest` (auto-`accept` for
  command/file requests, fixed read/write/network/macOS grants for the
  permissions request). That layer is required for the `app-server`
  handshake to make progress without a human in the loop and is
  independent of this option. With `fullAccess: false`, a caller who
  wants the Codex CLI's own sandbox to refuse risky ops must combine
  the default with an explicit `extraArgs: ['--sandbox', 'read-only']`
  (or similar) — the CLI sandbox enforces, Daphnis' auto-approver
  becomes moot for ops the sandbox blocks first. With `fullAccess:
  true`, both the CLI sandbox **and** the JSON-RPC approval round-trip
  are short-circuited (Codex emits no approval requests once the bypass
  flag is active).
- **`extraArgs?: string[]`** in both options interfaces. Appended verbatim
  to the spawn arg list. Pass-through, no validation, parallels the
  existing `model` and `env` pattern. Placement per provider is fixed
  and documented (see Steps 3, 4, 6): for Codex, `extraArgs` lands
  among the **global** flags, *before* the `app-server` / `exec`
  subcommand, so global flags like `--sandbox`, `--ask-for-approval`,
  `-c key=value`, `--full-auto` reach Codex in their valid position.
  Subcommand-specific flags are not supported via `extraArgs`.
- **Remove `clientInfo`** from the public API. The Codex JSON-RPC
  `initialize` handshake keeps its identifier hard-coded to
  `{ name: 'daphnis', title: 'Daphnis', version: '1.0.0' }`. The override
  was used by exactly one downstream (cortex) for log-labelling on the
  Codex side; the value is too thin to justify the only provider-specific
  field in the shared options object.

The new `fullAccess` knob lets a caller make a clean decision at the
CLI-flag level: "no bypass flag" (`false`) or "open everything" (`true`).
The `extraArgs` escape hatch covers the long tail of provider-specific
**global** flags (`--permission-mode` for Claude, `--sandbox=read-only`
or `-c key=value` for Codex) without growing the options object.

## Breaking Changes

**Yes — three breaks, all intentional, no compatibility layer.**

1. **Claude default behaviour changes.** Today Claude always runs with
   `--dangerously-skip-permissions`. After this change, the default
   (`fullAccess: false`) emits *no* permission flag. In the streaming
   `--print --input-format stream-json` mode there is no human in the
   loop, so a default-mode Claude will block on the first tool call that
   triggers a permission prompt. **Callers who relied on the old
   unconditional bypass must set `fullAccess: true` explicitly.**
   Recovery: add `fullAccess: true` to the options. No env var or config
   recovers this — Claude has no equivalent in non-interactive mode.

2. **`clientInfo` is removed.** The field disappears from
   `AIConversationOptions` and from `CodexCLIWrapper`'s constructor.
   Callers that set it (cortex sets `{ name: 'cortex', ... }` in
   `dev-manager.ts:299` and `doc-manager.ts:102`) will get a TypeScript
   error. Recovery: delete the `clientInfo:` line from the options
   object. The Codex side will see `name: 'daphnis'` in its logs
   instead of `name: 'cortex'`; no functional impact.

3. **Wrapper constructor signatures change.** Both wrappers gain an
   `envExtra` parameter (already there) and the new `extraArgs` parameter,
   and `CodexCLIWrapper` loses its `clientInfo` parameter. Direct
   instantiation in tests breaks; callers using the supported entry
   point (`createAIConversation`) are unaffected.

Major version bump: `2.1.0` → `3.0.0`.

Human confirmation required before approval.

## Reference Patterns

- `src/claude-cli-wrapper.ts:82-101` — current Claude args assembly. The
  new `fullAccess` and `extraArgs` slot in here, replacing the
  hard-coded `--dangerously-skip-permissions`.
- `src/codex-cli-wrapper.ts:86-100` — current Codex global-flags array.
  The new flags slot in *before* the `app-server` subcommand, same
  pattern as effort and model.
- `src/one-shot.ts:77-128` (Claude) and `:130-183` (Codex) — same
  conventions, just for the one-shot path. Both touched.
- `src/types.ts:48-68` — the existing `AIConversationOptions` interface
  with the `model` / `env` / `effort` precedent for new options. The
  comment style on `model` (`"passed to the CLI unchanged. No
  validation."`) is the template for `extraArgs`.
- `src/factory.ts` — single construction point that flows the new
  options into both wrappers.

## Dependencies

**None.** No new packages, no toolchain changes. All work is in
existing files plus test files.

## Assumptions & Risks

- **Assumption — Codex global flag ordering.** The
  `--dangerously-bypass-approvals-and-sandbox` flag is documented as a
  top-level option of the `codex` binary (verified via `codex --help`,
  v0.124.0). It is placed *before* the `app-server` / `exec` subcommand,
  same as `-c` and `-m`, which the wrappers already do successfully.
  Verified manually in Step 7.
- **Assumption — `extraArgs` ordering.** `extraArgs` is placed
  *before* the Codex subcommand (`app-server` / `exec`), in the
  **global** flag position, alongside `--dangerously-bypass-approvals-and-sandbox`,
  `-c`, and `-m`. This is required because the persistent wrapper uses
  `app-server`, whose subcommand-flag set does not include `--sandbox`,
  `--ask-for-approval`, or `-c`; placing `extraArgs` after `app-server`
  would make examples like `extraArgs: ['--sandbox', 'read-only']`
  fail. The same global placement is used for the `exec` one-shot path
  for symmetry. Subcommand-specific flags (e.g. `--output-schema` for
  `exec`) are managed by Daphnis directly and are not in scope for
  `extraArgs`.
- **Assumption — Claude `extraArgs` ordering.** For Claude there is no
  subcommand split — the args are simply appended at the end of the
  spawn arg list, after Daphnis-managed flags.
- **Risk — caller mixes `fullAccess: true` and contradicting
  `extraArgs`.** E.g. `fullAccess: true` plus
  `extraArgs: ['--sandbox', 'read-only']`. Daphnis does not validate
  this; the CLI sees both flags and applies its own resolution rule
  (later wins, in practice). JSDoc on `extraArgs` calls this out:
  Daphnis appends `extraArgs` after its own flags, the CLI decides.
- **Risk — Claude-only `--permission-mode` injected on a Codex call via
  `extraArgs`.** Caller responsibility. Daphnis does not know which
  flags belong to which provider — that is the price of a generic
  pass-through. Documented in the JSDoc.
- **Risk — Stream-json Claude with `fullAccess: false` blocks
  silently.** The first tool call hangs because no UI answers the
  permission prompt. This is the breaking change called out above.
  README and `definition.md` both flag it explicitly; users who want a
  middle ground must use `extraArgs: ['--permission-mode', 'auto']`
  (or similar).
- **Risk — Test-only `__resetForTests` leakage from registry tests
  amplifies.** Tests that touch the new args paths still go through the
  factory, which still goes through the registry. The existing
  `afterEach(() => __resetForTests())` pattern in the wrapper test files
  remains in place. No new leakage surface.

## Steps

### Step 1 — `src/types.ts`: extend `AIConversationOptions`

Add two fields, remove one:

```typescript
export interface AIConversationOptions {
  provider: 'claude' | 'codex';
  cwd: string;
  handlers?: AIConversationHandlers;
  binary?: string;
  systemPrompt?: string;
  // clientInfo REMOVED.
  sessionId?: string;
  effort?: Effort;
  model?: string;
  env?: Record<string, string>;
  /**
   * Permit unsandboxed execution. When `true`, Daphnis appends the
   * provider's full-access bypass flag — Claude:
   * `--dangerously-skip-permissions`, Codex:
   * `--dangerously-bypass-approvals-and-sandbox`. When `false` (default),
   * no sandbox/permission flag is added; caller env and CLI config
   * decide. Note: Claude in non-interactive stream-json mode will block
   * on tool calls without a permission flag — set `fullAccess: true`
   * or supply `--permission-mode` via `extraArgs`.
   */
  fullAccess?: boolean;
  /**
   * Extra CLI arguments appended verbatim after Daphnis-managed args.
   * No validation. Provider-specific flags (e.g. `--permission-mode`
   * for Claude, `--sandbox` for Codex) are caller's responsibility.
   */
  extraArgs?: string[];
}
```

The `clientInfo` field is deleted — not commented out, not deprecated,
just gone.

### Step 2 — `src/one-shot.ts`: extend `OneShotOptions`

Mirror the same two new fields:

```typescript
export interface OneShotOptions {
  // ... existing fields ...
  fullAccess?: boolean;
  extraArgs?: string[];
}
```

Same JSDoc text as Step 1, adjusted for the one-shot context (no
stream-json caveat — `runOneShotPrompt` is request/response so a
non-permitted Claude tool call simply errors out via the result
envelope rather than blocking).

### Step 3 — `src/claude-cli-wrapper.ts`: rewire args

Replace the current hard-coded `--dangerously-skip-permissions` with the
`fullAccess` branch, and append `extraArgs` last.

Constructor signature gains `fullAccess?: boolean, extraArgs?: string[]`
*after* `envExtra`. Mechanical:

```typescript
constructor(
  binary: string, cwd: string, instanceId: string,
  handlers?: AIConversationHandlers,
  systemPrompt?: string, sessionId?: string, effort?: Effort, model?: string,
  envExtra?: Record<string, string>,
  fullAccess?: boolean, extraArgs?: string[],
)
```

Args block (replaces the current `--dangerously-skip-permissions` line):

```typescript
const args = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
];
if (fullAccess === true) {
  args.push('--dangerously-skip-permissions');
}
if (sessionId) {
  args.push('--resume', sessionId);
}
// ... existing systemPrompt / effort / model branches unchanged ...
if (extraArgs !== undefined && extraArgs.length > 0) {
  args.push(...extraArgs);
}
```

Order: required flags first, then `fullAccess`, then optional model/
session/system/effort flags (unchanged), then `extraArgs` last.

### Step 4 — `src/codex-cli-wrapper.ts`: rewire args, drop `clientInfo`

Two unrelated changes in the same file, same step because they touch
the same constructor signature.

(a) **Drop `clientInfo` from the constructor signature and the
`initialize()` payload.** Replace:

```typescript
constructor(
  binary: string, cwd: string, instanceId: string,
  handlers?: AIConversationHandlers,
  systemPrompt?: string, clientInfo?: { name: string; title?: string; version: string },
  sessionId?: string, effort?: Effort, model?: string,
  envExtra?: Record<string, string>,
)
```

with:

```typescript
constructor(
  binary: string, cwd: string, instanceId: string,
  handlers?: AIConversationHandlers,
  systemPrompt?: string,
  sessionId?: string, effort?: Effort, model?: string,
  envExtra?: Record<string, string>,
  fullAccess?: boolean, extraArgs?: string[],
)
```

Remove the `private readonly clientInfo: ...` field. Inline the
identifier in `initialize()`:

```typescript
await this.sendJsonRpcRequest('initialize', {
  clientInfo: { name: 'daphnis', title: 'Daphnis', version: '1.0.0' },
  capabilities: { experimentalApi: true },
});
```

(b) **Add `fullAccess` and `extraArgs` to the global-flags array.** The
spawn-time global-flags assembly (currently `:86-94`) becomes:

```typescript
const globalFlags: string[] = [];
if (fullAccess === true) {
  globalFlags.push('--dangerously-bypass-approvals-and-sandbox');
}
if (effort !== undefined) {
  const value = effortToCodexValue(effort);
  if (value !== null) globalFlags.push('-c', `model_reasoning_effort=${value}`);
}
if (model !== undefined) {
  globalFlags.push('-m', model);
}
if (extraArgs !== undefined && extraArgs.length > 0) {
  globalFlags.push(...extraArgs);
}

this.proc = spawn(binary, [...globalFlags, 'app-server'], { ... });
```

Note: `extraArgs` for the persistent wrapper is appended at the end of
the **global** flag block, *before* `app-server`. This is required so
that flags like `--sandbox`, `--ask-for-approval`, and `-c key=value`
land in their valid global position; `app-server` does not accept those
as subcommand flags.

### Step 5 — `src/factory.ts`: thread the new options

Update both branches:

```typescript
case 'claude':
  return new ClaudeCLIWrapper(
    binary, options.cwd, id, options.handlers, options.systemPrompt,
    options.sessionId, options.effort, options.model, options.env,
    options.fullAccess, options.extraArgs,
  );
case 'codex':
  return new CodexCLIWrapper(
    binary, options.cwd, id, options.handlers, options.systemPrompt,
    options.sessionId, options.effort, options.model, options.env,
    options.fullAccess, options.extraArgs,
  );
```

The `options.clientInfo` reference is deleted from the codex branch.

### Step 6 — `src/one-shot.ts`: rewire both providers

#### Claude one-shot (`runClaudeOneShot`)

Replace the hard-coded `--dangerously-skip-permissions` with the
`fullAccess` branch, and append `extraArgs` last:

```typescript
const args: string[] = [
  '-p', opts.prompt,
  '--output-format', 'json',
];
if (opts.fullAccess === true) {
  args.push('--dangerously-skip-permissions');
}
// ... existing systemPrompt / effort / model / outputSchema branches ...
if (opts.extraArgs !== undefined && opts.extraArgs.length > 0) {
  args.push(...opts.extraArgs);
}
```

#### Codex one-shot (`runCodexOneShot`)

Add `fullAccess` and `extraArgs` to the global flags (same placement as
the persistent wrapper, for symmetry and so callers can use the same
`extraArgs` recipe in both modes):

```typescript
const globalFlags: string[] = [];
if (opts.fullAccess === true) {
  globalFlags.push('--dangerously-bypass-approvals-and-sandbox');
}
if (opts.effort !== undefined) { /* unchanged */ }
if (opts.model !== undefined) { /* unchanged */ }
if (opts.extraArgs !== undefined && opts.extraArgs.length > 0) {
  globalFlags.push(...opts.extraArgs);
}

const execArgs: string[] = ['--output-last-message', outputFile];
if (opts.outputSchema !== undefined) { /* unchanged */ }

const args = [...globalFlags, 'exec', ...execArgs, finalPrompt];
```

JSDoc on `extraArgs` (Step 2) notes that for Codex (both modes) the args
land in the global flag position, *before* the subcommand.

### Step 7 — Tests

Five test files touched.

#### Existing: `src/__tests__/claude-cli-wrapper.test.ts`

Mechanical signature update for direct `new ClaudeCLIWrapper(...)`
calls — add the two new trailing optional positional args (or pass
`undefined`) where the test does not care. Estimate 2-4 sites.

New test cases (in a new `describe('fullAccess and extraArgs')`):

- Default (no `fullAccess` in options): spawn args do **not** contain
  `--dangerously-skip-permissions`.
- `fullAccess: true`: spawn args contain `--dangerously-skip-permissions`
  exactly once.
- `fullAccess: false`: spawn args do **not** contain
  `--dangerously-skip-permissions` (explicit-false equals omitted).
- `extraArgs: ['--permission-mode', 'auto']`: those two strings appear
  at the end of the spawn args, in order.
- `fullAccess: true` + `extraArgs: ['--permission-mode', 'plan']`:
  `--dangerously-skip-permissions` precedes `--permission-mode plan`
  (order assertion).

#### Existing: `src/__tests__/codex-cli-wrapper.test.ts`

Mechanical: drop `clientInfo` from any test that passed it; the test
at line 173 (`uses custom clientInfo when provided`) is **deleted**, and
the test at line 108 (`sends initialize with experimentalApi and
configurable clientInfo`) is renamed to `sends initialize with
experimentalApi and hardcoded daphnis clientInfo` and asserts the
hardcoded value `{ name: 'daphnis', title: 'Daphnis', version: '1.0.0' }`.

New test cases (mirror Claude):

- Default: spawn args do **not** contain
  `--dangerously-bypass-approvals-and-sandbox`.
- `fullAccess: true`: spawn args contain that flag exactly once,
  *before* `app-server`.
- `extraArgs: ['--sandbox', 'read-only']`: those strings appear in the
  global flag block (i.e. before `app-server`), in order.
- `fullAccess: true` + `extraArgs: ['--ask-for-approval', 'never']`:
  bypass flag and the two extra strings all appear before `app-server`,
  with the bypass flag preceding `extraArgs` (Daphnis-managed flags
  first, then `extraArgs`).

#### Existing: `src/__tests__/factory.test.ts`

Add a case that confirms `fullAccess` and `extraArgs` flow through to
the Claude wrapper (verify via the spawn args of a created instance, or
mock the wrapper constructor and assert it received the values).
Mirror for Codex. The deleted `clientInfo` should not appear in any
factory test.

#### Existing: `src/__tests__/one-shot.test.ts`

New cases for both providers, parallel to the wrapper test cases:

- Claude: default omits the bypass flag; `fullAccess: true` adds it.
- Codex: default omits the bypass flag; `fullAccess: true` adds it
  before `exec`.
- Claude: `extraArgs` appears at end of args.
- Codex: `extraArgs` appears in the global flag block, *before* `exec`
  (same placement as the persistent wrapper).

#### Existing: `src/__tests__/registry.test.ts`

No changes — registry tests do not touch args assembly.

### Step 8 — Public API: `src/index.ts`

No additions needed — `AIConversationOptions` and `OneShotOptions` are
already re-exported, and the new fields ride on those types
automatically. Nothing else moves into the public surface.

Steps 1-8 conclude the Implementation phase per CLAUDE.md §5. At this
point the Coder stops and waits for Validation. Doc Update and Archive
below are separate phases (§6 and §7) and run only when the next-step
prompt arrives — they are listed here for plan self-containedness, not
as steps the Coder executes during Implementation.

## Doc Update (post-Validation, CLAUDE.md §6)

Run only after Validation has signed off via `<approved>`.

- **`docs/definition.md`:**
  - Under "In scope", add a bullet:
    `fullAccess` flag + `extraArgs` pass-through, uniform across
    providers and modes (streaming + one-shot).
  - Under "Out of scope (deliberately)", tighten the
    "Provider-specific features…" bullet so it is clear that
    provider-specific *args* are now expressible via `extraArgs` —
    Daphnis still does not abstract them.
  - Remove any mention of `clientInfo` if it appears (a quick grep —
    it should not, but worth checking).
- **`docs/architecture.md`:**
  - Update the data-flow blocks under "Persistent conversation (Claude)"
    and "One-shot (Claude)" to drop the unconditional
    `--dangerously-skip-permissions` from the spawn lines and replace
    with `[--dangerously-skip-permissions if fullAccess]`. Same for
    Codex (add `[--dangerously-bypass-approvals-and-sandbox if
    fullAccess]` to the global-flags list).
  - Add a new subsection under "Design decisions" titled
    **"Sandbox policy and pass-through args"** covering: the boolean as
    a declarative knob, why no enum (Codex sandbox enum has no Claude
    equivalent in non-interactive mode), the breaking-change rationale
    for Claude (was always bypass, now explicit), the
    pass-through-without-validation pattern shared with `model` / `env`,
    and the explicit scope statement that `fullAccess` controls only
    the CLI flag, not the JSON-RPC auto-approval layer.
  - Under the existing "Codex permission handshake" subsection, append
    one paragraph noting that `fullAccess: true` short-circuits both
    the OS-level Codex sandbox **and** the JSON-RPC approval round-trip
    (Codex emits no approval requests once the bypass flag is set),
    while `fullAccess: false` leaves the auto-approval policy in place
    unchanged from today — the CLI sandbox (or `extraArgs`-supplied
    `--sandbox …`) is what gates risky ops in that mode.
- **`README.md`:**
  - Add a short "Sandbox / permissions" subsection under "What it does"
    or near "Environment hygiene", explaining `fullAccess` (default:
    no provider bypass flag is appended — the CLI's own config decides;
    `true` appends the bypass flag for tests / CI use), `extraArgs`
    (caller-managed provider-specific flags, with one Claude and one
    Codex example), and the explicit scope note that Codex's
    JSON-RPC auto-approval layer is unchanged regardless of
    `fullAccess` — callers must not infer a stronger sandbox guarantee
    than the CLI itself enforces.
  - Bump the version reference in the README install snippet if any.
- **`docs/backlog.kanban.md`:** Move any card that referenced this
  work to Done if it exists. (None found at plan-write time, so most
  likely a no-op.)
- **Version bump (both files, edited directly — no package manager
  invocation per CLAUDE.md Rule 11):**
  - `package.json` — bump `"version": "2.1.0"` → `"3.0.0"`.
  - `package-lock.json` — bump `"version"` at the top level (line 3)
    and in `packages[""].version` (line 9) to match. The
    `name` / `lockfileVersion` fields are unchanged. No `npm install`
    is run; both fields are edited directly because no dependencies
    change.

## Archive & Commit (CLAUDE.md §7)

Run only after Doc Update is complete.

Move `docs/PLAN_full_access.md` to `docs/archive/PLAN_full_access.md`
and commit all changes from this session in a single Git commit.

## Verification

All commands from repo root. Run after Step 8 (end of Implementation).

1. **Build passes.** `npm run build` — no TypeScript errors. Critical:
   `clientInfo` deletion plus signature changes means stale references
   would break compilation.
2. **Tests pass.** `npm test` — full vitest suite green. The new args
   assertions (Step 7) cover both providers and both modes.
3. **Specific assertions catching regressions.**
   - Claude wrapper without `fullAccess`: `--dangerously-skip-permissions`
     **must not** appear in `spawn` args. (Catches a future code path
     that re-introduces the unconditional flag.)
   - Claude wrapper with `fullAccess: true`: flag appears exactly once.
   - Codex wrapper with `fullAccess: true`: flag appears in *global*
     position (before `app-server`), not after.
   - `extraArgs` order asserted explicitly — Claude appends at end of
     args; Codex (both modes) appends at the end of the global-flag
     block, before the subcommand.
   - Codex initialise payload: `clientInfo` is the hardcoded
     `{ name: 'daphnis', title: 'Daphnis', version: '1.0.0' }`. (Catches
     a regression that re-exposes the override.)
4. **Manual smoke (single run, optional but recommended before
   release):**

   ```bash
   # Codex full-access, network-using prompt
   node -e "import('./dist/index.js').then(({runOneShotPrompt}) => \
     runOneShotPrompt({ provider: 'codex', cwd: process.cwd(), \
       prompt: 'curl https://example.com -s | head -c 50', \
       fullAccess: true, timeoutMs: 60000 }) \
       .then(r => console.log(r.text)))"
   ```

   Expected: HTML snippet from example.com. Without `fullAccess: true`,
   the same call would either hang (sandbox denial loop) or return an
   error envelope.
5. **Public API surface unchanged in shape.** Diff `dist/index.d.ts`
   before/after: `AIConversationOptions` gains two fields, loses one
   (`clientInfo`). No other type movement. `OneShotOptions` gains two
   fields. Nothing else changes. Visually verify.
6. **`clientInfo` removed from public surface.** Two precise checks:
   - `grep -nE '^\s*clientInfo\?:' src/types.ts` returns no hits
     (no public option field).
   - `grep -nE 'private readonly clientInfo|clientInfo\?:' src/codex-cli-wrapper.ts`
     returns no hits (no private field, no constructor parameter).
   - `grep -n "clientInfo:" src/codex-cli-wrapper.ts` **must** still
     return exactly one hit — the hardcoded JSON-RPC payload key in
     `initialize()`. That is intentional and not a regression.

<plan_ready>docs/PLAN_full_access.md</plan_ready>
