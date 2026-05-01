# PLAN: Preflight (provider list + binary probe)

## Context & Goal

Daphnis bietet aktuell keine Möglichkeit, vor dem ersten echten Aufruf zu
prüfen, ob die CLI-Binaries (`claude`, `codex`) im Caller-Environment
überhaupt erreichbar sind. Caller behelfen sich mit `runOneShotPrompt`,
was teuer ist (echter Modellaufruf, Auth-Roundtrip, kostenpflichtig).

Außerdem fehlt eine Auflistung der von Daphnis unterstützten Provider.
Die Provider-Identität ist heute mehrfach im Quellcode codiert: als
TypeScript-Union `'claude' | 'codex'` (`src/types.ts:64`,
`src/one-shot.ts:29`, `src/registry.ts:15`, `src/registry.ts:27`,
`src/sessions.ts:254`, `src/sessions.ts:379`) und als Switch-Branches in
`src/factory.ts` und `src/one-shot.ts`. Perspektivisch sollen weitere
Provider (lmstudio, grok, gemini, …) hinzukommen.

**Goal:** Zwei neue Public-API-Funktionen plus eine zentrale
Runtime-Source-of-Truth für die Liste der unterstützten Provider:

- `listSupportedProviders(): string[]` — sync, statische Liste der von
  Daphnis unterstützten Provider-Namen.
- `checkProvider(name, options?): Promise<ProviderCheckResult>` — async,
  spawnt `<binary> --version`, gibt Detail-Objekt mit `available`,
  optional `version`, optional `error` zurück. Kein Modellaufruf, kein
  Auth-Roundtrip — nur Binary-Probe.
- `SUPPORTED_PROVIDERS` (intern, nicht re-exportiert) als zentrale
  Konstante in `src/providers.ts`. `factory.ts` und `one-shot.ts`
  validieren ihren `provider`-Parameter via `assertSupportedProvider`
  gegen diese Liste — damit gibt es nach diesem Plan **eine**
  Runtime-Quelle, gegen die `listSupportedProviders` und die beiden
  öffentlichen Entry-Points alle prüfen. `listSupportedProviders` kann
  nicht mehr von „was Daphnis tatsächlich akzeptiert" driften.

Beide neuen Funktionen bleiben innerhalb des „Wrapper, nichts mehr"-
Anspruchs aus `definition.md`: Auth bleibt out-of-scope, der Probe-Call
ist ein reiner Binary-Reachability-Check.

**Out of scope (separat getrackt):** Die TypeScript-Union
`'claude' | 'codex'` als *Type* an den Call-Sites
(`AIConversationOptions.provider`, `OneShotOptions.provider`,
`InstanceInfo.provider`, `RegistryEntry.provider`, `listSessions`-
Parameter, `loadSessionHistory`-Parameter) wird in diesem Plan **nicht**
zentralisiert. Der Human hat in Discussion festgelegt, dass diese
Type-Sites perspektivisch auf `string` gelockert werden, damit neue
Provider ohne Breaking Change am Type-System aufgenommen werden können
— das ist ein eigenständiger Refactor mit eigener Verifikation und wird
als Backlog-Karte angelegt (Schritt 8).

## Breaking Changes

**No.** Reine Erweiterung der Public API um zwei neue Exporte. Keine
Änderung an bestehenden Signaturen, Events, oder Verhalten.

## Reference Patterns

- `src/one-shot.ts` — Vorbild für Spawn-Helper-Pattern: `ENV_BLACKLIST`,
  `filterEnv()`, `spawnAndCollect()`-Stil mit `stdio: ['ignore', 'pipe',
  'pipe']`, Resolve auf `'close'` (nicht `'exit'`), Timeout via
  `setTimeout` + `SIGTERM` mit weiterem Warten auf `'close'` zum Drain.
- `src/factory.ts:22-23` — Vorbild für „unknown provider" Throw-Pattern.
- `src/index.ts` — alle neuen Exporte werden hier re-exportiert.
- `src/__tests__/one-shot.test.ts` — Vorbild für Test-Pattern mit
  gemocktem `node:child_process`.

## Dependencies

Keine neuen Runtime- oder Dev-Dependencies.

## Assumptions & Risks

