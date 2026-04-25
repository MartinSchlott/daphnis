import { EventEmitter } from 'node:events';
import type { AIConversationInstance } from './types.js';

export type InstanceState = 'spawning' | 'ready' | 'busy' | 'exiting';

const LEGAL_TRANSITIONS: Record<InstanceState, ReadonlySet<InstanceState>> = {
  spawning: new Set(['ready', 'exiting']),
  ready:    new Set(['busy', 'exiting']),
  busy:     new Set(['ready', 'exiting']),
  exiting:  new Set(),
};

export interface InstanceInfo {
  id: string;
  provider: 'claude' | 'codex';
  cwd: string;
  sessionId: string | null;
  pid: number;
  createdAt: Date;
  meta: unknown;
  state: InstanceState;
  exitCode: number | null;
}

export interface RegistryEntry {
  instance: AIConversationInstance;
  provider: 'claude' | 'codex';
  cwd: string;
  createdAt: Date;
  meta: unknown;
  state: InstanceState;
  exitCode: number | null;
}

export interface InstanceEventMap {
  'instance:added': [info: InstanceInfo];
  'instance:removed': [info: InstanceInfo];
  'instance:ready': [info: InstanceInfo];
  'instance:meta-changed': [info: InstanceInfo, prev: unknown];
  'instance:state-changed': [info: InstanceInfo, prev: InstanceState, next: InstanceState];
}

export const instanceEvents = new EventEmitter<InstanceEventMap>();

const entries = new Map<string, RegistryEntry>();

function buildInfo(entry: RegistryEntry): InstanceInfo {
  return {
    id: entry.instance.getInstanceId(),
    provider: entry.provider,
    cwd: entry.cwd,
    sessionId: entry.instance.getSessionId(),
    pid: entry.instance.getPid(),
    createdAt: entry.createdAt,
    meta: entry.meta,
    state: entry.state,
    exitCode: entry.exitCode,
  };
}

export function register(entry: Omit<RegistryEntry, 'state' | 'exitCode'>): void {
  const id = entry.instance.getInstanceId();
  if (entries.has(id)) return;
  const full: RegistryEntry = { ...entry, state: 'spawning', exitCode: null };
  entries.set(id, full);
  instanceEvents.emit('instance:added', buildInfo(full));
}

export function unregister(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.state !== 'exiting') {
    throw new Error(`unregister called with state ${entry.state}; must be exiting`);
  }
  const snapshot = buildInfo(entry);
  entries.delete(id);
  instanceEvents.emit('instance:removed', snapshot);
}

export function setMetaFor(id: string, value: unknown): void {
  const entry = entries.get(id);
  if (!entry) return;
  const prev = entry.meta;
  entry.meta = value;
  instanceEvents.emit('instance:meta-changed', buildInfo(entry), prev);
}

export function setExitCodeFor(id: string, code: number | null): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.exitCode = code;
}

export function getState(id: string): InstanceState {
  const entry = entries.get(id);
  if (!entry) return 'exiting';
  return entry.state;
}

export function transitionState(id: string, next: InstanceState): void {
  const entry = entries.get(id);
  if (!entry) return;
  const prev = entry.state;
  if (prev === next) return;
  if (!LEGAL_TRANSITIONS[prev].has(next)) {
    throw new Error(`Illegal state transition: ${prev} → ${next}`);
  }
  entry.state = next;
  const info = buildInfo(entry);
  instanceEvents.emit('instance:state-changed', info, prev, next);
  if (prev === 'spawning' && next === 'ready') {
    instanceEvents.emit('instance:ready', info);
  }
}

export function getMetaFor(id: string): unknown {
  return entries.get(id)?.meta;
}

export function listInstances(): InstanceInfo[] {
  const result: InstanceInfo[] = [];
  for (const entry of entries.values()) result.push(buildInfo(entry));
  return result;
}

export function getInstance(id: string): AIConversationInstance | undefined {
  return entries.get(id)?.instance;
}

/** Test-only. Not exported from the public API. */
export function __resetForTests(): void {
  entries.clear();
  instanceEvents.removeAllListeners();
}
