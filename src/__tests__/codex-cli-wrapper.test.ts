import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { CodexCLIWrapper } = await import('../codex-cli-wrapper.js');
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

function captureStdin(proc: ReturnType<typeof createFakeProcess>): string[] {
  const chunks: string[] = [];
  proc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return chunks;
}

function parseCapturedMessages(chunks: string[]): Record<string, unknown>[] {
  return chunks.flatMap(c =>
    c.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>),
  );
}

describe('CodexCLIWrapper', () => {
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

  /** Complete the init handshake: respond to initialize + thread/start requests */
  async function completeInit(threadId = 'thread-abc') {
    await new Promise(resolve => setTimeout(resolve, 10));
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: threadId } } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  it('inst.ready resolves after successful initialization', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    await completeInit();
    await expect(wrapper.ready).resolves.toBeUndefined();
  });

  it('getSessionId returns null before init and thread ID after', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    expect(wrapper.getSessionId()).toBeNull();

    await completeInit('thread-session-42');

    expect(wrapper.getSessionId()).toBe('thread-session-42');
  });

  it('sends initialize with experimentalApi and hardcoded daphnis clientInfo', async () => {
    const stdinChunks = captureStdin(fakeProc);
    new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await new Promise(resolve => setTimeout(resolve, 10));

    const initMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'initialize');
    expect(initMsg).toBeDefined();
    expect(initMsg!['id']).toBe(1);

    const params = initMsg!['params'] as Record<string, unknown>;
    expect(params['clientInfo']).toEqual({ name: 'daphnis', title: 'Daphnis', version: '1.0.0' });
    expect(params['capabilities']).toEqual({ experimentalApi: true });

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const threadMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/start');
    expect(threadMsg).toBeDefined();
    expect(threadMsg!['id']).toBe(2);
  });

  it('sends thread/resume instead of thread/start when sessionId is provided', async () => {
    const stdinChunks = captureStdin(fakeProc);
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, 'prev-thread-99');

    await new Promise(resolve => setTimeout(resolve, 10));

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const resumeMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/resume');
    expect(resumeMsg).toBeDefined();
    expect((resumeMsg!['params'] as Record<string, unknown>)['threadId']).toBe('prev-thread-99');

    const startMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/start');
    expect(startMsg).toBeUndefined();

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'prev-thread-99' } } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('sends thread/start when sessionId is not provided', async () => {
    const stdinChunks = captureStdin(fakeProc);
    new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await new Promise(resolve => setTimeout(resolve, 10));

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const startMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/start');
    expect(startMsg).toBeDefined();

    const resumeMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/resume');
    expect(resumeMsg).toBeUndefined();
  });

  it('rejects ready on init failure', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await new Promise(resolve => setTimeout(resolve, 10));

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');

    await expect(wrapper.ready).rejects.toThrow('init failed');
  });

  it("emits 'conversation' for user turn after sendMessage resolves", async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    const onConversation = vi.fn();
    wrapper.on('conversation', onConversation);

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    expect(turnMsg).toBeDefined();
    expect((turnMsg!['params'] as Record<string, unknown>)['threadId']).toBe('thread-abc');

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    expect(onConversation).toHaveBeenCalledTimes(1);
    expect(onConversation.mock.calls[0][0].role).toBe('user');
    expect(onConversation.mock.calls[0][0].content).toBe('hello');
  });

  it('includes collaborationMode in turn/start when systemPrompt is set', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, 'You are a code reviewer');

    await completeInit();

    const sendPromise = wrapper.sendMessage('review this');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    expect(turnMsg).toBeDefined();
    const params = turnMsg!['params'] as Record<string, unknown>;
    expect(params['collaborationMode']).toEqual({
      settings: { developer_instructions: 'You are a code reviewer' },
    });

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;
  });

  it('does not include collaborationMode when systemPrompt is not set', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    const params = turnMsg!['params'] as Record<string, unknown>;
    expect(params['collaborationMode']).toBeUndefined();

    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;
  });

  it("accumulates deltas and emits 'conversation' + 'message' on turn/completed", async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    const onConversation = vi.fn();
    const onMessage = vi.fn();
    wrapper.on('conversation', onConversation);
    wrapper.on('message', onMessage);

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'Hello' } }) + '\n');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: ' World' } }) + '\n');

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'completed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onConversation).toHaveBeenCalledTimes(2);
    expect(onConversation.mock.calls[1][0].role).toBe('assistant');
    expect(onConversation.mock.calls[1][0].content).toBe('Hello World');
    expect(onMessage).toHaveBeenCalledWith('Hello World');
  });

  it("emits 'error' on failed turn", async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    const onError = vi.fn();
    const onConversation = vi.fn();
    wrapper.on('error', onError);
    wrapper.on('conversation', onConversation);

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'failed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalled();
    expect(onConversation).toHaveBeenCalledTimes(1);
  });

  it('auto-approves command execution requests', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('run ls');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution/requestApproval', id: 100, params: { command: 'ls' } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const approvalResponse = parseCapturedMessages(stdinChunks).find(m => m['id'] === 100 && 'result' in m);
    expect(approvalResponse).toBeDefined();
    expect((approvalResponse!['result'] as Record<string, unknown>)['decision']).toBe('accept');
  });

  it('auto-approves file change requests', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('write file');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/fileChange/requestApproval', id: 101, params: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const response = parseCapturedMessages(stdinChunks).find(m => m['id'] === 101 && 'result' in m);
    expect(response).toBeDefined();
    expect((response!['result'] as Record<string, unknown>)['decision']).toBe('accept');
  });

  it('auto-approves permissions requests with schema-valid payload', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('need perms');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/permissions/requestApproval', id: 200, params: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const response = parseCapturedMessages(stdinChunks).find(m => m['id'] === 200 && 'result' in m);
    expect(response).toBeDefined();
    const result = response!['result'] as Record<string, unknown>;
    const permissions = result['permissions'] as Record<string, unknown>;

    const fs = permissions['fileSystem'] as Record<string, unknown>;
    expect(Array.isArray(fs['read'])).toBe(true);
    expect(Array.isArray(fs['write'])).toBe(true);
    expect((fs['read'] as string[]).length).toBeGreaterThan(0);

    const net = permissions['network'] as Record<string, unknown>;
    expect(net['enabled']).toBe(true);

    const mac = permissions['macos'] as Record<string, unknown>;
    expect(mac).toBeDefined();
    expect(mac['accessibility']).toBe(true);
    expect(mac['calendar']).toBe(true);
    expect(mac['automations']).toBe('all');
    expect(mac['preferences']).toBe('read_write');

    expect(result['scope']).toBe('session');
  });

  it('responds with failure for unsupported tool calls', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('use tool');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/tool/call', id: 102, params: { tool: 'something' } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const response = parseCapturedMessages(stdinChunks).find(m => m['id'] === 102 && 'result' in m);
    expect(response).toBeDefined();
    const result = response!['result'] as Record<string, unknown>;
    expect(result['success']).toBe(false);
    expect(result['contentItems']).toEqual([{ type: 'inputText', text: 'Tool execution not supported in this client' }]);
  });

  it('reads turn status from params.turn.status (not params.status)', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    const onConversation = vi.fn();
    wrapper.on('conversation', onConversation);

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'ok' } }) + '\n');

    feedStdout(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'thread-abc', turn: { status: 'completed' }, status: 'should-be-ignored' },
    }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onConversation).toHaveBeenCalledTimes(2);
    expect(onConversation.mock.calls[1][0].content).toBe('ok');
  });

  it('handles multiple server requests in one turn', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    const onConversation = vi.fn();
    wrapper.on('conversation', onConversation);

    await completeInit();

    const sendPromise = wrapper.sendMessage('complex task');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution/requestApproval', id: 200, params: {} }) + '\n');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/fileChange/requestApproval', id: 201, params: {} }) + '\n');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'done' } }) + '\n');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'completed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    const msgs = parseCapturedMessages(stdinChunks);
    expect(msgs.filter(m => m['id'] === 200 && 'result' in m)).toHaveLength(1);
    expect(msgs.filter(m => m['id'] === 201 && 'result' in m)).toHaveLength(1);

    expect(onConversation).toHaveBeenCalledTimes(2);
    expect(onConversation.mock.calls[1][0].content).toBe('done');
  });

  it('returns JSON-RPC error for unknown server request methods', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('test');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'unknown/method', id: 999, params: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const response = parseCapturedMessages(stdinChunks).find(m => m['id'] === 999 && 'error' in m);
    expect(response).toBeDefined();
    expect((response!['error'] as Record<string, unknown>)['code']).toBe(-32601);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sendMessage rejects with "Not ready" when called before init completes', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    await expect(wrapper.sendMessage('too early')).rejects.toThrow('Not ready');
  });

  it('sendMessage rejects with "Already processing" when called while busy', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('first');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    await expect(wrapper.sendMessage('second')).rejects.toThrow('Already processing');
  });

  it('getTranscript returns correct turns', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'response' } }) + '\n');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'completed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    const history = await wrapper.getTranscript();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('response');
  });

  it('destroy rejects ready and cleans up', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await new Promise(resolve => setTimeout(resolve, 20));

    const stdinEnd = vi.spyOn(fakeProc.stdin, 'end');
    wrapper.destroy();

    expect(stdinEnd).toHaveBeenCalled();
    await expect(wrapper.ready).rejects.toThrow('Destroyed');
  });

  it("emits 'error' (after ready) and destroys on NDJSON parse error", async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
    const onError = vi.fn();
    wrapper.on('error', onError);
    wrapper.ready.catch(() => {});

    feedStdout('this is not json\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    // During spawning, parse errors reject ready (no 'error' emit). Verify ready rejected.
    await expect(wrapper.ready).rejects.toThrow(/NDJSON parse error/);
  });

  it('handles stdin error: rejects ready when in spawning state', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    await new Promise(resolve => setTimeout(resolve, 20));

    fakeProc.stdin.emit('error', new Error('EPIPE'));

    await expect(wrapper.ready).rejects.toThrow('EPIPE');
  });

  it('spawns with correct arguments', () => {
    new CodexCLIWrapper('codex', '/my/project', TEST_ID);

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['app-server'],
      expect.objectContaining({
        cwd: '/my/project',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('prepends -c model_reasoning_effort=xhigh when effort=max is passed (max → xhigh)', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, 'max');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=xhigh', 'app-server']);
  });

  it('prepends -c model_reasoning_effort=minimal when effort=min is passed', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, 'min');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=minimal', 'app-server']);
  });

  it('does not include -c model_reasoning_effort when effort is undefined', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find((a) => a.startsWith('model_reasoning_effort='))).toBeUndefined();
  });

  it('does not include -c model_reasoning_effort when effort=default', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, 'default');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find((a) => a.startsWith('model_reasoning_effort='))).toBeUndefined();
  });

  it('passes -m model before app-server', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, 'gpt-5.4');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-m', 'gpt-5.4', 'app-server']);
  });

  it('places all global flags before app-server when both effort and model are set', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, 'high', 'gpt-x');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=high', '-m', 'gpt-x', 'app-server']);
  });

  describe('fullAccess and extraArgs', () => {
    it('default does not include --dangerously-bypass-approvals-and-sandbox', () => {
      new CodexCLIWrapper('codex', '/tmp', TEST_ID);

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('fullAccess: true places bypass flag before app-server, exactly once', () => {
      new CodexCLIWrapper(
        'codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        true,
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      const occurrences = spawnArgs.filter((a) => a === '--dangerously-bypass-approvals-and-sandbox').length;
      expect(occurrences).toBe(1);
      const bypassIdx = spawnArgs.indexOf('--dangerously-bypass-approvals-and-sandbox');
      const appServerIdx = spawnArgs.indexOf('app-server');
      expect(bypassIdx).toBeLessThan(appServerIdx);
    });

    it('extraArgs land in the global flag block, before app-server, in order', () => {
      new CodexCLIWrapper(
        'codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        undefined, ['--sandbox', 'read-only'],
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toEqual(['--sandbox', 'read-only', 'app-server']);
    });

    it('fullAccess: true and extraArgs are both global, bypass first', () => {
      new CodexCLIWrapper(
        'codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined,
        true, ['--ask-for-approval', 'never'],
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '--ask-for-approval', 'never',
        'app-server',
      ]);
    });
  });

  describe('registry integration', () => {
    it('registers instance with factory-assigned id', async () => {
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      const id = instance.getInstanceId();

      expect(id).toBeTruthy();
      expect(getInstance(id)).toBe(instance);

      const list = listInstances();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(id);
      expect(list[0].provider).toBe('codex');
      expect(list[0].cwd).toBe('/tmp');
      expect(list[0].meta).toBeUndefined();

      instance.destroy();
      instance.ready.catch(() => {});
    });

    it('setMeta is reflected in listInstances and getMeta', () => {
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      instance.setMeta({ label: 'L' });

      expect(instance.getMeta<{ label: string }>()).toEqual({ label: 'L' });
      expect(listInstances()[0].meta).toEqual({ label: 'L' });

      instance.destroy();
      instance.ready.catch(() => {});
    });

    it('destroy() does not unregister synchronously; entry remains in exiting until proc exits', async () => {
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      await completeInit();
      expect(listInstances()).toHaveLength(1);

      instance.destroy();
      expect(listInstances()).toHaveLength(1);
      expect(listInstances()[0].state).toBe('exiting');

      fakeProc.emit('exit', 0);
      expect(listInstances()).toHaveLength(0);
    });

    it('handshake failure removes the entry without proc.exit', async () => {
      createAIConversation({ provider: 'codex', cwd: '/tmp' });
      expect(listInstances()).toHaveLength(1);

      await new Promise(resolve => setTimeout(resolve, 10));

      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(listInstances()).toHaveLength(0);

      // A subsequent proc.exit is a silent no-op
      fakeProc.emit('exit', 1);
      expect(listInstances()).toHaveLength(0);
    });
  });

  describe('interrupt()', () => {
    async function startBusyTurn(
      wrapper: InstanceType<typeof CodexCLIWrapper>,
      stdinChunks: string[],
      turnId = 'turn-xyz',
    ): Promise<void> {
      const sendPromise = wrapper.sendMessage('hello');
      await new Promise(r => setTimeout(r, 10));
      const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
      feedStdout(JSON.stringify({
        jsonrpc: '2.0',
        id: turnMsg!['id'],
        result: { turn: { id: turnId } },
      }) + '\n');
      await sendPromise;
    }

    it('rejects when not busy', async () => {
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();
      await expect(wrapper.interrupt()).rejects.toThrow('Not busy');
    });

    it('rejects when destroyed', async () => {
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();
      wrapper.destroy();
      await expect(wrapper.interrupt()).rejects.toThrow('Destroyed');
    });

    it('captures turn.id from turn/start response', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks, 'turn-captured-1');

      void wrapper.interrupt().catch(() => {});
      await new Promise(r => setTimeout(r, 5));
      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      expect(interruptMsg).toBeDefined();
      expect((interruptMsg!['params'] as Record<string, unknown>)['turnId']).toBe('turn-captured-1');
    });

    it('rejects with "No active turn to interrupt" when turn/start response lacks turn.id', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();

      const sendPromise = wrapper.sendMessage('hello');
      await new Promise(r => setTimeout(r, 10));
      const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
      await sendPromise;

      await expect(wrapper.interrupt()).rejects.toThrow('No active turn to interrupt');
    });

    it('sends turn/interrupt with correct threadId+turnId', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit('thread-A');
      await startBusyTurn(wrapper, stdinChunks, 'turn-B');

      void wrapper.interrupt().catch(() => {});
      await new Promise(r => setTimeout(r, 5));

      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      expect(interruptMsg).toBeDefined();
      const params = interruptMsg!['params'] as Record<string, unknown>;
      expect(params['threadId']).toBe('thread-A');
      expect(params['turnId']).toBe('turn-B');
    });

    it('resolves only after BOTH the JSON-RPC ack AND turn/completed status="interrupted" arrive', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));

      let settled = false;
      interruptPromise.then(() => { settled = true; }, () => { settled = true; });

      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: interruptMsg!['id'], result: {} }) + '\n');
      await new Promise(r => setTimeout(r, 10));
      expect(settled).toBe(false);

      feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'interrupted' } },
      }) + '\n');
      await interruptPromise;
      expect(settled).toBe(true);
    });

    it("suppresses 'error', clears state, no assistant turn for status=\"interrupted\"", async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      const onError = vi.fn();
      const onConversation = vi.fn();
      const onMessage = vi.fn();
      wrapper.on('error', onError);
      wrapper.on('conversation', onConversation);
      wrapper.on('message', onMessage);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);
      onConversation.mockClear();

      feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'partial' } }) + '\n');

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));
      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: interruptMsg!['id'], result: {} }) + '\n');
      feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'interrupted' } },
      }) + '\n');
      await interruptPromise;

      expect(onError).not.toHaveBeenCalled();
      expect(onConversation).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('natural-completion race: assistant turn IS pushed with buffered content', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      const onConversation = vi.fn();
      const onMessage = vi.fn();
      const onError = vi.fn();
      wrapper.on('conversation', onConversation);
      wrapper.on('message', onMessage);
      wrapper.on('error', onError);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);
      onConversation.mockClear();

      feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'all done' } }) + '\n');

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));
      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: interruptMsg!['id'], result: {} }) + '\n');
      feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'completed' } },
      }) + '\n');
      await interruptPromise;

      expect(onError).not.toHaveBeenCalled();
      expect(onConversation).toHaveBeenCalledTimes(1);
      expect(onConversation.mock.calls[0][0].role).toBe('assistant');
      expect(onConversation.mock.calls[0][0].content).toBe('all done');
      expect(onMessage).toHaveBeenCalledWith('all done');
    });

    it("failure race: rejects AND 'error' fires for status=\"failed\"", async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      const onError = vi.fn();
      const onConversation = vi.fn();
      wrapper.on('error', onError);
      wrapper.on('conversation', onConversation);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);
      onConversation.mockClear();

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));
      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: interruptMsg!['id'], result: {} }) + '\n');
      feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'failed' } },
      }) + '\n');

      await expect(interruptPromise).rejects.toThrow('Turn failed with status: failed');
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0].message).toBe('Turn failed with status: failed');
      expect(onConversation).not.toHaveBeenCalled();
    });

    it('subsequent sendMessage works after interrupt() resolves', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks, 'turn-1');

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));
      const interruptMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/interrupt');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: interruptMsg!['id'], result: {} }) + '\n');
      feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'interrupted' } },
      }) + '\n');
      await interruptPromise;

      const sendPromise = wrapper.sendMessage('again');
      await new Promise(r => setTimeout(r, 10));
      const allTurnStarts = parseCapturedMessages(stdinChunks).filter(m => m['method'] === 'turn/start');
      expect(allTurnStarts.length).toBeGreaterThanOrEqual(2);
      const lastStart = allTurnStarts[allTurnStarts.length - 1];
      feedStdout(JSON.stringify({
        jsonrpc: '2.0',
        id: lastStart['id'],
        result: { turn: { id: 'turn-2' } },
      }) + '\n');
      await sendPromise;
    });

    it('external child death — exit handler resets all live state', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      const onError = vi.fn();
      wrapper.on('error', onError);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks, 'turn-doomed');

      feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'partial' } }) + '\n');
      await new Promise(r => setTimeout(r, 5));

      fakeProc.emit('exit', 1);
      await new Promise(r => setTimeout(r, 5));

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[onError.mock.calls.length - 1][0].message).toMatch(/exit.*1/i);

      // After exit, registry is empty and further sendMessage rejects with 'Destroyed'
      await expect(wrapper.sendMessage('after death')).rejects.toThrow('Destroyed');
    });

    it('rejects when child exits before the notification arrives', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      wrapper.on('error', () => {});
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));

      fakeProc.emit('exit', 1);
      await expect(interruptPromise).rejects.toThrow(/exit/i);
    });

    it('rejects with Destroyed when destroy() is called while interrupt is pending', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);

      const interruptPromise = wrapper.interrupt();
      await new Promise(r => setTimeout(r, 5));
      wrapper.destroy();

      await expect(interruptPromise).rejects.toThrow('Destroyed');
    });

    it('concurrent interrupt() rejects second call', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      wrapper.on('error', () => {});
      await completeInit();
      await startBusyTurn(wrapper, stdinChunks);

      const first = wrapper.interrupt();
      first.catch(() => {});
      await expect(wrapper.interrupt()).rejects.toThrow('Interrupt already in progress');

      wrapper.destroy();
      await first.catch(() => {});
    });
  });

  describe('lifecycle events', () => {
    it('construction emits instance:added exactly once', () => {
      const added = vi.fn();
      instanceEvents.on('instance:added', added);

      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });

      expect(added).toHaveBeenCalledOnce();
      expect(added.mock.calls[0][0].id).toBe(instance.getInstanceId());
      expect(added.mock.calls[0][0].provider).toBe('codex');
      expect(added.mock.calls[0][0].cwd).toBe('/tmp');

      instance.destroy();
      instance.ready.catch(() => {});
    });

    it("destroy() then proc exit emits instance:removed exactly once", async () => {
      const removed = vi.fn();
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      await completeInit();
      instanceEvents.on('instance:removed', removed);

      instance.destroy();
      expect(removed).not.toHaveBeenCalled();

      fakeProc.emit('exit', 0);
      expect(removed).toHaveBeenCalledOnce();
    });

    it("proc.emit('error') emits added then removed", async () => {
      const added = vi.fn();
      const removed = vi.fn();
      instanceEvents.on('instance:added', added);
      instanceEvents.on('instance:removed', removed);

      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      instance.ready.catch(() => {});

      expect(added).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();

      fakeProc.emit('error', new Error('ENOENT'));

      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].id).toBe(added.mock.calls[0][0].id);
    });

    it('instance:ready fires exactly once after thread/start handshake (Codex)', async () => {
      const ready = vi.fn();
      const added = vi.fn();
      instanceEvents.on('instance:added', added);
      instanceEvents.on('instance:ready', ready);

      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });

      expect(added).toHaveBeenCalledOnce();
      expect(ready).not.toHaveBeenCalled();

      await completeInit('thread-ready-1');

      expect(ready).toHaveBeenCalledOnce();
      expect(ready.mock.calls[0][0].id).toBe(instance.getInstanceId());
      expect(ready.mock.calls[0][0].provider).toBe('codex');
      expect(ready.mock.calls[0][0].sessionId).toBe('thread-ready-1');

      instance.destroy();
    });

    it('handshake failure emits added then removed and rejects ready', async () => {
      const added = vi.fn();
      const removed = vi.fn();
      instanceEvents.on('instance:added', added);
      instanceEvents.on('instance:removed', removed);

      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });

      expect(added).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();

      await new Promise(resolve => setTimeout(resolve, 10));

      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(added).toHaveBeenCalledOnce();
      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].id).toBe(added.mock.calls[0][0].id);
      await expect(instance.ready).rejects.toThrow('init failed');
    });
  });

  describe('state machine', () => {
    it('construction emits added(spawning); handshake completion emits state-changed(spawning→ready) then ready', async () => {
      const events: Array<{ kind: string; prev?: string; next?: string; state: string }> = [];
      instanceEvents.on('instance:added', info => events.push({ kind: 'added', state: info.state }));
      instanceEvents.on('instance:state-changed', (info, prev, next) => events.push({ kind: 'state', prev, next, state: info.state }));
      instanceEvents.on('instance:ready', info => events.push({ kind: 'ready', state: info.state }));

      createAIConversation({ provider: 'codex', cwd: '/tmp' });

      expect(events).toEqual([{ kind: 'added', state: 'spawning' }]);

      await completeInit();

      expect(events).toEqual([
        { kind: 'added', state: 'spawning' },
        { kind: 'state', prev: 'spawning', next: 'ready', state: 'ready' },
        { kind: 'ready', state: 'ready' },
      ]);
    });

    it('sendMessage → turn/completed emits state-changed(ready→busy) then state-changed(busy→ready)', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();

      const stateEvents: Array<[string, string]> = [];
      instanceEvents.on('instance:state-changed', (_info, prev, next) => stateEvents.push([prev, next]));

      const sendPromise = wrapper.sendMessage('hello');
      await new Promise(r => setTimeout(r, 10));
      const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
      await sendPromise;

      feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'completed' } },
      }) + '\n');
      await new Promise(r => setTimeout(r, 10));

      expect(stateEvents).toEqual([
        ['ready', 'busy'],
        ['busy', 'ready'],
      ]);
    });

    it('destroy() emits state-changed(*→exiting); proc exit emits removed; removed payload state is "exiting"', async () => {
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();

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
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      wrapper.on('error', () => {});
      await completeInit();

      const sendPromise = wrapper.sendMessage('hello');
      await new Promise(r => setTimeout(r, 10));
      const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: { turn: { id: 'turn-1' } } }) + '\n');
      await sendPromise;

      const events: string[] = [];
      instanceEvents.on('instance:state-changed', (_info, prev, next) => events.push(`${prev}->${next}`));
      instanceEvents.on('instance:removed', () => events.push('removed'));

      fakeProc.emit('exit', 1);
      await new Promise(r => setTimeout(r, 10));

      expect(events).toEqual(['busy->exiting', 'removed']);
    });

    it('handshake failure emits state-changed(spawning→exiting) then removed (no instance:ready)', async () => {
      const events: string[] = [];
      instanceEvents.on('instance:state-changed', (_info, prev, next) => events.push(`state:${prev}->${next}`));
      instanceEvents.on('instance:removed', () => events.push('removed'));
      instanceEvents.on('instance:ready', () => events.push('ready'));

      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      instance.ready.catch(() => {});

      await new Promise(resolve => setTimeout(resolve, 10));
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(events).toEqual(['state:spawning->exiting', 'removed']);
      expect(events).not.toContain('ready');
    });

    it('sendMessage while state === "exiting" rejects with "Destroyed"', async () => {
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      await completeInit();

      wrapper.destroy();
      await expect(wrapper.sendMessage('too late')).rejects.toThrow('Destroyed');
    });
  });

  describe('late terminator after teardown', () => {
    it('turn/completed arriving after destroy() while busy is dropped silently', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      const onMessage = vi.fn();
      const onConversation = vi.fn();
      wrapper.on('message', onMessage);
      wrapper.on('conversation', onConversation);
      await completeInit();

      const sendPromise = wrapper.sendMessage('hello');
      await new Promise(r => setTimeout(r, 10));
      const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: { turn: { id: 'turn-x' } } }) + '\n');
      await sendPromise;
      onConversation.mockClear();

      // Wrapper is busy. Destroy mid-turn → tearDownChild transitions to 'exiting'.
      wrapper.destroy();

      // Late turn/completed arrives. Must not throw (illegal exiting → ready),
      // must not emit on a torn-down wrapper.
      expect(() => feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'completed' } },
      }) + '\n')).not.toThrow();
      await new Promise(r => setTimeout(r, 5));

      expect(onMessage).not.toHaveBeenCalled();
      expect(onConversation).not.toHaveBeenCalled();
    });

    it('turn/completed arriving after error-path unregister is dropped silently', async () => {
      const stdinChunks = captureStdin(fakeProc);
      const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);
      const onMessage = vi.fn();
      const onConversation = vi.fn();
      wrapper.on('message', onMessage);
      wrapper.on('conversation', onConversation);
      wrapper.on('error', () => {});
      await completeInit();

      const sendPromise = wrapper.sendMessage('hello');
      await new Promise(r => setTimeout(r, 10));
      const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: { turn: { id: 'turn-x' } } }) + '\n');
      await sendPromise;
      onConversation.mockClear();

      // Error handler self-unregisters; entry is gone.
      fakeProc.emit('error', new Error('ENOENT'));

      expect(() => feedStdout(JSON.stringify({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: 'thread-abc', turn: { status: 'completed' } },
      }) + '\n')).not.toThrow();
      await new Promise(r => setTimeout(r, 5));

      expect(onMessage).not.toHaveBeenCalled();
      expect(onConversation).not.toHaveBeenCalled();
    });
  });
});
