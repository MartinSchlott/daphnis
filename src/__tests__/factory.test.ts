import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { createAIConversation } = await import('../factory.js');
const { __resetForTests } = await import('../registry.js');

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe('createAIConversation', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('returns an instance for provider "claude"', () => {
    mockSpawn.mockReturnValue(createFakeProcess());
    const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
    expect(instance).toBeDefined();
    expect(typeof instance.sendMessage).toBe('function');
    expect(typeof instance.getTranscript).toBe('function');
    expect(typeof instance.destroy).toBe('function');
  });

  it('spawns claude binary for provider "claude" with explicit binary', () => {
    mockSpawn.mockReturnValue(createFakeProcess());
    createAIConversation({ provider: 'claude', cwd: '/tmp', binary: '/usr/bin/claude' });
    expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/claude', expect.any(Array), expect.any(Object));
  });

  it('defaults binary to "claude" when not specified for claude provider', () => {
    mockSpawn.mockReturnValue(createFakeProcess());
    createAIConversation({ provider: 'claude', cwd: '/tmp' });
    expect(mockSpawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object));
  });

  it('returns an instance for provider "codex"', () => {
    mockSpawn.mockReturnValue(createFakeProcess());
    const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
    expect(instance).toBeDefined();
    expect(typeof instance.sendMessage).toBe('function');
  });

  it('spawns codex binary for provider "codex" with explicit binary', () => {
    mockSpawn.mockReturnValue(createFakeProcess());
    createAIConversation({ provider: 'codex', cwd: '/tmp', binary: '/usr/bin/codex' });
    expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/codex', expect.any(Array), expect.any(Object));
  });

  it('defaults binary to "codex" when not specified for codex provider', () => {
    mockSpawn.mockReturnValue(createFakeProcess());
    createAIConversation({ provider: 'codex', cwd: '/tmp' });
    expect(mockSpawn).toHaveBeenCalledWith('codex', expect.any(Array), expect.any(Object));
  });

  it('passes handlers to the constructor', () => {
    const fakeProc = createFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);
    const onReady = vi.fn();
    createAIConversation({ provider: 'claude', cwd: '/tmp', handlers: { onReady } });

    // Feed system/init to verify handler was wired
    fakeProc.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' }) + '\n');
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('throws for unknown provider', () => {
    expect(() => {
      createAIConversation({ provider: 'unknown' as 'claude', cwd: '/tmp' });
    }).toThrow('Unknown provider: unknown');
  });

  it('forwards effort and model to the claude wrapper', () => {
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue(createFakeProcess());
    createAIConversation({
      provider: 'claude', cwd: '/tmp',
      effort: 'high', model: 'gpt-5.4',
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const eIdx = spawnArgs.indexOf('--effort');
    const mIdx = spawnArgs.indexOf('--model');
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[eIdx + 1]).toBe('high');
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[mIdx + 1]).toBe('gpt-5.4');
  });

  it('forwards effort and model to the codex wrapper', () => {
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue(createFakeProcess());
    createAIConversation({
      provider: 'codex', cwd: '/tmp',
      effort: 'max', model: 'codex-x',
    });

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=xhigh', '-m', 'codex-x', 'app-server']);
  });
});
