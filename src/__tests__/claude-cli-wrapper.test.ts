import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock loadSessionHistory for resume/concurrency tests
const mockLoadSessionHistory = vi.fn();
vi.mock('../sessions.js', () => ({
  loadSessionHistory: (...args: unknown[]) => mockLoadSessionHistory(...args),
}));

const { ClaudeCLIWrapper } = await import('../claude-cli-wrapper.js');
const { __resetForTests, listInstances, getInstance, instanceEvents } = await import('../registry.js');
const { createAIConversation } = await import('../factory.js');

const TEST_ID = 'test-id';

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

describe('ClaudeCLIWrapper', () => {
  let fakeProc: ReturnType<typeof createFakeProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);
  });

  afterEach(() => {
    __resetForTests();
  });

  function feedStdout(data: string) {
    fakeProc.stdout.push(data);
  }

  function systemInitEvent(sessionId = 'test-session-123') {
    return JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n';
  }

  function resultEvent(text: string, isError = false) {
    return JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success', result: text, is_error: isError }) + '\n';
  }

  it('fires onReady immediately on construction (before system/init)', () => {
    const onReady = vi.fn();
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onReady });

    // onReady fires in the constructor, not on system/init
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('captures session_id from system/init event', () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    feedStdout(systemInitEvent('sess-abc'));

    // session_id is captured but not directly exposed — verify via sendMessage
    // which includes it in the payload
    const chunks: string[] = [];
    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    wrapper.sendMessage('hello');

    const parsed = JSON.parse(chunks[0].trim());
    expect(parsed['session_id']).toBe('sess-abc');
  });

  it('getSessionId returns null before system/init and session ID after', () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    expect(wrapper.getSessionId()).toBeNull();

    feedStdout(systemInitEvent('sess-xyz'));

    expect(wrapper.getSessionId()).toBe('sess-xyz');
  });

  it('sends correct NDJSON on sendMessage (session_id null before init)', () => {
    const chunks: string[] = [];
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    // No system/init received yet — session_id is null
    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    wrapper.sendMessage('hello');

    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0].trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      session_id: null,
      parent_tool_use_id: null,
    });
  });

  it('sends session_id from init event on subsequent messages', () => {
    const chunks: string[] = [];
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    feedStdout(systemInitEvent('sess-1'));
    wrapper.sendMessage('hello');

    const parsed = JSON.parse(chunks[0].trim());
    expect(parsed['session_id']).toBe('sess-1');
  });

  it('fires onConversation for user and assistant turns', async () => {
    const onConversation = vi.fn();
    const onMessage = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onConversation, onMessage });

    wrapper.sendMessage('hello');

    // Write callback is async (next tick)
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onConversation).toHaveBeenCalledTimes(1);
    expect(onConversation.mock.calls[0][0].role).toBe('user');
    expect(onConversation.mock.calls[0][0].content).toBe('hello');

    feedStdout(resultEvent('world'));

    expect(onConversation).toHaveBeenCalledTimes(2);
    expect(onConversation.mock.calls[1][0].role).toBe('assistant');
    expect(onConversation.mock.calls[1][0].content).toBe('world');
    expect(onMessage).toHaveBeenCalledWith('world');
  });

  it('getTranscript returns user + assistant turns', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    feedStdout(resultEvent('world'));

    const history = await wrapper.getTranscript();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hello');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('world');
  });

  it('fires onError for error result without onConversation', async () => {
    const onError = vi.fn();
    const onConversation = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError, onConversation });

    wrapper.sendMessage('bad input');
    await new Promise(resolve => setTimeout(resolve, 10));

    // user turn fires onConversation
    expect(onConversation).toHaveBeenCalledTimes(1);

    feedStdout(resultEvent('something went wrong', true));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('something went wrong');
    // No assistant onConversation for error result
    expect(onConversation).toHaveBeenCalledTimes(1);
  });

  it('fires onError and destroys on stdin write failure', () => {
    const onError = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError });
    const destroySpy = vi.spyOn(wrapper, 'destroy');

    // Simulate stdin error
    fakeProc.stdin.emit('error', new Error('EPIPE'));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EPIPE' }));
    expect(destroySpy).toHaveBeenCalled();
  });

  it('fires onError when sendMessage called while busy', () => {
    const onError = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError });

    wrapper.sendMessage('first');
    wrapper.sendMessage('second');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Already processing' }));
  });

  it('fires onError when sendMessage called after destroy', () => {
    const onError = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError });

    wrapper.destroy();
    wrapper.sendMessage('too late');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Destroyed' }));
  });

  it('fires onExit with exit code', () => {
    const onExit = vi.fn();
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onExit });

    fakeProc.emit('exit', 0);

    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('destroy calls stdin.end and schedules kill', () => {
    vi.useFakeTimers();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    const stdinEnd = vi.spyOn(fakeProc.stdin, 'end');

    wrapper.destroy();

    expect(stdinEnd).toHaveBeenCalled();
    expect(fakeProc.kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);

    expect(fakeProc.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fires onError and destroys on NDJSON parse error', () => {
    const onError = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError });
    const destroySpy = vi.spyOn(wrapper, 'destroy');

    feedStdout('this is not json\n');

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('NDJSON parse error');
    expect(destroySpy).toHaveBeenCalled();
  });

  it('spawns with correct arguments including --print', () => {
    new ClaudeCLIWrapper('claude', '/my/project', TEST_ID);

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      expect.objectContaining({
        cwd: '/my/project',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  // --- sessionId / resume tests ---

  it('includes --resume flag when sessionId is provided', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, 'prev-session-42');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain('--resume');
    expect(spawnArgs).toContain('prev-session-42');
  });

  it('does not include --resume flag when sessionId is omitted', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--resume');
  });

  it('sets sessionId immediately when provided (before system/init)', () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, 'prev-session-42');

    expect(wrapper.getSessionId()).toBe('prev-session-42');
  });

  // --- systemPrompt tests ---

  it('includes --system-prompt flag when systemPrompt is provided', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, 'You are a helpful assistant');

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--system-prompt', 'You are a helpful assistant'],
      expect.any(Object),
    );
  });

  it('does not include --system-prompt flag when systemPrompt is omitted', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--system-prompt');
  });

  // --- effort / model passthrough ---

  it('appends --effort max when effort=max is passed', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, undefined, 'max');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[idx + 1]).toBe('max');
  });

  it('maps effort=min to --effort low', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, undefined, 'min');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[idx + 1]).toBe('low');
  });

  it('omits --effort when effort is undefined', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });

  it('omits --effort when effort=default', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, undefined, 'default');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });

  it('appends --model when model is provided', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, 'gpt-5.4');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[idx + 1]).toBe('gpt-5.4');
  });

  it('omits --model when model is undefined', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--model');
  });

  // --- BUG-001 coverage: CLI process dies (e.g. 401 auth error) ---

  it('fires onError when process exits with non-zero code while busy', async () => {
    const onError = vi.fn();
    const onExit = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError, onExit });

    wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    // CLI dies with exit code 1 (e.g. 401 auth error) without sending a result
    fakeProc.emit('exit', 1);

    expect(onExit).toHaveBeenCalledWith(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toMatch(/exit.*1/i);
  });

  it('resets busy flag when process exits unexpectedly', async () => {
    const onError = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError });

    wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    // Process dies without result
    fakeProc.emit('exit', 1);

    // Should be able to detect the wrapper is no longer busy
    // (sendMessage while busy fires "Already processing")
    // After unexpected exit + error, further sendMessage should get "Destroyed" not "Already processing"
    wrapper.sendMessage('retry');

    const messages = onError.mock.calls.map(c => c[0].message);
    expect(messages).not.toContain('Already processing');
  });

  it('surfaces stderr content in onError when process exits with non-zero code', async () => {
    const onError = vi.fn();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, { onError });

    wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    // CLI writes auth error to stderr, then exits
    fakeProc.stderr!.push('Error: 401 authentication_error: OAuth token has expired\n');
    fakeProc.emit('exit', 1);

    expect(onError).toHaveBeenCalled();
    const errorMessages = onError.mock.calls.map(c => c[0].message).join(' ');
    expect(errorMessages).toContain('401');
  });

  // --- Resume history concurrency guard (Plan Step 8c) ---

  it('parallel getTranscript() calls load history exactly once with no duplicates', async () => {
    const priorTurns = [
      { role: 'user' as const, content: 'prior question', timestamp: new Date() },
      { role: 'assistant' as const, content: 'prior answer', timestamp: new Date() },
    ];
    mockLoadSessionHistory.mockResolvedValue(priorTurns);

    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, 'resume-sess-1');

    // Call getTranscript() twice in parallel
    const [result1, result2] = await Promise.all([
      wrapper.getTranscript(),
      wrapper.getTranscript(),
    ]);

    // Both calls return the same turns
    expect(result1).toEqual(result2);
    expect(result1).toHaveLength(2);
    expect(result1[0].content).toBe('prior question');
    expect(result1[1].content).toBe('prior answer');

    // loadSessionHistory was called exactly once (concurrency guard)
    expect(mockLoadSessionHistory).toHaveBeenCalledOnce();
    expect(mockLoadSessionHistory).toHaveBeenCalledWith('claude', 'resume-sess-1', '/tmp');

    // A third call still returns the same cached result without re-loading
    const result3 = await wrapper.getTranscript();
    expect(result3).toEqual(result1);
    expect(mockLoadSessionHistory).toHaveBeenCalledOnce();
  });

  describe('registry integration', () => {
    it('registers instance with factory-assigned id', () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      const id = instance.getInstanceId();

      expect(id).toBeTruthy();
      expect(getInstance(id)).toBe(instance);

      const list = listInstances();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(id);
      expect(list[0].provider).toBe('claude');
      expect(list[0].cwd).toBe('/tmp');
      expect(list[0].meta).toBeUndefined();
    });

    it('setMeta is reflected in listInstances and getMeta', () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instance.setMeta({ label: 'L' });

      expect(instance.getMeta<{ label: string }>()).toEqual({ label: 'L' });
      expect(listInstances()[0].meta).toEqual({ label: 'L' });
    });

    it('destroy() removes the entry synchronously', () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      expect(listInstances()).toHaveLength(1);

      instance.destroy();
      expect(listInstances()).toHaveLength(0);
    });

    it('deregisters when the process emits error (e.g. ENOENT)', () => {
      const onError = vi.fn();
      createAIConversation({
        provider: 'claude',
        cwd: '/tmp',
        handlers: { onError },
      });

      expect(listInstances()).toHaveLength(1);
      fakeProc.emit('error', new Error('ENOENT'));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ENOENT' }));
      expect(listInstances()).toHaveLength(0);
    });

    it('deregisters before onExit runs', () => {
      let lengthAtExit = -1;
      createAIConversation({
        provider: 'claude',
        cwd: '/tmp',
        handlers: {
          onExit: () => {
            lengthAtExit = listInstances().length;
          },
        },
      });

      expect(listInstances()).toHaveLength(1);
      fakeProc.emit('exit', 0);

      expect(lengthAtExit).toBe(0);
      expect(listInstances()).toHaveLength(0);
    });
  });

  describe('lifecycle events', () => {
    it('construction emits instance:added exactly once', () => {
      const added = vi.fn();
      instanceEvents.on('instance:added', added);

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });

      expect(added).toHaveBeenCalledOnce();
      expect(added.mock.calls[0][0].id).toBe(instance.getInstanceId());
      expect(added.mock.calls[0][0].provider).toBe('claude');
      expect(added.mock.calls[0][0].cwd).toBe('/tmp');
    });

    it('destroy() emits instance:removed exactly once and a subsequent exit does not re-emit', () => {
      const removed = vi.fn();
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instanceEvents.on('instance:removed', removed);

      instance.destroy();
      expect(removed).toHaveBeenCalledOnce();

      fakeProc.emit('exit', 0);
      expect(removed).toHaveBeenCalledOnce();
    });

    it("proc.emit('exit') without prior destroy emits instance:removed exactly once", () => {
      const removed = vi.fn();
      createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instanceEvents.on('instance:removed', removed);

      fakeProc.emit('exit', 0);

      expect(removed).toHaveBeenCalledOnce();
    });

    it("proc.emit('error') emits added then removed", () => {
      const added = vi.fn();
      const removed = vi.fn();
      instanceEvents.on('instance:added', added);
      instanceEvents.on('instance:removed', removed);

      createAIConversation({
        provider: 'claude',
        cwd: '/tmp',
        handlers: { onError: () => {} },
      });

      expect(added).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();

      fakeProc.emit('error', new Error('ENOENT'));

      expect(added).toHaveBeenCalledOnce();
      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].id).toBe(added.mock.calls[0][0].id);
    });
  });
});
