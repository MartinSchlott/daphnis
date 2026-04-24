import { describe, it, expect, afterEach } from 'vitest';
import type { AIConversationInstance } from '../types.js';
import {
  register,
  unregister,
  setMetaFor,
  getMetaFor,
  listInstances,
  getInstance,
  __resetForTests,
} from '../registry.js';

interface FakeOverrides {
  id?: string;
  sessionId?: string | null;
  pid?: number;
}

function makeFake(overrides: FakeOverrides = {}): AIConversationInstance {
  const id = overrides.id ?? 'fake-id';
  const sessionId = overrides.sessionId ?? null;
  const pid = overrides.pid ?? 42;
  return {
    onReady: () => {},
    onExit: () => {},
    onError: () => {},
    destroy: () => {},
    sendMessage: () => {},
    onMessage: () => {},
    onConversation: () => {},
    getTranscript: async () => [],
    getSessionId: () => sessionId,
    getPid: () => pid,
    getInstanceId: () => id,
    setMeta: () => {},
    getMeta: () => undefined,
  };
}

describe('registry', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('listInstances returns empty array initially', () => {
    expect(listInstances()).toEqual([]);
    expect(getInstance('anything')).toBeUndefined();
  });

  it('register adds an entry visible via listInstances and getInstance', () => {
    const fake = makeFake({ id: 'a', sessionId: 'sess-1', pid: 111 });
    const createdAt = new Date('2025-01-01T00:00:00Z');

    register({ instance: fake, provider: 'claude', cwd: '/tmp', createdAt, meta: undefined });

    const list = listInstances();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: 'a',
      provider: 'claude',
      cwd: '/tmp',
      sessionId: 'sess-1',
      pid: 111,
      createdAt,
      meta: undefined,
    });
    expect(getInstance('a')).toBe(fake);
  });

  it('setMetaFor updates the meta slot visible in DTO and getMetaFor', () => {
    const fake = makeFake({ id: 'b' });
    register({ instance: fake, provider: 'codex', cwd: '/w', createdAt: new Date(), meta: undefined });

    setMetaFor('b', { foo: 42 });
    expect(getMetaFor('b')).toEqual({ foo: 42 });
    expect(listInstances()[0].meta).toEqual({ foo: 42 });
  });

  it('setMetaFor overwrites on second call (does not merge)', () => {
    const fake = makeFake({ id: 'c' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

    setMetaFor('c', { a: 1 });
    setMetaFor('c', { b: 2 });
    expect(getMetaFor('c')).toEqual({ b: 2 });
  });

  it('unregister removes the entry and is idempotent', () => {
    const fake = makeFake({ id: 'd' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

    unregister('d');
    expect(getInstance('d')).toBeUndefined();
    expect(listInstances()).toHaveLength(0);

    // Second call is a no-op
    unregister('d');
    expect(listInstances()).toHaveLength(0);
  });

  it('listInstances returns a fresh array on each call', () => {
    const fake = makeFake({ id: 'e' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

    const list1 = listInstances();
    list1.pop();

    const list2 = listInstances();
    expect(list2).toHaveLength(1);
  });

  it('unknown id: getInstance and getMetaFor return undefined, setMetaFor is a silent no-op', () => {
    expect(getInstance('nope')).toBeUndefined();
    expect(getMetaFor('nope')).toBeUndefined();
    expect(() => setMetaFor('nope', { any: 'thing' })).not.toThrow();
    expect(getMetaFor('nope')).toBeUndefined();
  });
});