- **`--version`-Konvention.** Sowohl `claude` als auch `codex`
  unterstützen `--version` und antworten mit Exitcode 0 plus Versions-
  String auf stdout. Wenn ein zukünftiger Provider eine andere
  Konvention nutzt (`-v`, `version`-Subcommand, kein Flag), muss der
  Probe-Call pro Provider konfigurierbar werden. Heute hartkodiert; bei
  drittem Provider ist eine `providers.ts`-Map mit pro-Provider
  Probe-Config der Migrations-Pfad (out of scope für diesen Plan).
- **Timeout-Default 5_000 ms.** Eine Versionsabfrage soll schnell sein.
  Bei Timeout liefert `checkProvider` `available: false` mit Error-Text;
  der Child wird via `SIGTERM` beendet und der Drain auf `'close'`
  abgewartet (analog zu `one-shot.ts`).
- **`ENV_BLACKLIST` ist bereits 3× dupliziert** (claude-wrapper,
  codex-wrapper, one-shot). `providers.ts` wird die vierte Kopie. Rule
  8 verbietet Refactoring außerhalb des Plan-Scopes; stattdessen wird
  in Schritt 10 eine Backlog-Karte für die spätere Konsolidierung
  angelegt.
- **`unknown provider` ist Programmierfehler.** `checkProvider('foo')`
  wirft (matched `factory.ts:22-23`), statt `{available: false}` zu
  returnen. Das hält die Funktion ehrlich: ein nicht-supported Name ist
  kein Reachability-Issue.

## Steps

### 1. Neues Modul `src/providers.ts`

`SUPPORTED_PROVIDERS` ist die zentrale Runtime-Liste; `assertSupportedProvider`
ist der Guard, gegen den auch `factory.ts` und `one-shot.ts` validieren
(siehe Schritte 2 und 3). `listSupportedProviders` und `checkProvider`
lesen aus derselben Konstante — keine Drift zwischen „was die API meldet"
und „was die Factory akzeptiert".

Inhalt:

```ts
import { spawn } from 'node:child_process';

export const SUPPORTED_PROVIDERS = ['claude', 'codex'] as const;

export function assertSupportedProvider(provider: string): void {
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
}

const ENV_BLACKLIST = new Set([
  'NODE_OPTIONS',
  'VSCODE_INSPECTOR_OPTIONS',
  'VSCODE_PID',
  'VSCODE_IPC_HOOK',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDECODE',
]);

function filterEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !ENV_BLACKLIST.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function listSupportedProviders(): string[] {
  return [...SUPPORTED_PROVIDERS];
}

export interface ProviderCheckResult {
  provider: string;
  available: boolean;
  binary: string;
  version?: string;
  error?: string;
}

export interface CheckProviderOptions {
  binary?: string;
  /** Hard cap. Child is SIGTERM-killed if exceeded. Default 5_000. */
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function checkProvider(
  provider: string,
  options?: CheckProviderOptions,
): Promise<ProviderCheckResult> {
  assertSupportedProvider(provider);
  // Default binary = provider name. Both currently supported CLIs follow
  // this convention; if a future provider deviates, switch to a per-
  // provider map at that point.
  const binary = options?.binary ?? provider;
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const env = { ...filterEnv(), ...(options?.env ?? {}) };

  return new Promise<ProviderCheckResult>((resolve) => {
    let proc;
    try {
      proc = spawn(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      resolve({
        provider, binary, available: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    }, timeoutMs);

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        provider, binary, available: false,
        error: err.message,
      });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          provider, binary, available: false,
          error: `timed out after ${timeoutMs} ms`,
        });
        return;
      }
      if (code === 0) {
        resolve({
          provider, binary, available: true,
          version: stdout.trim() || undefined,
        });
        return;
      }
      resolve({
        provider, binary, available: false,
        error: `exited ${code}: ${(stderr || stdout).slice(0, 500).trim()}`,
      });
    });
  });
}
```

Anmerkungen zur Implementierung:

- **Resolve auf `'close'`, nicht `'exit'`** — gleiche Begründung wie in
  `one-shot.ts:282-294` und `architecture.md` „One-shot resolves on
  `close`, not `exit`": `exit` kann feuern während stdout/stderr noch
  Buffered Data haben.
- **Timeout sendet `SIGTERM` und wartet weiter** — `settled` wird erst
  in `'close'` gesetzt, damit der Drain-Invariant gewahrt bleibt.
- **Kein `throw` aus dem Promise heraus außer für `unknown provider`**
  — Detektion soll nicht try/catch erzwingen.
- **`spawn`-Throw-Path** ist defensiv (sehr selten — meist liefert Node
  ENOENT als `'error'`-Event); fängt z.B. ungültige Binary-Strings ab.
