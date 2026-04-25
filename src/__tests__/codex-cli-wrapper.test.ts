import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { CodexCLIWrapper } = await import('../codex-cli-wrapper.js');
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

/** Helper: capture what gets written to stdin */
function captureStdin(proc: ReturnType<typeof createFakeProcess>): string[] {
  const chunks: string[] = [];
  proc.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return chunks;
}

/** Helper: parse all captured stdin chunks as JSON-RPC messages */
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
  });

  afterEach(() => {
    __resetForTests();
  });

  function feedStdout(data: string) {
    fakeProc.stdout.push(data);
  }

  /** Complete the init handshake: respond to initialize + thread/start requests */
  async function completeInit(threadId = 'thread-abc') {
    // Wait a tick for the constructor's async initialize() to send the first request
    await vi.waitFor(() => {
      const msgs = parseCapturedMessages(captureStdin(fakeProc));
      // At minimum, initialize should have been sent
      return msgs.length >= 0; // we check via stdout response
    }, { timeout: 100 }).catch(() => {});

    // Give the constructor time to write to stdin
    await new Promise(resolve => setTimeout(resolve, 10));

    // Respond to initialize (id: 1)
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');

    // Give time for thread/start to be sent
    await new Promise(resolve => setTimeout(resolve, 10));

    // Respond to thread/start (id: 2)
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { thread: { id: threadId } } }) + '\n');

    // Give time for onReady to fire
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  it('fires onReady after successful initialization', async () => {
    const onReady = vi.fn();
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onReady });

    await completeInit();

    expect(onReady).toHaveBeenCalledOnce();
  });

  it('getSessionId returns null before init and thread ID after', async () => {
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    expect(wrapper.getSessionId()).toBeNull();

    await completeInit('thread-session-42');

    expect(wrapper.getSessionId()).toBe('thread-session-42');
  });

  it('sends initialize with experimentalApi and configurable clientInfo', async () => {
    const stdinChunks = captureStdin(fakeProc);
    new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    // Wait for initialize to be written
    await new Promise(resolve => setTimeout(resolve, 10));

    const initMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'initialize');
    expect(initMsg).toBeDefined();
    expect(initMsg!['id']).toBe(1);

    const params = initMsg!['params'] as Record<string, unknown>;
    // Default clientInfo
    expect(params['clientInfo']).toEqual({ name: 'daphnis', title: 'Daphnis', version: '1.0.0' });
    // experimentalApi must be enabled
    expect(params['capabilities']).toEqual({ experimentalApi: true });

    // Respond to initialize
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const threadMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/start');
    expect(threadMsg).toBeDefined();
    expect(threadMsg!['id']).toBe(2);
  });

  it('sends thread/resume instead of thread/start when sessionId is provided', async () => {
    const stdinChunks = captureStdin(fakeProc);
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, 'prev-thread-99');

    await new Promise(resolve => setTimeout(resolve, 10));

    // Respond to initialize
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const resumeMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/resume');
    expect(resumeMsg).toBeDefined();
    expect((resumeMsg!['params'] as Record<string, unknown>)['threadId']).toBe('prev-thread-99');

    // No thread/start should have been sent
    const startMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'thread/start');
    expect(startMsg).toBeUndefined();

    // Respond to thread/resume
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

  it('uses custom clientInfo when provided', async () => {
    const stdinChunks = captureStdin(fakeProc);
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, { name: 'myapp', title: 'My App', version: '2.0.0' });

    await new Promise(resolve => setTimeout(resolve, 10));

    const initMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'initialize');
    const params = initMsg!['params'] as Record<string, unknown>;
    expect(params['clientInfo']).toEqual({ name: 'myapp', title: 'My App', version: '2.0.0' });
  });

  it('fires onError on init failure', async () => {
    const onError = vi.fn();
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Respond with error to initialize
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe('init failed');
  });

  it('sends turn/start on sendMessage and fires onConversation for user turn', async () => {
    const onConversation = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onConversation });

    await completeInit();

    // sendMessage returns a promise
    const sendPromise = wrapper.sendMessage('hello');

    await new Promise(resolve => setTimeout(resolve, 10));

    // Find the turn/start request
    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    expect(turnMsg).toBeDefined();
    expect((turnMsg!['params'] as Record<string, unknown>)['threadId']).toBe('thread-abc');

    // Respond to turn/start
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    expect(onConversation).toHaveBeenCalledTimes(1);
    expect(onConversation.mock.calls[0][0].role).toBe('user');
    expect(onConversation.mock.calls[0][0].content).toBe('hello');
  });

  it('includes collaborationMode in turn/start when systemPrompt is set', async () => {
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, 'You are a code reviewer');

    await completeInit();

    const sendPromise = wrapper.sendMessage('review this');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    expect(turnMsg).toBeDefined();
    const params = turnMsg!['params'] as Record<string, unknown>;
    expect(params['collaborationMode']).toEqual({
      settings: { developer_instructions: 'You are a code reviewer' },
    });

    // Complete the turn
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

  it('accumulates deltas and fires onConversation + onMessage on turn/completed', async () => {
    const onConversation = vi.fn();
    const onMessage = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onConversation, onMessage });

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    // Feed delta fragments
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'Hello' } }) + '\n');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: ' World' } }) + '\n');

    // Feed turn/completed
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'completed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    // user + assistant
    expect(onConversation).toHaveBeenCalledTimes(2);
    expect(onConversation.mock.calls[1][0].role).toBe('assistant');
    expect(onConversation.mock.calls[1][0].content).toBe('Hello World');
    expect(onMessage).toHaveBeenCalledWith('Hello World');
  });

  it('fires onError on failed turn', async () => {
    const onError = vi.fn();
    const onConversation = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError, onConversation });

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'failed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalled();
    // Only user turn, no assistant
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

    // Server sends command approval request
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

    // Server sends permissions approval request
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/permissions/requestApproval', id: 200, params: {} }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));

    const response = parseCapturedMessages(stdinChunks).find(m => m['id'] === 200 && 'result' in m);
    expect(response).toBeDefined();
    const result = response!['result'] as Record<string, unknown>;
    const permissions = result['permissions'] as Record<string, unknown>;

    // fileSystem.read/write must be path arrays, not booleans
    const fs = permissions['fileSystem'] as Record<string, unknown>;
    expect(Array.isArray(fs['read'])).toBe(true);
    expect(Array.isArray(fs['write'])).toBe(true);
    expect((fs['read'] as string[]).length).toBeGreaterThan(0);

    // network.enabled must be boolean
    const net = permissions['network'] as Record<string, unknown>;
    expect(net['enabled']).toBe(true);

    // macos (lowercase) must have accessibility, calendar, automations, preferences
    const mac = permissions['macos'] as Record<string, unknown>;
    expect(mac).toBeDefined();
    expect(mac['accessibility']).toBe(true);
    expect(mac['calendar']).toBe(true);
    expect(mac['automations']).toBe('all');
    expect(mac['preferences']).toBe('read_write');

    // scope must be present
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
    const onConversation = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onConversation });

    await completeInit();

    const sendPromise = wrapper.sendMessage('hello');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'ok' } }) + '\n');

    // Status is nested under params.turn.status
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
    const onConversation = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onConversation });

    await completeInit();

    const sendPromise = wrapper.sendMessage('complex task');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    // Command approval
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/commandExecution/requestApproval', id: 200, params: {} }) + '\n');
    // File change approval
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/fileChange/requestApproval', id: 201, params: {} }) + '\n');
    // Delta
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'done' } }) + '\n');
    // Turn complete
    feedStdout(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-abc', turn: { status: 'completed' } } }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 10));

    // Both approvals answered
    const msgs = parseCapturedMessages(stdinChunks);
    expect(msgs.filter(m => m['id'] === 200 && 'result' in m)).toHaveLength(1);
    expect(msgs.filter(m => m['id'] === 201 && 'result' in m)).toHaveLength(1);

    // Final response assembled
    expect(onConversation).toHaveBeenCalledTimes(2); // user + assistant
    expect(onConversation.mock.calls[1][0].content).toBe('done');
  });

  it('returns JSON-RPC error for unknown server request methods', async () => {
    const onError = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });

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

    // No onError on the instance for unknown server requests
    // (only init error would have been caught, not server request errors)
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fires onError when sendMessage called before ready', async () => {
    const onError = vi.fn();
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });

    // Don't complete init
    await wrapper.sendMessage('too early');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Not ready' }));
  });

  it('fires onError when sendMessage called while busy', async () => {
    const onError = vi.fn();
    const stdinChunks = captureStdin(fakeProc);
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });

    await completeInit();

    const sendPromise = wrapper.sendMessage('first');
    await new Promise(resolve => setTimeout(resolve, 10));

    const turnMsg = parseCapturedMessages(stdinChunks).find(m => m['method'] === 'turn/start');
    feedStdout(JSON.stringify({ jsonrpc: '2.0', id: turnMsg!['id'], result: {} }) + '\n');
    await sendPromise;

    // Still busy (no turn/completed yet)
    await wrapper.sendMessage('second');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Already processing' }));
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

  it('destroy rejects pending requests and cleans up', async () => {
    const onError = vi.fn();
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });

    // Give the constructor time to send initialize request
    await new Promise(resolve => setTimeout(resolve, 20));

    const stdinEnd = vi.spyOn(fakeProc.stdin, 'end');
    wrapper.destroy();

    expect(stdinEnd).toHaveBeenCalled();

    // Wait for the async initialize() catch block to fire onError
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(onError).toHaveBeenCalled();
  });

  it('fires onError and destroys on NDJSON parse error', async () => {
    const onError = vi.fn();
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });
    const destroySpy = vi.spyOn(wrapper, 'destroy');

    // Feed invalid JSON — this will trigger parse error before init completes
    feedStdout('this is not json\n');

    // The init promise rejection also fires onError, so wait for both
    await new Promise(resolve => setTimeout(resolve, 50));

    const parseErrorCall = onError.mock.calls.find(
      (call: [Error]) => call[0].message.includes('NDJSON parse error'),
    );
    expect(parseErrorCall).toBeDefined();
    expect(destroySpy).toHaveBeenCalled();
  });

  it('handles stdin error by rejecting pending requests and firing onError', async () => {
    const onError = vi.fn();
    const wrapper = new CodexCLIWrapper('codex', '/tmp', TEST_ID, { onError });
    const destroySpy = vi.spyOn(wrapper, 'destroy');

    // Give time for init request to be sent
    await new Promise(resolve => setTimeout(resolve, 20));

    // Simulate stdin pipe error
    fakeProc.stdin.emit('error', new Error('EPIPE'));

    // Wait for async error propagation
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(onError).toHaveBeenCalled();
    const epipeCall = onError.mock.calls.find(
      (call: [Error]) => call[0].message === 'EPIPE',
    );
    expect(epipeCall).toBeDefined();
    expect(destroySpy).toHaveBeenCalled();
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

  // --- effort / model passthrough ---

  it('prepends -c model_reasoning_effort=xhigh when effort=max is passed (max → xhigh)', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, 'max');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=xhigh', 'app-server']);
  });

  it('prepends -c model_reasoning_effort=minimal when effort=min is passed', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, 'min');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=minimal', 'app-server']);
  });

  it('does not include -c model_reasoning_effort when effort is undefined', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find((a) => a.startsWith('model_reasoning_effort='))).toBeUndefined();
  });

  it('does not include -c model_reasoning_effort when effort=default', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, 'default');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.find((a) => a.startsWith('model_reasoning_effort='))).toBeUndefined();
  });

  it('passes -m model before app-server', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, undefined, 'gpt-5.4');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-m', 'gpt-5.4', 'app-server']);
  });

  it('places all global flags before app-server when both effort and model are set', () => {
    new CodexCLIWrapper('codex', '/tmp', TEST_ID, undefined, undefined, undefined, undefined, 'high', 'gpt-x');

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toEqual(['-c', 'model_reasoning_effort=high', '-m', 'gpt-x', 'app-server']);
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
    });

    it('setMeta is reflected in listInstances and getMeta', () => {
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      instance.setMeta({ label: 'L' });

      expect(instance.getMeta<{ label: string }>()).toEqual({ label: 'L' });
      expect(listInstances()[0].meta).toEqual({ label: 'L' });

      instance.destroy();
    });

    it('destroy() removes the entry synchronously', () => {
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      expect(listInstances()).toHaveLength(1);

      instance.destroy();
      expect(listInstances()).toHaveLength(0);
    });

    it('deregisters when the process emits error (e.g. ENOENT)', () => {
      const onError = vi.fn();
      createAIConversation({
        provider: 'codex',
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
        provider: 'codex',
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

    it('removes entry when init handshake fails and process exits', async () => {
      const onError = vi.fn();
      createAIConversation({ provider: 'codex', cwd: '/tmp', handlers: { onError } });

      expect(listInstances()).toHaveLength(1);

      await new Promise(resolve => setTimeout(resolve, 10));

      // initialize fails — wrapper should call onError and destroy()
      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onError).toHaveBeenCalled();

      // destroy() synchronously removed the entry
      expect(listInstances()).toHaveLength(0);

      // And the exit path (once the child actually dies) is a no-op for the registry
      fakeProc.emit('exit', 1);
      expect(listInstances()).toHaveLength(0);
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
    });

    it('destroy() emits instance:removed exactly once and a subsequent exit does not re-emit', () => {
      const removed = vi.fn();
      const instance = createAIConversation({ provider: 'codex', cwd: '/tmp' });
      instanceEvents.on('instance:removed', removed);

      instance.destroy();
      expect(removed).toHaveBeenCalledOnce();

      fakeProc.emit('exit', 0);
      expect(removed).toHaveBeenCalledOnce();
    });

    it("proc.emit('exit') without prior destroy emits instance:removed exactly once", () => {
      const removed = vi.fn();
      createAIConversation({ provider: 'codex', cwd: '/tmp', handlers: { onError: () => {} } });
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
        provider: 'codex',
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

    it('handshake failure emits added then removed', async () => {
      const added = vi.fn();
      const removed = vi.fn();
      const onError = vi.fn();
      instanceEvents.on('instance:added', added);
      instanceEvents.on('instance:removed', removed);

      createAIConversation({ provider: 'codex', cwd: '/tmp', handlers: { onError } });

      expect(added).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();

      await new Promise(resolve => setTimeout(resolve, 10));

      feedStdout(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init failed' } }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(added).toHaveBeenCalledOnce();
      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].id).toBe(added.mock.calls[0][0].id);
    });
  });
});
