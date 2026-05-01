import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { listSupportedProviders, checkProvider } = await import('../providers.js');

interface FakeProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 9999;
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('listSupportedProviders', () => {
  it('returns exactly ["claude", "codex"]', () => {
    expect(listSupportedProviders()).toEqual(['claude', 'codex']);
  });

  it('returns a fresh array on each call (no shared reference)', () => {
    const first = listSupportedProviders();
    first.push('mutated');
    const second = listSupportedProviders();
    expect(second).toEqual(['claude', 'codex']);
  });
});

describe('checkProvider', () => {
  it('throws synchronously for unknown provider', () => {
    expect(() => checkProvider('foo')).toThrow('Unknown provider: foo');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('resolves with available=true and version when child exits 0', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    setImmediate(() => {
      proc.stdout.write('1.2.3\n');
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    const result = await checkProvider('claude');
    expect(result).toEqual({
      provider: 'claude',
      binary: 'claude',
      available: true,
      version: '1.2.3',
    });
  });

  it('resolves with available=false carrying exit code on non-zero exit', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    setImmediate(() => {
      proc.stderr.write('boom');
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 7));
    });

    const result = await checkProvider('claude');
    expect(result.available).toBe(false);
    expect(result.error).toContain('exited 7');
    expect(result.error).toContain('boom');
  });

  it('resolves with available=false on ENOENT-style error event', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    const err = new Error('spawn ENOENT') as Error & { code?: string };
    err.code = 'ENOENT';
    setImmediate(() => proc.emit('error', err));

    const result = await checkProvider('claude');
    expect(result.available).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('times out and SIGTERMs the child when --version never returns', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    proc.kill.mockImplementation(() => {
      setImmediate(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('close', null);
      });
    });

    const result = await checkProvider('claude', { timeoutMs: 50 });
    expect(result.available).toBe(false);
    expect(result.error).toBe('timed out after 50 ms');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('honours options.binary as the spawned executable', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    await checkProvider('claude', { binary: '/custom/path' });
    expect(mockSpawn).toHaveBeenCalledWith(
      '/custom/path',
      ['--version'],
      expect.any(Object),
    );
  });

  it('merges caller env over filtered process env, blacklist stays stripped', async () => {
    const prevNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--inspect';

    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    await checkProvider('claude', { env: { FOO: 'bar' } });
    const opts = mockSpawn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.FOO).toBe('bar');
    expect(opts.env.NODE_OPTIONS).toBeUndefined();

    if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prevNodeOptions;
  });
});