- **`version: stdout.trim() || undefined`** — leerer String wird zu
  `undefined`, damit das Optional-Feld konsistent abwesend ist statt
  als `""` zu erscheinen.

### 2. `src/factory.ts` an die zentrale Provider-Liste binden

Aktuell (`src/factory.ts:6-25`) prüft `factory.ts` Provider-Namen
implizit über den `switch` und wirft im `default`. Der Default-Binary
wird über einen redundanten Ternary-Ausdruck bestimmt
(`options.provider === 'claude' ? 'claude' : 'codex'`). Beides wird
durch einen expliziten Aufruf des zentralen Guards ersetzt:

```ts
import { assertSupportedProvider } from './providers.js';

export function createAIConversation(options: AIConversationOptions): AIConversationInstance {
  assertSupportedProvider(options.provider);
  const binary = options.binary ?? options.provider;
  const id = randomUUID();
  switch (options.provider) {
    case 'claude':
      return new ClaudeCLIWrapper(/* unchanged */);
    case 'codex':
      return new CodexCLIWrapper(/* unchanged */);
    default:
      // Defensive — `assertSupportedProvider` already threw, but the
      // exhaustiveness check requires a default branch.
      throw new Error(`Unknown provider: ${options.provider as string}`);
  }
}
```

Die TypeScript-Union des `provider`-Parameters bleibt unverändert
(`'claude' | 'codex'`); der Guard fügt ausschließlich Runtime-Validierung
gegen die zentrale Liste hinzu. Der Switch und das `default`-Throw
bleiben — sie sind die Code-Branches, die für jeden Provider eine
Wrapper-Klasse instanziieren, und können nicht durch Datenstrukturen
ersetzt werden, ohne Konstruktor-Signaturen zu vereinheitlichen
(separater Refactor).

### 3. `src/one-shot.ts` an die zentrale Provider-Liste binden

Analog zu Schritt 2: in `runOneShotPrompt` (`src/one-shot.ts:80-91`)
oben `assertSupportedProvider(options.provider)` einfügen, das
existierende `default`-Throw im Switch bleibt als Defensive.

```ts
import { assertSupportedProvider } from './providers.js';

export async function runOneShotPrompt<T = unknown>(
  options: OneShotOptions,
): Promise<OneShotResult<T>> {
  assertSupportedProvider(options.provider);
  switch (options.provider) {
    case 'claude':
      return runClaudeOneShot<T>(options);
    case 'codex':
      return runCodexOneShot<T>(options);
    default:
      throw new Error(`Unknown provider: ${options.provider as string}`);
  }
}
```

### 4. Public API in `src/index.ts` ergänzen

Drei Zeilen an passender Stelle einfügen:

```ts
export { listSupportedProviders, checkProvider } from './providers.js';
export type { ProviderCheckResult, CheckProviderOptions } from './providers.js';
```

`SUPPORTED_PROVIDERS` und `assertSupportedProvider` werden **nicht**
re-exportiert — sie sind ein Implementierungs-Detail der zentralen
Liste. Konsumenten enumerieren via `listSupportedProviders()`.

### 5. Tests in `src/__tests__/providers.test.ts`

Neue Test-Datei. Mockt `node:child_process` analog zu
`src/__tests__/one-shot.test.ts`. Test-Cases:

- `listSupportedProviders()` returns exactly `['claude', 'codex']`.
- `listSupportedProviders()` returns a fresh array each call (no shared
  reference; mutating the result must not affect subsequent calls).
- `checkProvider('claude')` resolves `{available: true, version: '...',
  binary: 'claude'}` when the fake child exits 0 with stdout
  `"1.2.3\n"`.
- `checkProvider('claude')` returns `available: false` with `error`
  containing the exit code when the fake child exits non-zero.
- `checkProvider('claude')` returns `available: false` with `error`
  containing `'ENOENT'` when the fake `'error'` event fires.
- `checkProvider('claude', { timeoutMs: 50 })` returns `available:
  false` with `error: 'timed out after 50 ms'` when the fake child
  never exits within the window. Verify `proc.kill('SIGTERM')` was
  called.
- `checkProvider('foo')` throws `Error: Unknown provider: foo`
  synchronously (not via Promise rejection — verify with
  `expect(() => checkProvider('foo')).toThrow()`).
