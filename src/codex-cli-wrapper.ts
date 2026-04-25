import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AIConversationInstance, ConversationTurn, Effort, InstanceMessageEventMap } from './types.js';
import { NdjsonParser } from './ndjson-parser.js';
import { effortToCodexValue } from './effort-mapping.js';
import { loadSessionHistory } from './sessions.js';
import {
  register, unregister, setMetaFor, getMetaFor,
  setExitCodeFor, transitionState, getState,
  type InstanceState,
} from './registry.js';

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

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class CodexCLIWrapper
  extends EventEmitter<InstanceMessageEventMap>
  implements AIConversationInstance
{
  private proc: ChildProcess;
  private readonly cwd: string;
  private readonly instanceId: string;
  private threadId: string | null = null;
  private history: ConversationTurn[] = [];
  private terminationScheduled = false;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private turnBuffer = '';
  private readonly systemPrompt: string | null;
  private readonly resumeSessionId: string | null;
  private historyLoadPromise: Promise<void> | null = null;
  private currentTurnId: string | null = null;
  private interrupting = false;
  private busyClearedResolve: (() => void) | null = null;
  private busyClearedReject: ((e: Error) => void) | null = null;

  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;

  get state(): InstanceState {
    return getState(this.instanceId);
  }

  constructor(
    binary: string, cwd: string, instanceId: string,
    systemPrompt?: string,
    sessionId?: string, effort?: Effort, model?: string,
    envExtra?: Record<string, string>,
    fullAccess?: boolean, extraArgs?: string[],
  ) {
    super();
    this.cwd = cwd;
    this.instanceId = instanceId;
    this.systemPrompt = systemPrompt ?? null;
    this.resumeSessionId = sessionId ?? null;

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});

    const parser = new NdjsonParser({
      onParsed: (obj) => this.handleParsed(obj),
      onError: (_line, error) => {
        const wrapped = new Error(`NDJSON parse error: ${error.message}`);
        if (getState(this.instanceId) === 'spawning') {
          this.rejectReady(wrapped);
        } else {
          this.safeEmitError(wrapped);
        }
        this.destroy();
      },
    });

    const globalFlags: string[] = [];
    if (fullAccess === true) {
      globalFlags.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (effort !== undefined) {
      const value = effortToCodexValue(effort);
      if (value !== null) globalFlags.push('-c', `model_reasoning_effort=${value}`);
    }
    if (model !== undefined) {
      globalFlags.push('-m', model);
    }
    if (extraArgs !== undefined && extraArgs.length > 0) {
      globalFlags.push(...extraArgs);
    }

    this.proc = spawn(binary, [...globalFlags, 'app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...filterEnv(), ...(envExtra ?? {}) },
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    this.proc.stderr!.on('data', (_chunk: Buffer) => {
      // Debug-level stderr output — no action in v1
    });

    this.proc.stdin!.on('error', (err) => {
      const cur = getState(this.instanceId);
      this.tearDownChild(err);
      if (cur === 'spawning') {
        this.rejectReady(err);
      } else {
        this.safeEmitError(err);
      }
      this.destroy();
      // 'exit' may not fire after 'error' (Node docs); self-unregister.
      unregister(this.instanceId);
    });

    this.proc.on('exit', (code) => {
      const exitMessage = `Process exited with code ${code}`;
      const exitError = new Error(exitMessage);
      const cur = getState(this.instanceId);
      const wasBusy = cur === 'busy';
      const wasSpawning = cur === 'spawning';

      this.tearDownChild(exitError);
      setExitCodeFor(this.instanceId, code);

      if (wasSpawning) {
        this.rejectReady(exitError);
      } else if (wasBusy) {
        this.safeEmitError(exitError);
      }
      unregister(this.instanceId);
    });

    this.proc.on('error', (err) => {
      const cur = getState(this.instanceId);
      this.tearDownChild(err);
      if (cur === 'spawning') {
        this.rejectReady(err);
      } else {
        this.safeEmitError(err);
      }
      this.destroy();
      // 'exit' may not fire after 'error' (Node docs); self-unregister.
      unregister(this.instanceId);
    });

    register({
      instance: this,
      provider: 'codex',
      cwd,
      createdAt: new Date(),
      meta: undefined,
    });

    this.initialize();
  }

  private safeEmitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  private async initialize(): Promise<void> {
    try {
      await this.sendJsonRpcRequest('initialize', {
        clientInfo: { name: 'daphnis', title: 'Daphnis', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });

      const threadMethod = this.resumeSessionId ? 'thread/resume' : 'thread/start';
      const threadParams = this.resumeSessionId ? { threadId: this.resumeSessionId } : {};
      const threadResult = await this.sendJsonRpcRequest(threadMethod, threadParams) as
        { thread: { id: string } };
      this.threadId = threadResult.thread.id;
      transitionState(this.instanceId, 'ready');
      this.resolveReady();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const cur = getState(this.instanceId);
      if (cur === 'spawning') {
        this.rejectReady(e);
        if (getState(this.instanceId) !== 'exiting') {
          transitionState(this.instanceId, 'exiting');
        }
      } else if (cur !== 'exiting') {
        this.safeEmitError(e);
      }
      this.destroy();
      // Self-unregister: handshake failure may not produce a proc 'exit'
      // synchronously (the child is alive until our scheduled SIGKILL).
      // Subsequent proc.on('exit')/'error' will hit the silent no-op.
      unregister(this.instanceId);
    }
  }

  private sendJsonRpcRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      id,
      params,
    });

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.proc.stdin!.write(message + '\n', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private handleParsed(obj: unknown): void {
    if (typeof obj !== 'object' || obj === null) return;
    const msg = obj as Record<string, unknown>;

    const hasId = 'id' in msg;
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;
    const hasMethod = 'method' in msg;

    if (hasId && (hasResult || hasError) && !hasMethod) {
      const id = msg['id'] as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (hasError) {
          const errObj = msg['error'] as { message?: string };
          pending.reject(new Error(errObj?.message ?? 'JSON-RPC error'));
        } else {
          pending.resolve(msg['result']);
        }
      }
      return;
    }

    if (hasMethod && hasId && !hasResult && !hasError) {
      this.handleServerRequest(msg['method'] as string, msg['id'] as number, msg['params']);
      return;
    }

    if (hasMethod && !hasId) {
      this.handleNotification(msg['method'] as string, msg['params']);
      return;
    }
  }

  private handleServerRequest(method: string, id: number, _params: unknown): void {
    let response: string;

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        response = JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { decision: 'accept' },
        });
        break;

      case 'item/permissions/requestApproval':
        response = JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            permissions: {
              fileSystem: { read: [this.cwd], write: [this.cwd] },
              network: { enabled: true },
              macos: {
                accessibility: true,
                calendar: true,
                automations: 'all',
                preferences: 'read_write',
              },
            },
            scope: 'session',
          },
        });
        break;

      case 'item/tool/call':
        response = JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            success: false,
            contentItems: [{ type: 'inputText', text: 'Tool execution not supported in this client' }],
          },
        });
        break;

      default:
        console.warn(`CodexCLIWrapper: unknown server request method "${method}"`);
        response = JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not supported' },
        });
        break;
    }

    try {
      this.proc.stdin!.write(response + '\n');
    } catch {
      // stdin may be closed
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown> | undefined;

    switch (method) {
      case 'initialized':
      case 'thread/started':
      case 'turn/started':
      case 'item/completed':
        break;

      case 'item/agentMessage/delta': {
        const delta = (p?.['delta'] as string) ?? '';
        this.turnBuffer += delta;
        break;
      }

      case 'turn/completed': {
        // Late terminator after teardown (destroy, exit, error path):
        // state is 'exiting' (or unknown id → terminal fallback). Drop
        // the notification silently — transitioning to 'ready' would be
        // illegal, and emitting on a torn-down wrapper is a contract
        // violation.
        if (getState(this.instanceId) !== 'busy') return;

        const turn = p?.['turn'] as Record<string, unknown> | undefined;
        const status = turn?.['status'] as string | undefined;

        const completedContent = this.turnBuffer;
        this.turnBuffer = '';
        transitionState(this.instanceId, 'ready');
        this.currentTurnId = null;

        if (this.interrupting) {
          this.interrupting = false;
          const resolveBusy = this.busyClearedResolve;
          const rejectBusy = this.busyClearedReject;
          this.busyClearedResolve = null;
          this.busyClearedReject = null;

          if (status === 'interrupted') {
            resolveBusy?.();
            return;
          }
          if (status === 'completed') {
            resolveBusy?.();
            const assistantTurn: ConversationTurn = {
              role: 'assistant',
              content: completedContent,
              timestamp: new Date(),
            };
            this.history.push(assistantTurn);
            this.emit('conversation', assistantTurn);
            this.emit('message', assistantTurn.content);
            return;
          }
          const err = new Error(`Turn failed with status: ${status ?? 'unknown'}`);
          rejectBusy?.(err);
          this.safeEmitError(err);
          return;
        }

        if (status === 'completed') {
          const assistantTurn: ConversationTurn = {
            role: 'assistant',
            content: completedContent,
            timestamp: new Date(),
          };
          this.history.push(assistantTurn);
          this.emit('conversation', assistantTurn);
          this.emit('message', assistantTurn.content);
        } else {
          this.safeEmitError(new Error(`Turn failed with status: ${status ?? 'unknown'}`));
        }
        break;
      }

      default:
        break;
    }
  }

  async sendMessage(text: string): Promise<void> {
    const cur = getState(this.instanceId);
    if (cur === 'exiting') throw new Error('Destroyed');
    if (cur === 'busy') throw new Error('Already processing');
    if (cur !== 'ready') throw new Error('Not ready');

    transitionState(this.instanceId, 'busy');
    this.turnBuffer = '';

    try {
      const turnParams: Record<string, unknown> = {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      };
      if (this.systemPrompt) {
        turnParams.collaborationMode = {
          settings: { developer_instructions: this.systemPrompt },
        };
      }
      const result = await this.sendJsonRpcRequest('turn/start', turnParams) as
        { turn?: { id?: string } } | undefined;
      if (typeof result?.turn?.id === 'string') {
        this.currentTurnId = result.turn.id;
      }

      const userTurn: ConversationTurn = {
        role: 'user',
        content: text,
        timestamp: new Date(),
      };
      this.history.push(userTurn);
      this.emit('conversation', userTurn);
    } catch (err) {
      if (getState(this.instanceId) === 'busy') {
        transitionState(this.instanceId, 'ready');
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async getTranscript(): Promise<ConversationTurn[]> {
    if (!this.historyLoadPromise && this.resumeSessionId) {
      this.historyLoadPromise = loadSessionHistory('codex', this.resumeSessionId, this.cwd)
        .then((prior) => { this.history.unshift(...prior); });
    }
    if (this.historyLoadPromise) {
      await this.historyLoadPromise;
    }
    return [...this.history];
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  getPid(): number {
    return this.proc.pid ?? 0;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  setMeta(value: unknown): void {
    setMetaFor(this.instanceId, value);
  }

  getMeta<T = unknown>(): T | undefined {
    return getMetaFor(this.instanceId) as T | undefined;
  }

  async interrupt(): Promise<void> {
    const cur = getState(this.instanceId);
    if (cur === 'exiting') throw new Error('Destroyed');
    if (cur !== 'busy') throw new Error('Not busy');
    if (!this.threadId || !this.currentTurnId) {
      throw new Error('No active turn to interrupt');
    }
    if (this.interrupting) throw new Error('Interrupt already in progress');
    this.interrupting = true;

    const ack = this.sendJsonRpcRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.currentTurnId,
    });

    const busyCleared = new Promise<void>((resolve, reject) => {
      this.busyClearedResolve = resolve;
      this.busyClearedReject = reject;
    });

    try {
      await Promise.all([ack, busyCleared]);
    } catch (err) {
      this.interrupting = false;
      throw err;
    } finally {
      this.busyClearedResolve = null;
      this.busyClearedReject = null;
    }
  }

  /**
   * Reset all live state on external child death (stdin error, exit, or
   * spawn error). Idempotent. Transitions to 'exiting' on first call,
   * rejects pending JSON-RPC requests and any pending interrupt, clears
   * turn-level state. Does NOT unregister — each terminal handler does
   * that itself.
   */
  private tearDownChild(err: Error): void {
    if (getState(this.instanceId) !== 'exiting') {
      transitionState(this.instanceId, 'exiting');
    }
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
    if (this.busyClearedReject) {
      this.busyClearedReject(err);
    }
    this.busyClearedResolve = null;
    this.busyClearedReject = null;
    this.interrupting = false;
    this.currentTurnId = null;
    this.turnBuffer = '';
  }

  destroy(): void {
    if (this.terminationScheduled) return;
    this.terminationScheduled = true;
    const cur = getState(this.instanceId);
    if (cur !== 'exiting') {
      this.tearDownChild(new Error('Destroyed'));
    }
    if (cur === 'spawning') this.rejectReady(new Error('Destroyed'));

    try {
      this.proc.stdin!.end();
    } catch {
      // stdin may already be closed
    }

    setTimeout(() => {
      try {
        this.proc.kill();
      } catch {
        // process may already be dead
      }
    }, 3000);
    // unregister happens in proc.on('exit') — do NOT call here.
  }
}
