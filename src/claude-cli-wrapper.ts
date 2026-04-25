import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AIConversationInstance, ConversationTurn, Effort, InstanceMessageEventMap } from './types.js';
import { NdjsonParser } from './ndjson-parser.js';
import { effortToClaudeFlag } from './effort-mapping.js';
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

export class ClaudeCLIWrapper
  extends EventEmitter<InstanceMessageEventMap>
  implements AIConversationInstance
{
  private proc: ChildProcess;
  private readonly cwd: string;
  private readonly instanceId: string;
  private sessionId: string | null = null;
  private readonly resumeSessionId: string | null;
  private history: ConversationTurn[] = [];
  private stderrBuffer = '';
  private historyLoadPromise: Promise<void> | null = null;
  private pendingControlRequests = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
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
    systemPrompt?: string, sessionId?: string, effort?: Effort, model?: string,
    envExtra?: Record<string, string>,
    fullAccess?: boolean, extraArgs?: string[],
  ) {
    super();
    this.cwd = cwd;
    this.instanceId = instanceId;
    this.resumeSessionId = sessionId ?? null;

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Swallow unhandled-rejection if no one awaits ready.
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
      this.rejectPendingControl(err);
      this.failPendingInterrupt(err);
      const cur = getState(this.instanceId);
      if (cur === 'spawning') {
        this.rejectReady(err);
      } else {
        this.safeEmitError(err);
      }
      // destroy() handles transition→exiting and the SIGKILL timer in every
      // branch — including spawning, where leaving the child alive would
      // orphan the process.
      this.destroy();
      // 'exit' may not fire after 'error' (Node docs); self-unregister.
      unregister(this.instanceId);
    });

    this.proc.on('exit', (code) => {
      const detail = this.stderrBuffer.trim();
      const exitMessage = detail
        ? `Process exited with code ${code}: ${detail}`
        : `Process exited with code ${code}`;
      const exitError = new Error(exitMessage);

      this.rejectPendingControl(exitError);
      this.failPendingInterrupt(exitError);

      const cur = getState(this.instanceId);
      if (cur === 'spawning') {
        this.rejectReady(exitError);
      } else if (cur === 'busy') {
        this.safeEmitError(exitError);
      }
      if (cur !== 'exiting') {
        transitionState(this.instanceId, 'exiting');
      }
      setExitCodeFor(this.instanceId, code);
      unregister(this.instanceId);
    });

    this.proc.on('error', (err) => {
      this.rejectPendingControl(err);
      this.failPendingInterrupt(err);
      const cur = getState(this.instanceId);
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
      provider: 'claude',
      cwd,
      createdAt: new Date(),
      meta: undefined,
    });

    // Defer ready transition past nextTick + microtasks so that any
    // process.nextTick-emitted spawn 'error' (e.g. ENOENT) wins the race
    // and rejects ready before this transition can fire.
    setImmediate(() => {
      if (getState(this.instanceId) === 'spawning') {
        transitionState(this.instanceId, 'ready');
        this.resolveReady();
      }
    });
  }

  private safeEmitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  private handleParsed(obj: unknown): void {
    if (typeof obj !== 'object' || obj === null) return;
    const msg = obj as Record<string, unknown>;

    if (msg['type'] === 'control_response') {
      const response = msg['response'] as Record<string, unknown> | undefined;
      const requestId = response?.['request_id'] as string | undefined;
      if (!requestId) return;
      const pending = this.pendingControlRequests.get(requestId);
      if (!pending) return;
      this.pendingControlRequests.delete(requestId);
      if (response?.['subtype'] === 'success') {
        pending.resolve();
      } else {
        const errMsg = (response?.['error'] as string) ?? 'control_request failed';
        pending.reject(new Error(errMsg));
      }
      return;
    }

    switch (msg['type']) {
      case 'system': {
        const subtype = (msg['subtype'] as string) ?? '';
        if (subtype === 'init') {
          this.sessionId = (msg['session_id'] as string) ?? null;
        }
        break;
      }
      case 'result': {
        // Late terminator after teardown (destroy, exit, error path):
        // state is 'exiting' (or unknown id → terminal fallback). Drop
        // the result silently — transitioning to 'ready' would be illegal,
        // and emitting on a torn-down wrapper is a contract violation.
        if (getState(this.instanceId) !== 'busy') return;

        const isError = msg['is_error'] === true;
        const subtype = msg['subtype'] as string | undefined;
        const resultText = typeof msg['result'] === 'string' ? msg['result'] : '';
        const isInterruptTerminator = isError && subtype === 'error_during_execution';

        // Reset state BEFORE callbacks — listeners may synchronously call
        // sendMessage, which would fail with "Already processing" if state
        // is still busy.
        transitionState(this.instanceId, 'ready');

        if (this.interrupting) {
          this.interrupting = false;
          const resolveBusy = this.busyClearedResolve;
          const rejectBusy = this.busyClearedReject;
          this.busyClearedResolve = null;
          this.busyClearedReject = null;

          if (isInterruptTerminator) {
            resolveBusy?.();
            return;
          }
          if (isError) {
            const err = new Error(resultText);
            rejectBusy?.(err);
            this.safeEmitError(err);
            return;
          }
          // Natural completion race: turn finished before the cancel landed.
          resolveBusy?.();
          const turn: ConversationTurn = {
            role: 'assistant',
            content: resultText,
            timestamp: new Date(),
          };
          this.history.push(turn);
          this.emit('conversation', turn);
          this.emit('message', turn.content);
          return;
        }

        if (isError) {
          this.safeEmitError(new Error(resultText));
        } else {
          const turn: ConversationTurn = {
            role: 'assistant',
            content: resultText,
            timestamp: new Date(),
          };
          this.history.push(turn);
          this.emit('conversation', turn);
          this.emit('message', turn.content);
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

  private rejectPendingControl(err: Error): void {
    for (const [, pending] of this.pendingControlRequests) {
      pending.reject(err);
    }
    this.pendingControlRequests.clear();
  }

  private failPendingInterrupt(err: Error): void {
    if (this.busyClearedReject) {
      this.busyClearedReject(err);
    }
    this.busyClearedResolve = null;
    this.busyClearedReject = null;
    this.interrupting = false;
  }

  async sendMessage(text: string): Promise<void> {
    const cur = getState(this.instanceId);
    // Order matters: 'exiting' first so a destroyed-while-busy wrapper
    // reports 'Destroyed', not 'Already processing'.
    if (cur === 'exiting') throw new Error('Destroyed');
    if (cur === 'busy') throw new Error('Already processing');
    if (cur !== 'ready') throw new Error('Not ready');

    const message = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      session_id: this.sessionId,
      parent_tool_use_id: null,
    });

    transitionState(this.instanceId, 'busy');
    return new Promise<void>((resolve, reject) => {
      this.proc.stdin!.write(message + '\n', (err) => {
        if (err) {
          if (getState(this.instanceId) === 'busy') {
            transitionState(this.instanceId, 'ready');
          }
          reject(err);
          return;
        }
        const turn: ConversationTurn = {
          role: 'user',
          content: text,
          timestamp: new Date(),
        };
        this.history.push(turn);
        this.emit('conversation', turn);
        resolve();
      });
    });
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

  async interrupt(): Promise<void> {
    const cur = getState(this.instanceId);
    if (cur === 'exiting') throw new Error('Destroyed');
    if (cur !== 'busy') throw new Error('Not busy');
    if (this.interrupting) throw new Error('Interrupt already in progress');
    this.interrupting = true;

    const requestId = randomUUID();
    const message = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    });

    const ack = new Promise<void>((resolve, reject) => {
      this.pendingControlRequests.set(requestId, { resolve, reject });
    });

    const busyCleared = new Promise<void>((resolve, reject) => {
      this.busyClearedResolve = resolve;
      this.busyClearedReject = reject;
    });

    try {
      this.proc.stdin!.write(message + '\n');
      await Promise.all([ack, busyCleared]);
    } catch (err) {
      this.interrupting = false;
      throw err;
    } finally {
      this.busyClearedResolve = null;
      this.busyClearedReject = null;
    }
  }

  destroy(): void {
    const cur = getState(this.instanceId);
    if (cur === 'exiting') return;
    transitionState(this.instanceId, 'exiting');

    const destroyedErr = new Error('Destroyed');
    this.rejectPendingControl(destroyedErr);
    this.failPendingInterrupt(destroyedErr);
    if (cur === 'spawning') this.rejectReady(destroyedErr);

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
