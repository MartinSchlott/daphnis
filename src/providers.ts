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
