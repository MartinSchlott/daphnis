import { EventEmitter } from 'node:events';
import type { AIConversationInstance } from './types.js';

export interface InstanceInfo {
  id: string;
  provider: 'claude' | 'codex';
  cwd: string;
  sessionId: string | null;
  pid: number;
  createdAt: Date;
  meta: unknown;
}

export interface RegistryEntry {
  instance: AIConversationInstance;
  provider: 'claude' | 'codex';
  cwd: string;
  createdAt: Date;
  meta: unknown;
}

export interface InstanceEventMap {
  'instance:added': [info: InstanceInfo];
  'instance:removed': [info: InstanceInfo];
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
  };
}

export function register(entry: RegistryEntry): void {
  const id = entry.instance.getInstanceId();
  if (entries.has(id)) return;
  entries.set(id, entry);
  instanceEvents.emit('instance:added', buildInfo(entry));
}

export function unregister(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  const snapshot = buildInfo(entry);
  entries.delete(id);
  instanceEvents.emit('instance:removed', snapshot);
}

export function setMetaFor(id: string, value: unknown): void {
  const entry = entries.get(id);
  if (entry) entry.meta = value;
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
