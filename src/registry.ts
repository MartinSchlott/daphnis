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

const entries = new Map<string, RegistryEntry>();

export function register(entry: RegistryEntry): void {
  entries.set(entry.instance.getInstanceId(), entry);
}

export function unregister(id: string): void {
  entries.delete(id);
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
  for (const entry of entries.values()) {
    result.push({
      id: entry.instance.getInstanceId(),
      provider: entry.provider,
      cwd: entry.cwd,
      sessionId: entry.instance.getSessionId(),
      pid: entry.instance.getPid(),
      createdAt: entry.createdAt,
      meta: entry.meta,
    });
  }
  return result;
}

export function getInstance(id: string): AIConversationInstance | undefined {
  return entries.get(id)?.instance;
}

/** Test-only. Not exported from the public API. */
export function __resetForTests(): void {
  entries.clear();
}