- `checkProvider('claude', { binary: '/custom/path' })` spawns
  `/custom/path --version` (assert via mock spy on `spawn`).
- `checkProvider('claude', { env: { FOO: 'bar' } })` merges caller env
  on top of the filtered process env (assert FOO is present, blacklist
  keys are absent).

#### Guard-Tests in bestehenden Test-Dateien

Nach den Refactors aus Schritt 2 und 3 muss in **beiden** Entry-Points
der Throw bei unbekanntem Provider getestet sein. Status:

- `src/__tests__/factory.test.ts:85-89` enthält bereits einen
  `'throws for unknown provider'`-Test mit der Message
  `'Unknown provider: unknown'`. Da der Refactor in Schritt 2 dieselbe
  Error-Message beibehält (jetzt aus `assertSupportedProvider`), bleibt
  dieser Test ohne Änderung gültig — keine Anpassung nötig.
- `src/__tests__/one-shot.test.ts` hat aktuell **keinen** entsprechenden
  Guard-Test. Einen ergänzen, analog zum Factory-Test, aber als
  Promise-Rejection statt synchronem Throw — `runOneShotPrompt` ist
  `async`, also wickelt das Sprachen-Runtime jeden geworfenen Error in
  eine rejected Promise:

  ```ts
  it('rejects for unknown provider', async () => {
    await expect(
      runOneShotPrompt({
        provider: 'unknown' as 'claude',
        cwd: '/tmp',
        prompt: 'hi',
      }),
    ).rejects.toThrow('Unknown provider: unknown');
  });
  ```

  Test gehört in den passenden `describe`-Block in
  `src/__tests__/one-shot.test.ts`. Es darf **kein** `spawn` aufgerufen
  werden — der Guard greift vor dem Provider-Switch. Asserten via
  `expect(mockSpawn).not.toHaveBeenCalled()` falls der Mock im
  Test-Scope verfügbar ist.

### 6. Build & Tests

- `npm run build` → `tsc` muss ohne Fehler durchlaufen.
- `npm test` → alle Tests grün, die neuen Tests laufen mit.

### 7. README-Update

Im Abschnitt nach „Session discovery" einen neuen Absatz einfügen, kurz
und im Stil des bestehenden README:

```markdown
**Preflight.** `listSupportedProviders()` returns the static list of
provider names Daphnis knows how to drive. `checkProvider(name)` spawns
`<binary> --version` and resolves with `{available, binary, version?,
error?}` — a lightweight reachability probe with no model call and no
auth round-trip. For an end-to-end auth check, use `runOneShotPrompt`
with a minimal prompt.
```

Außerdem in der „LLM Reference"-Sektion am Ende des README die
Funktionsliste und das Public API-Surface-Statement ergänzen
(`listSupportedProviders`, `checkProvider`, `ProviderCheckResult`,
`CheckProviderOptions`).

### 8. Doc-Update `docs/definition.md`

Im „In scope"-Bullet-Block einen neuen Punkt einfügen (zwischen
`listInstances` und „Uniform effort levels"):

```markdown
- `listSupportedProviders()` / `checkProvider(name)` — preflight
  surface. `listSupportedProviders()` returns the static list of
  provider names. `checkProvider` spawns `<binary> --version` as a
  lightweight binary-reachability probe (no model call, no auth).
  Throws on unknown provider names.
```

### 9. Doc-Update `docs/architecture.md`

- In der „Repository layout"-Section den neuen `src/providers.ts`
  eintragen (zwischen `registry.ts` und `effort-mapping.ts`):

  ```
  ├── providers.ts           # listSupportedProviders, checkProvider
  ```

- In „Public API" die zwei neuen Exporte ergänzen.

- Neue Subsection unter „Design decisions":

  ```markdown
  ### Preflight as binary probe only

  `checkProvider(name)` spawns `<binary> --version` and resolves with a
  result object. It does not invoke the model and does not touch
  authentication — auth remains out of scope per `definition.md`. A
  caller who needs end-to-end verification (model reachable, auth
  configured) composes `runOneShotPrompt` with a minimal prompt; the
  preflight does not encapsulate that decision.

  Probe-flag is hardcoded to `--version` because both supported CLIs
  honour the convention. When a provider with a different convention
  is added, the per-provider probe config moves into a `providers.ts`
  map; this is a bounded follow-up, not a current concern.

  Unknown provider names throw synchronously rather than resolving to
  `{available: false}`. A non-supported name is a programming error,
  not a runtime reachability condition — same stance as
  `factory.ts`'s switch default.
  ```

