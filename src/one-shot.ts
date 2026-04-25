import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Effort } from './types.js';
import { effortToClaudeFlag, effortToCodexValue } from './effort-mapping.js';

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

export interface OneShotOptions {
  provider: 'claude' | 'codex';
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  binary?: string;
  effort?: Effort;
  model?: string;
  env?: Record<string, string>;
  /** Hard cap. Child is SIGTERM-killed if exceeded. Default 180_000. */
  timeoutMs?: number;
  /** JSON Schema (POJO). When set, the CLI is driven with schema enforcement. */
  outputSchema?: object;
  /**
   * Optional cancellation. If the signal aborts before the child exits, the
   * helper kills the child (SIGTERM) and rejects with an `AbortError`.
   */
  signal?: AbortSignal;
  /**
   * Permit unsandboxed execution. When `true`, Daphnis appends the provider's
   * full-access bypass flag — Claude: `--dangerously-skip-permissions`,
   * Codex: `--dangerously-bypass-approvals-and-sandbox`. When `false`
   * (default), no sandbox/permission flag is added; caller env and CLI
   * config decide.
   */
  fullAccess?: boolean;
  /**
   * Extra CLI arguments appended verbatim after Daphnis-managed args. No
   * validation. Provider-specific flags (e.g. `--permission-mode` for
   * Claude, `--sandbox` for Codex) are caller's responsibility. For Codex,
   * `extraArgs` lands in the global flag position, before the `exec`
   * subcommand.
   */
  extraArgs?: string[];
}

export interface OneShotResult<T = unknown> {
  /**
   * Final assistant text. For Claude: the `.result` field of the JSON envelope.
   * For Codex: contents of the `--output-last-message` file.
   */
  text: string;
  /**
   * Present iff `outputSchema` was set AND the provider returned parseable
   * JSON. Not validated against the schema beyond JSON.parse — caller
   * revalidates as defense in depth.
   */
  structured?: T;
  sessionId: string | null;
  exitCode: number | null;
}

export async function runOneShotPrompt<T = unknown>(
  options: OneShotOptions,
): Promise<OneShotResult<T>> {
  switch (options.provider) {
    case 'claude':
      return runClaudeOneShot<T>(options);
    case 'codex':
      return runCodexOneShot<T>(options);
    default:
      throw new Error(`Unknown provider: ${options.provider as string}`);
  }
}

async function runClaudeOneShot<T>(opts: OneShotOptions): Promise<OneShotResult<T>> {
  const binary = opts.binary ?? 'claude';
  const args: string[] = [
    '-p', opts.prompt,
    '--output-format', 'json',
  ];
  if (opts.fullAccess === true) {
    args.push('--dangerously-skip-permissions');
  }
  if (opts.systemPrompt !== undefined) {
    args.push('--system-prompt', opts.systemPrompt);
  }
  if (opts.effort !== undefined) {
    const flag = effortToClaudeFlag(opts.effort);
    if (flag !== null) args.push('--effort', flag);
  }
  if (opts.model !== undefined) {
    args.push('--model', opts.model);
  }
  if (opts.outputSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(opts.outputSchema));
  }
  if (opts.extraArgs !== undefined && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  const { stdout, exitCode } = await spawnAndCollect({
    binary,
    args,
    cwd: opts.cwd,
    env: { ...filterEnv(), ...(opts.env ?? {}) },
    timeoutMs: opts.timeoutMs ?? 180_000,
    signal: opts.signal,
  });

  if (exitCode !== 0) {
    throw new Error(`Claude CLI exited ${exitCode}: ${stdout.slice(0, 500)}`);
  }

  const envelope = JSON.parse(stdout) as {
    result?: string;
    session_id?: string;
    structured_output?: unknown;
    is_error?: boolean;
  };
  if (envelope.is_error === true) {
    throw new Error(`Claude CLI reported error: ${envelope.result ?? 'unknown'}`);
  }

  const text = envelope.result ?? '';
  const sessionId = envelope.session_id ?? null;
  const structured = opts.outputSchema !== undefined
    ? (envelope.structured_output as T | undefined)
    : undefined;

  return { text, structured, sessionId, exitCode };
}

async function runCodexOneShot<T>(opts: OneShotOptions): Promise<OneShotResult<T>> {
  const binary = opts.binary ?? 'codex';
  const tmpRoot = await mkdtemp(join(tmpdir(), 'daphnis-oneshot-'));
  const schemaFile = join(tmpRoot, `schema-${randomUUID()}.json`);
  const outputFile = join(tmpRoot, `message-${randomUUID()}.txt`);

  try {
    const globalFlags: string[] = [];
    if (opts.fullAccess === true) {
      globalFlags.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (opts.effort !== undefined) {
      const value = effortToCodexValue(opts.effort);
      if (value !== null) globalFlags.push('-c', `model_reasoning_effort=${value}`);
    }
    if (opts.model !== undefined) {
      globalFlags.push('-m', opts.model);
    }
    if (opts.extraArgs !== undefined && opts.extraArgs.length > 0) {
      globalFlags.push(...opts.extraArgs);
    }

    const execArgs: string[] = ['--output-last-message', outputFile];
    if (opts.outputSchema !== undefined) {
      await writeFile(schemaFile, JSON.stringify(opts.outputSchema));
      execArgs.push('--output-schema', schemaFile);
    }

    // `codex exec` has no dedicated system-prompt flag — we prepend. Single-shot
    // nature means ordering is sufficient.
    const finalPrompt = opts.systemPrompt !== undefined
      ? `${opts.systemPrompt}\n\n${opts.prompt}`
      : opts.prompt;

    const args = [...globalFlags, 'exec', ...execArgs, finalPrompt];

    const { exitCode, stderr } = await spawnAndCollect({
      binary,
      args,
      cwd: opts.cwd,
      env: { ...filterEnv(), ...(opts.env ?? {}) },
      timeoutMs: opts.timeoutMs ?? 180_000,
      signal: opts.signal,
    });

    if (exitCode !== 0) {
      throw new Error(`Codex CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const text = await readFile(outputFile, 'utf-8');
    let structured: T | undefined;
    if (opts.outputSchema !== undefined) {
      try { structured = JSON.parse(text) as T; } catch { structured = undefined; }
    }

    return { text, structured, sessionId: null, exitCode };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function spawnAndCollect(params: {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    if (params.signal?.aborted === true) {
      reject(abortError());
      return;
    }

    const proc = spawn(params.binary, params.args, {
      cwd: params.cwd,
      // stdin intentionally `ignore` — one-shot needs no input stream. This
      // is why the child exits cleanly on its own after writing output.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: params.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });

    let settled = false;
    let timedOut = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (abortListener !== null) {
        params.signal?.removeEventListener('abort', abortListener);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      // Wait for `close` below before settling, to preserve the drain
      // invariant on the kill path.
    }, params.timeoutMs);

    const abortListener: (() => void) | null = params.signal
      ? (): void => {
          try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        }
      : null;
    if (abortListener !== null) {
      params.signal!.addEventListener('abort', abortListener, { once: true });
    }

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    // Resolve on `close`, not `exit`. `exit` can fire while stdout/stderr
    // still have buffered data; resolving there produces intermittent
    // truncated envelopes that fail JSON.parse. `close` guarantees all
    // stdio streams are drained.
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (params.signal?.aborted === true) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        reject(new Error(`one-shot timed out after ${params.timeoutMs} ms`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function abortError(): Error {
  const err = new Error('one-shot aborted');
  err.name = 'AbortError';
  return err;
}
