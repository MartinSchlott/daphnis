import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AIConversationInstance } from '../types.js';
import {
  register,
  unregister,
  setMetaFor,
  getMetaFor,
  listInstances,
  getInstance,
  instanceEvents,
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
    interrupt: async () => {},
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

  describe('instance lifecycle events', () => {
    it("'instance:added' fires on register with the correct snapshot", () => {
      const listener = vi.fn();
      instanceEvents.on('instance:added', listener);

      const fake = makeFake({ id: 'a', sessionId: 'sess-1', pid: 111 });
      const createdAt = new Date('2025-01-01T00:00:00Z');
      register({ instance: fake, provider: 'claude', cwd: '/tmp', createdAt, meta: { tag: 't' } });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toEqual({
        id: 'a',
        provider: 'claude',
        cwd: '/tmp',
        sessionId: 'sess-1',
        pid: 111,
        createdAt,
        meta: { tag: 't' },
      });
    });

    it("'instance:removed' fires on unregister with the final snapshot (after meta mutation)", () => {
      const fake = makeFake({ id: 'b', sessionId: 'sess-b', pid: 222 });
      const createdAt = new Date('2025-02-02T00:00:00Z');
      register({ instance: fake, provider: 'codex', cwd: '/w', createdAt, meta: undefined });

      setMetaFor('b', { last: true });

      const listener = vi.fn();
      instanceEvents.on('instance:removed', listener);

      unregister('b');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toEqual({
        id: 'b',
        provider: 'codex',
        cwd: '/w',
        sessionId: 'sess-b',
        pid: 222,
        createdAt,
        meta: { last: true },
      });
    });

    it('unregister for an unknown id fires no event', () => {
      const listener = vi.fn();
      instanceEvents.on('instance:removed', listener);

      unregister('nope');

      expect(listener).not.toHaveBeenCalled();
    });

    it('second register for the same id fires no second added event', () => {
      const listener = vi.fn();
      instanceEvents.on('instance:added', listener);

      const fake = makeFake({ id: 'c' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      expect(listener).toHaveBeenCalledOnce();
    });

    it('second unregister for the same id fires no second removed event', () => {
      const fake = makeFake({ id: 'd' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      const listener = vi.fn();
      instanceEvents.on('instance:removed', listener);

      unregister('d');
      unregister('d');

      expect(listener).toHaveBeenCalledOnce();
    });

    it('multiple subscribers all receive the same event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      instanceEvents.on('instance:added', listener1);
      instanceEvents.on('instance:added', listener2);

      const fake = makeFake({ id: 'e' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
      expect(listener1.mock.calls[0][0]).toEqual(listener2.mock.calls[0][0]);
    });

    it('off() removes the subscriber', () => {
      const listener = vi.fn();
      instanceEvents.on('instance:added', listener);
      instanceEvents.off('instance:added', listener);

      const fake = makeFake({ id: 'f' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      expect(listener).not.toHaveBeenCalled();
    });

    it('snapshot stability: payload is a value, not a live view of the instance', () => {
      let session: string | null = 'initial';
      const fake: AIConversationInstance = {
        onReady: () => {},
        onExit: () => {},
        onError: () => {},
        destroy: () => {},
        sendMessage: () => {},
        onMessage: () => {},
        interrupt: async () => {},
        onConversation: () => {},
        getTranscript: async () => [],
        getSessionId: () => session,
        getPid: () => 99,
        getInstanceId: () => 'g',
        setMeta: () => {},
        getMeta: () => undefined,
      };

      let captured: { sessionId: string | null } | undefined;
      instanceEvents.on('instance:added', info => {
        captured = { sessionId: info.sessionId };
      });

      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      session = 'mutated';
      expect(captured?.sessionId).toBe('initial');
    });

    it('__resetForTests clears listeners', () => {
      const listener = vi.fn();
      instanceEvents.on('instance:added', listener);

      __resetForTests();

      const fake = makeFake({ id: 'h' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
