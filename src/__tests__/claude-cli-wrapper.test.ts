import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockLoadSessionHistory = vi.fn();
vi.mock('../sessions.js', () => ({
  loadSessionHistory: (...args: unknown[]) => mockLoadSessionHistory(...args),
}));

const { ClaudeCLIWrapper } = await import('../claude-cli-wrapper.js');
const { __resetForTests, listInstances, getInstance, instanceEvents } = await import('../registry.js');
const { createAIConversation } = await import('../factory.js');

let testIdCounter = 0;
let TEST_ID = 'test-id-0';

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

/** Flush a setImmediate so the deferred `spawning → ready` transition fires. */
function flushImmediate(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

describe('ClaudeCLIWrapper', () => {
  let fakeProc: ReturnType<typeof createFakeProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);
    TEST_ID = `test-id-${++testIdCounter}`;
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

  it('inst.ready resolves after construction', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await expect(wrapper.ready).resolves.toBeUndefined();
  });

  it('captures session_id from system/init event', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await wrapper.ready;

    feedStdout(systemInitEvent('sess-abc'));

    const chunks: string[] = [];
    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    await wrapper.sendMessage('hello');

    const parsed = JSON.parse(chunks[0].trim());
    expect(parsed['session_id']).toBe('sess-abc');
  });

  it('getSessionId returns null before system/init and session ID after', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await wrapper.ready;

    expect(wrapper.getSessionId()).toBeNull();

    feedStdout(systemInitEvent('sess-xyz'));

    expect(wrapper.getSessionId()).toBe('sess-xyz');
  });

  it('sends correct NDJSON on sendMessage (session_id null before init)', async () => {
    const chunks: string[] = [];
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await wrapper.ready;

    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    await wrapper.sendMessage('hello');

    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0].trim());
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      session_id: null,
      parent_tool_use_id: null,
    });
  });

  it('sends session_id from init event on subsequent messages', async () => {
    const chunks: string[] = [];
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await wrapper.ready;

    fakeProc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    feedStdout(systemInitEvent('sess-1'));
    await wrapper.sendMessage('hello');

    const parsed = JSON.parse(chunks[0].trim());
    expect(parsed['session_id']).toBe('sess-1');
  });

  it("emits 'conversation' for user and assistant turns and 'message' for assistant", async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    const onConversation = vi.fn();
    const onMessage = vi.fn();
    wrapper.on('conversation', onConversation);
    wrapper.on('message', onMessage);
    await wrapper.ready;

    await wrapper.sendMessage('hello');

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
    await wrapper.ready;

    await wrapper.sendMessage('hello');
    feedStdout(resultEvent('world'));

    const history = await wrapper.getTranscript();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hello');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('world');
  });

  it("emits 'error' for error result without 'conversation' for an assistant turn", async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    const onError = vi.fn();
    const onConversation = vi.fn();
    wrapper.on('error', onError);
    wrapper.on('conversation', onConversation);
    await wrapper.ready;

    await wrapper.sendMessage('bad input');

    expect(onConversation).toHaveBeenCalledTimes(1);

    feedStdout(resultEvent('something went wrong', true));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('something went wrong');
    expect(onConversation).toHaveBeenCalledTimes(1);
  });

  it('sendMessage rejects and destroys on stdin write failure', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    wrapper.on('error', () => {});
    await wrapper.ready;
    const destroySpy = vi.spyOn(wrapper, 'destroy');

    fakeProc.stdin.emit('error', new Error('EPIPE'));
    // After stdin error: state is exiting; sendMessage should reject with 'Destroyed'
    await expect(wrapper.sendMessage('x')).rejects.toThrow('Destroyed');
    expect(destroySpy).toHaveBeenCalled();
  });

  it('sendMessage rejects with "Already processing" when called while busy', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await wrapper.ready;

    await wrapper.sendMessage('first');
    await expect(wrapper.sendMessage('second')).rejects.toThrow('Already processing');
  });

  it('sendMessage rejects with "Destroyed" when called after destroy', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await wrapper.ready;

    wrapper.destroy();
    await expect(wrapper.sendMessage('too late')).rejects.toThrow('Destroyed');
  });

  it('sendMessage rejects with "Not ready" when called before ready resolves', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    // Do not await ready
    await expect(wrapper.sendMessage('too early')).rejects.toThrow('Not ready');
  });

  it('process exit emits instance:removed with exitCode', async () => {
    const removed = vi.fn();
    instanceEvents.on('instance:removed', removed);
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await flushImmediate();

    fakeProc.emit('exit', 0);

    expect(removed).toHaveBeenCalledOnce();
    expect(removed.mock.calls[0][0].exitCode).toBe(0);
  });

  it('destroy calls stdin.end and schedules kill, but unregister waits for proc exit', async () => {
    vi.useFakeTimers();
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    await vi.advanceTimersToNextTimerAsync();
    const stdinEnd = vi.spyOn(fakeProc.stdin, 'end');

    wrapper.destroy();

    expect(stdinEnd).toHaveBeenCalled();
    expect(fakeProc.kill).not.toHaveBeenCalled();
    // Entry remains in 'exiting' state until proc actually exits
    expect(listInstances()).toHaveLength(1);
    expect(listInstances()[0].state).toBe('exiting');

    vi.advanceTimersByTime(3000);

    expect(fakeProc.kill).toHaveBeenCalled();
    vi.useRealTimers();

    fakeProc.emit('exit', 0);
    expect(listInstances()).toHaveLength(0);
  });

  it("emits 'error' and destroys on NDJSON parse error after ready", async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    const onError = vi.fn();
    wrapper.on('error', onError);
    await wrapper.ready;
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
      ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      expect.objectContaining({
        cwd: '/my/project',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('includes --resume flag when sessionId is provided', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, 'prev-session-42');

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
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, 'prev-session-42');

    expect(wrapper.getSessionId()).toBe('prev-session-42');
  });

  it('includes --system-prompt flag when systemPrompt is provided', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, 'You are a helpful assistant');

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--system-prompt', 'You are a helpful assistant'],
      expect.any(Object),
    );
  });

  it('does not include --system-prompt flag when systemPrompt is omitted', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--system-prompt');
  });

  it('appends --effort max when effort=max is passed', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, 'max');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const idx = spawnArgs.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[idx + 1]).toBe('max');
  });

  it('maps effort=min to --effort low', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, 'min');

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
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, 'default');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain('--effort');
  });

  it('appends --model when model is provided', () => {
    new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, undefined, undefined, 'gpt-5.4');

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

  it("emits 'error' when process exits with non-zero code while busy", async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    const onError = vi.fn();
    wrapper.on('error', onError);
    await wrapper.ready;

    const sendPromise = wrapper.sendMessage('hello');
    sendPromise.catch(() => {});
    await new Promise(r => setTimeout(r, 10));

    fakeProc.emit('exit', 1);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toMatch(/exit.*1/i);
  });

  it('resets busy state when process exits unexpectedly', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    wrapper.on('error', () => {});
    await wrapper.ready;

    await wrapper.sendMessage('hello');

    fakeProc.emit('exit', 1);

    // After unexpected exit + error, further sendMessage gets "Destroyed", not "Already processing"
    await expect(wrapper.sendMessage('retry')).rejects.toThrow('Destroyed');
  });

  it('surfaces stderr content when process exits with non-zero code', async () => {
    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
    const onError = vi.fn();
    wrapper.on('error', onError);
    await wrapper.ready;

    await wrapper.sendMessage('hello');

    fakeProc.stderr!.push('Error: 401 authentication_error: OAuth token has expired\n');
    fakeProc.emit('exit', 1);

    expect(onError).toHaveBeenCalled();
    const errorMessages = onError.mock.calls.map(c => c[0].message).join(' ');
    expect(errorMessages).toContain('401');
  });

  it('parallel getTranscript() calls load history exactly once with no duplicates', async () => {
    const priorTurns = [
      { role: 'user' as const, content: 'prior question', timestamp: new Date() },
      { role: 'assistant' as const, content: 'prior answer', timestamp: new Date() },
    ];
    mockLoadSessionHistory.mockResolvedValue(priorTurns);

    const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID, undefined, 'resume-sess-1');
    await wrapper.ready;

    const [result1, result2] = await Promise.all([
      wrapper.getTranscript(),
      wrapper.getTranscript(),
    ]);

    expect(result1).toEqual(result2);
    expect(result1).toHaveLength(2);
    expect(result1[0].content).toBe('prior question');
    expect(result1[1].content).toBe('prior answer');

    expect(mockLoadSessionHistory).toHaveBeenCalledOnce();
    expect(mockLoadSessionHistory).toHaveBeenCalledWith('claude', 'resume-sess-1', '/tmp');

    const result3 = await wrapper.getTranscript();
    expect(result3).toEqual(result1);
    expect(mockLoadSessionHistory).toHaveBeenCalledOnce();
  });

  describe('fullAccess and extraArgs', () => {
    it('default (no fullAccess) does not include --dangerously-skip-permissions', () => {
      new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('fullAccess: true appends --dangerously-skip-permissions exactly once', () => {
      new ClaudeCLIWrapper(
        'claude', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        true,
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const occurrences = spawnArgs.filter((a) => a === '--dangerously-skip-permissions').length;
      expect(occurrences).toBe(1);
    });

    it('fullAccess: false does not include --dangerously-skip-permissions', () => {
      new ClaudeCLIWrapper(
        'claude', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        false,
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    });

    it('extraArgs are appended at the end of the spawn args, in order', () => {
      new ClaudeCLIWrapper(
        'claude', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        undefined, ['--permission-mode', 'auto'],
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs.slice(-2)).toEqual(['--permission-mode', 'auto']);
    });

    it('fullAccess: true precedes extraArgs in the spawn args', () => {
      new ClaudeCLIWrapper(
        'claude', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        true, ['--permission-mode', 'plan'],
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const bypassIdx = spawnArgs.indexOf('--dangerously-skip-permissions');
      const modeIdx = spawnArgs.indexOf('--permission-mode');
      expect(bypassIdx).toBeGreaterThanOrEqual(0);
      expect(modeIdx).toBeGreaterThan(bypassIdx);
      expect(spawnArgs[modeIdx + 1]).toBe('plan');
    });
  });

  describe('registry integration', () => {
    it('registers instance with factory-assigned id', async () => {
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
      await instance.ready;
    });

    it('setMeta is reflected in listInstances and getMeta', async () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instance.setMeta({ label: 'L' });

      expect(instance.getMeta<{ label: string }>()).toEqual({ label: 'L' });
      expect(listInstances()[0].meta).toEqual({ label: 'L' });
      await instance.ready;
    });

    it('destroy() does not unregister synchronously; entry remains in exiting until proc exits', async () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;
      expect(listInstances()).toHaveLength(1);

      instance.destroy();
      expect(listInstances()).toHaveLength(1);
      expect(listInstances()[0].state).toBe('exiting');

      fakeProc.emit('exit', 0);
      expect(listInstances()).toHaveLength(0);
    });

    it('spawn failure: proc emits error → ready rejects, no instance:ready, registry empty without proc.exit', async () => {
      const ready = vi.fn();
      const stateChanges: Array<[string, string]> = [];
      const removed = vi.fn();
      instanceEvents.on('instance:ready', ready);
      instanceEvents.on('instance:state-changed', (_info, prev, next) => stateChanges.push([prev, next]));
      instanceEvents.on('instance:removed', removed);

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      const onError = vi.fn();
      instance.on('error', onError);

      // Emit ENOENT before the deferred ready transition fires.
      fakeProc.emit('error', new Error('ENOENT'));

      await expect(instance.ready).rejects.toThrow('ENOENT');
      expect(ready).not.toHaveBeenCalled();
      expect(stateChanges).toEqual([['spawning', 'exiting']]);
      expect(onError).not.toHaveBeenCalled();
      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].state).toBe('exiting');
      expect(removed.mock.calls[0][0].exitCode).toBeNull();
      expect(listInstances()).toEqual([]);
    });

    it('setImmediate ordering: spawn failure under await still rejects ready', async () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      // Drain microtasks before emitting error
      await Promise.resolve();
      await Promise.resolve();
      fakeProc.emit('error', new Error('ENOENT'));

      await expect(instance.ready).rejects.toThrow('ENOENT');
    });

    it('destroy() during spawn rejects ready with "Destroyed"', async () => {
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      // Synchronously destroy before setImmediate fires
      instance.destroy();

      await expect(instance.ready).rejects.toThrow('Destroyed');

      fakeProc.emit('exit', 0);
      expect(listInstances()).toEqual([]);
    });
  });

  describe('interrupt()', () => {
    function controlResponseEvent(requestId: string, subtype: 'success' | 'error' = 'success', error?: string) {
      return JSON.stringify({
        type: 'control_response',
        response: {
          subtype,
          request_id: requestId,
          ...(error !== undefined ? { error } : {}),
        },
      }) + '\n';
    }

    function interruptResultEvent() {
      return JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        result: 'interrupted',
        is_error: true,
      }) + '\n';
    }

    function captureControlRequest(): Promise<{ requestId: string }> {
      return new Promise((resolve) => {
        fakeProc.stdin.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed['type'] === 'control_request') {
                resolve({ requestId: parsed['request_id'] as string });
                return;
              }
            } catch {
              // Not JSON, skip
            }
          }
        });
      });
    }

    it('rejects when not busy', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await expect(wrapper.interrupt()).rejects.toThrow('Not busy');
    });

    it('rejects when destroyed', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      wrapper.destroy();
      await expect(wrapper.interrupt()).rejects.toThrow('Destroyed');
    });

    it('writes the correct control_request NDJSON line', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const captured = captureControlRequest();
      void wrapper.interrupt().catch(() => {});
      const { requestId } = await captured;
      expect(typeof requestId).toBe('string');
      expect(requestId.length).toBeGreaterThan(0);
    });

    it('resolves only after BOTH control_response success AND interrupt-terminator result arrive', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const captured = captureControlRequest();
      const interruptPromise = wrapper.interrupt();
      const { requestId } = await captured;

      let settled = false;
      interruptPromise.then(() => { settled = true; }, () => { settled = true; });

      feedStdout(controlResponseEvent(requestId, 'success'));
      await new Promise(r => setTimeout(r, 10));
      expect(settled).toBe(false);

      feedStdout(interruptResultEvent());
      await interruptPromise;
      expect(settled).toBe(true);
    });

    it("suppresses 'error' and assistant turn for the interrupt-terminator result", async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      const onError = vi.fn();
      const onConversation = vi.fn();
      const onMessage = vi.fn();
      wrapper.on('error', onError);
      wrapper.on('conversation', onConversation);
      wrapper.on('message', onMessage);
      await wrapper.ready;
      await wrapper.sendMessage('hello');
      onConversation.mockClear();

      const captured = captureControlRequest();
      const interruptPromise = wrapper.interrupt();
      const { requestId } = await captured;

      feedStdout(controlResponseEvent(requestId, 'success'));
      feedStdout(interruptResultEvent());
      await interruptPromise;

      expect(onError).not.toHaveBeenCalled();
      expect(onConversation).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('natural-completion race: assistant turn IS appended and events fire', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      const onConversation = vi.fn();
      const onMessage = vi.fn();
      const onError = vi.fn();
      wrapper.on('conversation', onConversation);
      wrapper.on('message', onMessage);
      wrapper.on('error', onError);
      await wrapper.ready;
      await wrapper.sendMessage('hello');
      onConversation.mockClear();

      const captured = captureControlRequest();
      const interruptPromise = wrapper.interrupt();
      const { requestId } = await captured;

      feedStdout(controlResponseEvent(requestId, 'success'));
      feedStdout(resultEvent('finished naturally', false));
      await interruptPromise;

      expect(onError).not.toHaveBeenCalled();
      expect(onConversation).toHaveBeenCalledTimes(1);
      expect(onConversation.mock.calls[0][0].role).toBe('assistant');
      expect(onConversation.mock.calls[0][0].content).toBe('finished naturally');
      expect(onMessage).toHaveBeenCalledWith('finished naturally');

      const transcript = await wrapper.getTranscript();
      expect(transcript[transcript.length - 1].content).toBe('finished naturally');
    });

    it("failure race: rejects AND 'error' fires for non-interrupt is_error result", async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      const onError = vi.fn();
      const onConversation = vi.fn();
      wrapper.on('error', onError);
      wrapper.on('conversation', onConversation);
      await wrapper.ready;
      await wrapper.sendMessage('hello');
      onConversation.mockClear();

      const captured = captureControlRequest();
      const interruptPromise = wrapper.interrupt();
      const { requestId } = await captured;

      feedStdout(controlResponseEvent(requestId, 'success'));
      feedStdout(JSON.stringify({
        type: 'result', subtype: 'error_max_turns',
        result: 'max turns', is_error: true,
      }) + '\n');

      await expect(interruptPromise).rejects.toThrow('max turns');
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].message).toBe('max turns');
      expect(onConversation).not.toHaveBeenCalled();
    });

    it('subsequent sendMessage works after interrupt() resolves', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('first');

      const captured = captureControlRequest();
      const interruptPromise = wrapper.interrupt();
      const { requestId } = await captured;
      feedStdout(controlResponseEvent(requestId, 'success'));
      feedStdout(interruptResultEvent());
      await interruptPromise;

      await wrapper.sendMessage('second');
    });

    it('rejects on control_response error subtype', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const captured = captureControlRequest();
      const interruptPromise = wrapper.interrupt();
      const { requestId } = await captured;

      feedStdout(controlResponseEvent(requestId, 'error', 'control failed'));
      await expect(interruptPromise).rejects.toThrow('control failed');
    });

    it('rejects when child exits before completion', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      wrapper.on('error', () => {});
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));

      fakeProc.emit('exit', 1);
      await expect(interruptPromise).rejects.toThrow(/exit/i);
    });

    it('rejects when child errors before completion', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      wrapper.on('error', () => {});
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));

      fakeProc.emit('error', new Error('ENOENT'));
      await expect(interruptPromise).rejects.toThrow('ENOENT');
    });

    it('rejects with Destroyed when destroy() is called while interrupt is pending', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));
      wrapper.destroy();

      await expect(interruptPromise).rejects.toThrow('Destroyed');
    });

    it('concurrent interrupt() rejects second call', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const first = wrapper.interrupt();
      first.catch(() => {});
      await expect(wrapper.interrupt()).rejects.toThrow('Interrupt already in progress');

      wrapper.destroy();
      await first.catch(() => {});
    });
  });

  describe('lifecycle events', () => {
    it('construction emits instance:added exactly once', async () => {
      const added = vi.fn();
      instanceEvents.on('instance:added', added);

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;

      expect(added).toHaveBeenCalledOnce();
      expect(added.mock.calls[0][0].id).toBe(instance.getInstanceId());
      expect(added.mock.calls[0][0].provider).toBe('claude');
      expect(added.mock.calls[0][0].cwd).toBe('/tmp');
    });

    it('destroy() then proc exit emits instance:removed exactly once', async () => {
      const removed = vi.fn();
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;
      instanceEvents.on('instance:removed', removed);

      instance.destroy();
      expect(removed).not.toHaveBeenCalled();

      fakeProc.emit('exit', 0);
      expect(removed).toHaveBeenCalledOnce();
    });

    it("proc.emit('exit') without prior destroy emits instance:removed exactly once", async () => {
      const removed = vi.fn();
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;
      instanceEvents.on('instance:removed', removed);

      fakeProc.emit('exit', 0);

      expect(removed).toHaveBeenCalledOnce();
    });

    it("proc.emit('error') after ready emits added then removed", async () => {
      const added = vi.fn();
      const removed = vi.fn();
      instanceEvents.on('instance:added', added);
      instanceEvents.on('instance:removed', removed);

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instance.on('error', () => {});
      await instance.ready;

      expect(added).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();

      fakeProc.emit('error', new Error('ENOENT'));

      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].id).toBe(added.mock.calls[0][0].id);
    });

    it('construction emits instance:ready exactly once with InstanceInfo', async () => {
      const ready = vi.fn();
      instanceEvents.on('instance:ready', ready);

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;

      expect(ready).toHaveBeenCalledOnce();
      expect(ready.mock.calls[0][0].id).toBe(instance.getInstanceId());
      expect(ready.mock.calls[0][0].provider).toBe('claude');
      expect(ready.mock.calls[0][0].cwd).toBe('/tmp');
    });

    it('instance:added fires before instance:ready (Claude)', async () => {
      const order: string[] = [];
      instanceEvents.on('instance:added', () => order.push('added'));
      instanceEvents.on('instance:ready', () => order.push('ready'));

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;

      expect(order).toEqual(['added', 'ready']);
    });
  });

  describe('state machine', () => {
    it('construction emits added then state-changed(spawning→ready) then ready in order', async () => {
      const events: Array<{ kind: string; prev?: string; next?: string; state: string }> = [];
      instanceEvents.on('instance:added', info => events.push({ kind: 'added', state: info.state }));
      instanceEvents.on('instance:state-changed', (info, prev, next) => events.push({ kind: 'state', prev, next, state: info.state }));
      instanceEvents.on('instance:ready', info => events.push({ kind: 'ready', state: info.state }));

      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      await instance.ready;

      expect(events).toEqual([
        { kind: 'added', state: 'spawning' },
        { kind: 'state', prev: 'spawning', next: 'ready', state: 'ready' },
        { kind: 'ready', state: 'ready' },
      ]);
    });

    it('sendMessage → result emits state-changed(ready→busy) then state-changed(busy→ready)', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      const stateEvents: Array<[string, string]> = [];
      instanceEvents.on('instance:state-changed', (_info, prev, next) => stateEvents.push([prev, next]));

      await wrapper.sendMessage('hello');
      feedStdout(resultEvent('world'));

      expect(stateEvents).toEqual([
        ['ready', 'busy'],
        ['busy', 'ready'],
      ]);
    });

    it('destroy() emits state-changed(*→exiting); proc exit emits removed; removed payload state is "exiting"', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      const events: string[] = [];
      const removedPayloads: Array<{ state: string }> = [];
      instanceEvents.on('instance:state-changed', (_info, prev, next) => events.push(`state:${prev}->${next}`));
      instanceEvents.on('instance:removed', info => { events.push('removed'); removedPayloads.push({ state: info.state }); });

      wrapper.destroy();
      expect(events).toEqual(['state:ready->exiting']);

      fakeProc.emit('exit', 0);
      expect(events).toEqual(['state:ready->exiting', 'removed']);
      expect(removedPayloads[0].state).toBe('exiting');
    });

    it('mid-turn child crash emits state-changed(busy→exiting) then removed (no busy→ready in between)', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      wrapper.on('error', () => {});
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      const events: string[] = [];
      instanceEvents.on('instance:state-changed', (_info, prev, next) => events.push(`${prev}->${next}`));
      instanceEvents.on('instance:removed', () => events.push('removed'));

      fakeProc.emit('exit', 1);

      expect(events).toEqual(['busy->exiting', 'removed']);
    });

    it('sendMessage while state === "exiting" rejects with "Destroyed"', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;

      wrapper.destroy();
      await expect(wrapper.sendMessage('too late')).rejects.toThrow('Destroyed');
    });
  });

  describe('error event without listener', () => {
    it("emitting 'error' without an attached listener does not throw", async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      await wrapper.ready;
      await wrapper.sendMessage('hello');

      // Result with is_error: would normally fire 'error' on EventEmitter, which
      // would throw without a listener. safeEmitError must swallow.
      expect(() => feedStdout(resultEvent('boom', true))).not.toThrow();
    });
  });

  describe('late terminator after teardown', () => {
    it('result arriving after destroy() while busy is dropped silently', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      const onMessage = vi.fn();
      const onConversation = vi.fn();
      wrapper.on('message', onMessage);
      wrapper.on('conversation', onConversation);
      await wrapper.ready;
      await wrapper.sendMessage('hello');
      onConversation.mockClear();

      // Wrapper is now busy. Destroy mid-turn — registry transitions to 'exiting'
      // but the entry is still present until proc.on('exit') fires.
      wrapper.destroy();

      // Late result arrives. Must not throw (illegal exiting → ready), must not
      // emit message/conversation on a torn-down wrapper.
      expect(() => feedStdout(resultEvent('late content'))).not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();
      expect(onConversation).not.toHaveBeenCalled();
    });

    it('result arriving after error-path unregister is dropped silently', async () => {
      const wrapper = new ClaudeCLIWrapper('claude', '/tmp', TEST_ID);
      const onMessage = vi.fn();
      const onConversation = vi.fn();
      wrapper.on('message', onMessage);
      wrapper.on('conversation', onConversation);
      wrapper.on('error', () => {});
      await wrapper.ready;
      await wrapper.sendMessage('hello');
      onConversation.mockClear();

      // Error handler self-unregisters; entry is gone, getState falls back to 'exiting'.
      fakeProc.emit('error', new Error('ENOENT'));

      expect(() => feedStdout(resultEvent('late content'))).not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();
      expect(onConversation).not.toHaveBeenCalled();
    });
  });

  describe("error path during 'spawning' kills the child", () => {
    it("proc.on('error') during spawning schedules SIGKILL", async () => {
      vi.useFakeTimers();
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instance.on('error', () => {});

      fakeProc.emit('error', new Error('ENOENT'));

      // Ready already rejected, registry empty. Now ensure the child is being torn down.
      expect(fakeProc.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(fakeProc.kill).toHaveBeenCalled();

      vi.useRealTimers();
      await instance.ready.catch(() => {});
    });

    it("stdin.on('error') during spawning schedules SIGKILL", async () => {
      vi.useFakeTimers();
      const instance = createAIConversation({ provider: 'claude', cwd: '/tmp' });
      instance.on('error', () => {});

      fakeProc.stdin.emit('error', new Error('EPIPE'));

      expect(fakeProc.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(fakeProc.kill).toHaveBeenCalled();

      vi.useRealTimers();
      await instance.ready.catch(() => {});
    });
  });
});
