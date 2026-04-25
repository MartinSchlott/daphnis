import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mkdtempSpy = vi.fn(async (prefix: string) => `${prefix}abcd`);
const writeFileSpy = vi.fn(async () => {});
const readFileSpy = vi.fn(async () => '{"ok":true}');
const rmSpy = vi.fn(async () => {});
vi.mock('node:fs/promises', () => ({
  mkdtemp: (...args: unknown[]) => mkdtempSpy(...(args as [string])),
  writeFile: (...args: unknown[]) => writeFileSpy(...(args as [string, string])),
  readFile: (...args: unknown[]) => readFileSpy(...(args as [string, string])),
  rm: (...args: unknown[]) => rmSpy(...(args as [string, object])),
}));

const { runOneShotPrompt } = await import('../one-shot.js');

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
  proc.pid = 4242;
  return proc;
}

function emitEnvelope(proc: FakeProcess, envelope: object, exitCode = 0): void {
  setImmediate(() => {
    proc.stdout.write(JSON.stringify(envelope));
    proc.stdout.end();
    proc.stderr.end();
    setImmediate(() => {
      proc.emit('exit', exitCode);
      proc.emit('close', exitCode);
    });
  });
}

beforeEach(() => {
  mockSpawn.mockReset();
  mkdtempSpy.mockClear();
  writeFileSpy.mockClear();
  readFileSpy.mockClear();
  rmSpy.mockClear();
});

describe('runOneShotPrompt — claude', () => {
  it('resolves with text and session id when envelope carries no structured output', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, { result: 'hi', session_id: 's1' });

    const result = await runOneShotPrompt({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'hello',
    });

    expect(result.text).toBe('hi');
    expect(result.sessionId).toBe('s1');
    expect(result.structured).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it('resolves with structured output when outputSchema is set', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, {
      result: 'raw',
      session_id: 's2',
      structured_output: { foo: 'bar' },
    });

    const result = await runOneShotPrompt<{ foo: string }>({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'hello',
      outputSchema: { type: 'object' },
    });

    expect(result.structured).toEqual({ foo: 'bar' });
    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--json-schema');
    const schemaIdx = args.indexOf('--json-schema');
    expect(JSON.parse(args[schemaIdx + 1]!)).toEqual({ type: 'object' });
  });

  it('passes systemPrompt, effort, and model flags', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, { result: 'ok', session_id: 's' });

    await runOneShotPrompt({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'user',
      systemPrompt: 'sys',
      effort: 'high',
      model: 'claude-x',
    });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-p', 'user']));
    expect(args).toEqual(expect.arrayContaining(['--system-prompt', 'sys']));
    expect(args).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-x']));
  });

  it('rejects on non-zero exit code', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    setImmediate(() => {
      proc.stdout.write('oops');
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 2));
    });

    await expect(
      runOneShotPrompt({ provider: 'claude', cwd: '/tmp', prompt: 'hi' }),
    ).rejects.toThrow(/Claude CLI exited 2/);
  });

  it('rejects when envelope is_error is true', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, { is_error: true, result: 'boom' });

    await expect(
      runOneShotPrompt({ provider: 'claude', cwd: '/tmp', prompt: 'hi' }),
    ).rejects.toThrow(/Claude CLI reported error: boom/);
  });

  it('rejects with timeout when the child never exits', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    // Ensure close fires after kill so the promise settles.
    proc.kill.mockImplementation(() => {
      setImmediate(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('close', null);
      });
    });

    await expect(
      runOneShotPrompt({
        provider: 'claude',
        cwd: '/tmp',
        prompt: 'hang',
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('default omits --dangerously-skip-permissions', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, { result: 'ok', session_id: 's' });

    await runOneShotPrompt({ provider: 'claude', cwd: '/tmp', prompt: 'hi' });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('fullAccess: true appends --dangerously-skip-permissions', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, { result: 'ok', session_id: 's' });

    await runOneShotPrompt({
      provider: 'claude', cwd: '/tmp', prompt: 'hi',
      fullAccess: true,
    });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('extraArgs are appended at the end of args', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    emitEnvelope(proc, { result: 'ok', session_id: 's' });

    await runOneShotPrompt({
      provider: 'claude', cwd: '/tmp', prompt: 'hi',
      extraArgs: ['--permission-mode', 'auto'],
    });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(-2)).toEqual(['--permission-mode', 'auto']);
  });

  it('rejects with AbortError when signal aborts', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    const ctl = new AbortController();
    proc.kill.mockImplementation(() => {
      setImmediate(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('close', null);
      });
    });
    setImmediate(() => ctl.abort());

    const err = await runOneShotPrompt({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'abort',
      signal: ctl.signal,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
  });
});

describe('runOneShotPrompt — codex', () => {
  it('spawns codex exec with schema and output-last-message flags and cleans up tmp dir', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    readFileSpy.mockResolvedValueOnce('{"ok":true}');
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    const result = await runOneShotPrompt<{ ok: boolean }>({
      provider: 'codex',
      cwd: '/tmp',
      prompt: 'do it',
      effort: 'high',
      model: 'codex-x',
      outputSchema: { type: 'object' },
    });

    expect(result.structured).toEqual({ ok: true });
    expect(result.sessionId).toBeNull();

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe('model_reasoning_effort=high');
    expect(args).toContain('exec');
    expect(args).toContain('--output-schema');
    expect(args).toContain('--output-last-message');
    expect(args[args.length - 1]).toBe('do it');

    expect(writeFileSpy).toHaveBeenCalledOnce();
    expect(rmSpy).toHaveBeenCalledOnce();
  });

  it('prepends systemPrompt to the user prompt for codex', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    readFileSpy.mockResolvedValueOnce('final');
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    await runOneShotPrompt({
      provider: 'codex',
      cwd: '/tmp',
      prompt: 'user-part',
      systemPrompt: 'sys-part',
    });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args[args.length - 1]).toBe('sys-part\n\nuser-part');
  });

  it('default omits --dangerously-bypass-approvals-and-sandbox', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    readFileSpy.mockResolvedValueOnce('out');
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    await runOneShotPrompt({ provider: 'codex', cwd: '/tmp', prompt: 'hi' });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('fullAccess: true places bypass flag in the global block, before exec', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    readFileSpy.mockResolvedValueOnce('out');
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    await runOneShotPrompt({
      provider: 'codex', cwd: '/tmp', prompt: 'hi',
      fullAccess: true,
    });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    const bypassIdx = args.indexOf('--dangerously-bypass-approvals-and-sandbox');
    const execIdx = args.indexOf('exec');
    expect(bypassIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThan(bypassIdx);
  });

  it('extraArgs land in the global block, before exec', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    readFileSpy.mockResolvedValueOnce('out');
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 0));
    });

    await runOneShotPrompt({
      provider: 'codex', cwd: '/tmp', prompt: 'hi',
      extraArgs: ['--sandbox', 'read-only'],
    });

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual(['--sandbox', 'read-only', 'exec']);
  });

  it('cleans up tmp dir even when codex exits non-zero', async () => {
    const proc = createFakeProcess();
    mockSpawn.mockReturnValue(proc);
    setImmediate(() => {
      proc.stderr.write('fail');
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('close', 1));
    });

    await expect(
      runOneShotPrompt({ provider: 'codex', cwd: '/tmp', prompt: 'x' }),
    ).rejects.toThrow(/Codex CLI exited 1/);
    expect(rmSpy).toHaveBeenCalledOnce();
  });
});
