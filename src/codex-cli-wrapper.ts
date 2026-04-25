import { spawn, type ChildProcess } from 'node:child_process';
import type { AIConversationInstance, AIConversationHandlers, ConversationTurn, Effort } from './types.js';
import { NdjsonParser } from './ndjson-parser.js';
import { effortToCodexValue } from './effort-mapping.js';
import { loadSessionHistory } from './sessions.js';
import { register, unregister, setMetaFor, getMetaFor } from './registry.js';

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

export class CodexCLIWrapper implements AIConversationInstance {
  private proc: ChildProcess;
  private readonly cwd: string;
  private readonly instanceId: string;
  private threadId: string | null = null;
  private history: ConversationTurn[] = [];
  private ready = false;
  private busy = false;
  private destroyed = false;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private turnBuffer = '';
  private readonly systemPrompt: string | null;
  private readonly resumeSessionId: string | null;
  private historyLoadPromise: Promise<void> | null = null;

  // Mutable callbacks
  onReady: () => void;
  onExit: (exitCode: number | null) => void;
  onError: (error: Error) => void;
  onMessage: (text: string) => void;
  onConversation: (turn: ConversationTurn) => void;

  constructor(
    binary: string, cwd: string, instanceId: string,
    handlers?: AIConversationHandlers,
    systemPrompt?: string,
    sessionId?: string, effort?: Effort, model?: string,
    envExtra?: Record<string, string>,
    fullAccess?: boolean, extraArgs?: string[],
  ) {
    this.cwd = cwd;
    this.instanceId = instanceId;
    this.systemPrompt = systemPrompt ?? null;
    this.resumeSessionId = sessionId ?? null;

    // 1. Set no-op defaults
    this.onReady = handlers?.onReady ?? (() => {});
    this.onExit = handlers?.onExit ?? (() => {});
    this.onError = handlers?.onError ?? (() => {});
    this.onMessage = handlers?.onMessage ?? (() => {});
    this.onConversation = handlers?.onConversation ?? (() => {});

    // 2. Create NDJSON parser
    const parser = new NdjsonParser({
      onParsed: (obj) => this.handleParsed(obj),
      onError: (_line, error) => {
        this.onError(new Error(`NDJSON parse error: ${error.message}`));
        this.destroy();
      },
    });

    // 3. Spawn process. Global flags (effort, model) precede the `app-server`
    // subcommand — codex does not accept them after.
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
      // Reject all pending requests on stdin failure
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(err);
        this.pendingRequests.delete(id);
      }
      this.busy = false;
      this.onError(err);
      this.destroy();
    });

    this.proc.on('exit', (code) => {
      unregister(this.instanceId);
      this.onExit(code);
    });

    this.proc.on('error', (err) => {
      this.onError(err);
      this.destroy();
    });

    // Self-register after spawn wiring is complete and before any user
    // callback can fire. Placing this after spawn ensures a failing spawn
    // (synchronous throw) never leaks an entry.
    register({
      instance: this,
      provider: 'codex',
      cwd,
      createdAt: new Date(),
      meta: undefined,
    });

    // 4. Start initialization sequence
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Step 1: Send initialize
      await this.sendJsonRpcRequest('initialize', {
        clientInfo: { name: 'daphnis', title: 'Daphnis', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });

      // Step 2: Send thread/start or thread/resume
      const threadMethod = this.resumeSessionId ? 'thread/resume' : 'thread/start';
      const threadParams = this.resumeSessionId ? { threadId: this.resumeSessionId } : {};
      const threadResult = await this.sendJsonRpcRequest(threadMethod, threadParams) as
        { thread: { id: string } };
      this.threadId = threadResult.thread.id;
      this.ready = true;
      this.onReady();
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      this.destroy();
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

    // JSON-RPC response (has id + result/error, no method)
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

    // Server-initiated request (has method + id, no result/error)
    if (hasMethod && hasId && !hasResult && !hasError) {
      this.handleServerRequest(msg['method'] as string, msg['id'] as number, msg['params']);
      return;
    }

    // Notification (has method, no id)
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
        // Schema: PermissionsRequestApprovalResponse from codex app-server protocol.
        // fileSystem.read/write are path arrays (null = not granted, [] would be empty grant).
        // We grant the cwd as read+write scope. network.enabled: true. macos: all sub-permissions.
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
        // Fail-closed: unknown request types get JSON-RPC error
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
        // No-op
        break;

      case 'item/agentMessage/delta': {
        const delta = (p?.['delta'] as string) ?? '';
        this.turnBuffer += delta;
        break;
      }

      case 'turn/completed': {
        const turn = p?.['turn'] as Record<string, unknown> | undefined;
        const status = turn?.['status'] as string | undefined;

        // Reset busy BEFORE callbacks — callbacks may synchronously call
        // sendMessage (e.g. marker retry), which would fail with "Already
        // processing" if busy is still true.
        const completedContent = this.turnBuffer;
        this.turnBuffer = '';
        this.busy = false;

        if (status === 'completed') {
          const assistantTurn: ConversationTurn = {
            role: 'assistant',
            content: completedContent,
            timestamp: new Date(),
          };
          this.history.push(assistantTurn);
          this.onConversation(assistantTurn);
          this.onMessage(assistantTurn.content);
        } else {
          this.onError(new Error(`Turn failed with status: ${status ?? 'unknown'}`));
        }
        break;
      }

      default:
        // Forward compatibility — ignore unknown notifications
        break;
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.ready) {
      this.onError(new Error('Not ready'));
      return;
    }
    if (this.busy) {
      this.onError(new Error('Already processing'));
      return;
    }
    if (this.destroyed) {
      this.onError(new Error('Destroyed'));
      return;
    }

    this.busy = true;
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
      await this.sendJsonRpcRequest('turn/start', turnParams);

      const userTurn: ConversationTurn = {
        role: 'user',
        content: text,
        timestamp: new Date(),
      };
      this.history.push(userTurn);
      this.onConversation(userTurn);
    } catch (err) {
      this.busy = false;
      this.onError(err instanceof Error ? err : new Error(String(err)));
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

  destroy(): void {
    if (this.destroyed) return;
    unregister(this.instanceId);
    this.destroyed = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Destroyed'));
      this.pendingRequests.delete(id);
    }

    this.turnBuffer = '';

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
  }
}
