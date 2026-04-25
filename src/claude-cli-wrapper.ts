import { spawn, type ChildProcess } from 'node:child_process';
import type { AIConversationInstance, AIConversationHandlers, ConversationTurn, Effort } from './types.js';
import { NdjsonParser } from './ndjson-parser.js';
import { effortToClaudeFlag } from './effort-mapping.js';
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

export class ClaudeCLIWrapper implements AIConversationInstance {
  private proc: ChildProcess;
  private readonly cwd: string;
  private readonly instanceId: string;
  private sessionId: string | null = null;
  private readonly resumeSessionId: string | null;
  private history: ConversationTurn[] = [];
  private ready = false;
  private busy = false;
  private destroyed = false;
  private stderrBuffer = '';
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
    systemPrompt?: string, sessionId?: string, effort?: Effort, model?: string,
    envExtra?: Record<string, string>,
    fullAccess?: boolean, extraArgs?: string[],
  ) {
    this.cwd = cwd;
    this.instanceId = instanceId;
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

    // 3. Spawn process (after handlers are wired)
    // --print is required: stream-json formats only work in non-interactive mode.
    // The system/init event is emitted after the first user message is written to
    // stdin, so we set ready immediately after spawn and capture the session_id
    // asynchronously when the init event arrives.
    if (sessionId) {
      this.sessionId = sessionId;
    }

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (fullAccess === true) {
      args.push('--dangerously-skip-permissions');
    }
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    if (effort !== undefined) {
      const flag = effortToClaudeFlag(effort);
      if (flag !== null) args.push('--effort', flag);
    }
    if (model !== undefined) {
      args.push('--model', model);
    }
    if (extraArgs !== undefined && extraArgs.length > 0) {
      args.push(...extraArgs);
    }

    this.proc = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...filterEnv(), ...(envExtra ?? {}) },
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
    });

    this.proc.stdin!.on('error', (err) => {
      this.onError(err);
      this.destroy();
    });

    this.proc.on('exit', (code) => {
      if (this.busy) {
        const detail = this.stderrBuffer.trim();
        const message = detail
          ? `Process exited with code ${code}: ${detail}`
          : `Process exited with code ${code}`;
        this.busy = false;
        this.onError(new Error(message));
        this.destroy();
      }
      unregister(this.instanceId);
      this.onExit(code);
    });

    this.proc.on('error', (err) => {
      this.onError(err);
      this.destroy();
    });

    // Self-register after spawn wiring is complete and before any user
    // callback can fire (onReady at end of ctor). Placing this after spawn
    // ensures a failing spawn (synchronous throw) never leaks an entry.
    register({
      instance: this,
      provider: 'claude',
      cwd,
      createdAt: new Date(),
      meta: undefined,
    });

    // Ready immediately — the CLI is alive and accepts stdin. The system/init
    // event only arrives after the first user message, so we cannot wait for it.
    this.ready = true;
    this.onReady();
  }

  private handleParsed(obj: unknown): void {
    if (typeof obj !== 'object' || obj === null) return;
    const msg = obj as Record<string, unknown>;

    switch (msg['type']) {
      case 'system': {
        const subtype = (msg['subtype'] as string) ?? '';
        if (subtype === 'init') {
          // Capture session_id when it arrives (after first user message).
          // ready + onReady already fired in constructor.
          this.sessionId = (msg['session_id'] as string) ?? null;
        }
        break;
      }
      case 'result': {
        const isError = msg['is_error'] === true;
        const resultText = typeof msg['result'] === 'string' ? msg['result'] : '';

        // Reset busy BEFORE callbacks — callbacks may synchronously call
        // sendMessage (e.g. marker retry), which would fail with "Already
        // processing" if busy is still true.
        this.busy = false;

        if (isError) {
          this.onError(new Error(resultText));
        } else {
          const turn: ConversationTurn = {
            role: 'assistant',
            content: resultText,
            timestamp: new Date(),
          };
          this.history.push(turn);
          this.onConversation(turn);
          this.onMessage(turn.content);
        }
        break;
      }
      case 'assistant':
        // Intermediate verbose output — ignore in v1
        break;
      default:
        // Forward compatibility — ignore unknown types
        break;
    }
  }

  sendMessage(text: string): void {
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

    const message = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      session_id: this.sessionId,
      parent_tool_use_id: null,
    });

    this.busy = true;
    const ok = this.proc.stdin!.write(message + '\n', (err) => {
      if (err) {
        this.busy = false;
        this.onError(err);
        return;
      }
      const turn: ConversationTurn = {
        role: 'user',
        content: text,
        timestamp: new Date(),
      };
      this.history.push(turn);
      this.onConversation(turn);
    });
    if (!ok) {
      // Backpressure — the callback will still fire, so no action needed here.
      // The turn is only committed once the write callback confirms delivery.
    }
  }

  async getTranscript(): Promise<ConversationTurn[]> {
    if (!this.historyLoadPromise && this.resumeSessionId) {
      this.historyLoadPromise = loadSessionHistory('claude', this.resumeSessionId, this.cwd)
        .then((prior) => { this.history.unshift(...prior); });
    }
    if (this.historyLoadPromise) {
      await this.historyLoadPromise;
    }
    return [...this.history];
  }

  getSessionId(): string | null {
    return this.sessionId;
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