### 10. Backlog-Cards für Folge-Refactors

Zwei neue Karten in `docs/backlog.kanban.md`, jeweils unter `## Open`,
im exakten Format des Boards (`id: {new}`-Platzhalter — der
`markdown-kanban`-Konvention nach werden diese vom Processing-System
beim Parsen mit echten IDs ersetzt; siehe Header-Kommentar in
`docs/backlog.kanban.md:60-62`).

Karte 1 (`## Open`):

```
### Consolidate ENV_BLACKLIST + filterEnv into a shared module
id: {new}
priority: low

`ENV_BLACKLIST` and `filterEnv()` are duplicated across
`claude-cli-wrapper.ts`, `codex-cli-wrapper.ts`, `one-shot.ts`, and
(after PLAN_preflight) `providers.ts`. Extract to `src/env-filter.ts`
and import from all four. No behaviour change, pure refactor.
```

Karte 2 (`## Open`):

```
### Loosen provider type from union to string
id: {new}
priority: medium

After PLAN_preflight, `SUPPORTED_PROVIDERS` in `src/providers.ts` is
the central runtime list. The TypeScript type at the call sites
(`AIConversationOptions.provider`, `OneShotOptions.provider`,
`InstanceInfo.provider`, `RegistryEntry.provider`, `listSessions` and
`loadSessionHistory` parameters) is still the literal union
`'claude' | 'codex'`. Loosen these to `string` (or to a derived
type-alias re-exported from `providers.ts`) so a third provider can
be added without a public-API breaking change at the type level. The
runtime validation is already centralised via
`assertSupportedProvider`. Breaking change at the type level —
needs its own plan with explicit verification of consumer
compatibility.
```

## Verification

1. **Build:** `npm run build` exits 0, no TypeScript errors.
2. **Tests:** `npm test` exits 0, alle Tests aus
   `src/__tests__/providers.test.ts` grün, alle bestehenden Tests
   weiterhin grün.
3. **Manual smoke test (only if `claude` and `codex` binaries are
   actually installed locally):**
   ```bash
   node -e "
   import('./dist/index.js').then(async (m) => {
     console.log('supported:', m.listSupportedProviders());
     console.log('claude:', await m.checkProvider('claude'));
     console.log('codex:',  await m.checkProvider('codex'));
   });
   "
   ```
   Expected: `supported: ['claude', 'codex']`, both checks return
   `available: true` with a `version` string.
4. **Negative manual smoke test:**
   ```bash
   node -e "
   import('./dist/index.js').then(async (m) => {
     console.log(await m.checkProvider('claude', { binary: '/no/such/bin' }));
     try { await m.checkProvider('foo'); } catch (e) { console.log('threw:', e.message); }
   });
   "
   ```
   Expected: erste Zeile `available: false` mit ENOENT-Error; zweite
   Zeile `threw: Unknown provider: foo`.
5. **Public API surface check:** `grep -E "^export" src/index.ts` listet
   die neuen Exporte (`listSupportedProviders`, `checkProvider`,
   `ProviderCheckResult`, `CheckProviderOptions`). `SUPPORTED_PROVIDERS`
   und `assertSupportedProvider` sind **nicht** in `index.ts` re-exportiert.
6. **Single-source-of-truth check:** `grep -n "Unknown provider" src/`
   zeigt die Throw-Stellen — sie müssen entweder von
   `assertSupportedProvider` (in `providers.ts`) kommen oder als
   Defensive-Default in den bestehenden Switches in `factory.ts` und
   `one-shot.ts` stehen. Beide Entry-Points sind testseitig durch je
   einen Guard-Test abgedeckt: `src/__tests__/factory.test.ts:85-89`
   (existierend, Sync-Throw) und der in Schritt 5 neu ergänzte
   `'rejects for unknown provider'`-Test in
   `src/__tests__/one-shot.test.ts` (Promise-Rejection, da
   `runOneShotPrompt` `async` ist). Der One-Shot-Guard-Test prüft
   zusätzlich, dass `spawn` **nicht** aufgerufen wurde — der Guard
   muss vor jeglichem Child-Process greifen.
7. **Doc-Konsistenz:** `definition.md`, `architecture.md`, `README.md`
   listen die neuen Exporte; `backlog.kanban.md` enthält **beide**
   neuen Karten unter `## Open`, jede mit `id: {new}` und
   `priority:`-Feld.
