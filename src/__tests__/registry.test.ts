import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AIConversationInstance, InstanceMessageEventMap } from '../types.js';
import {
  register,
  unregister,
  setMetaFor,
  getMetaFor,
  setExitCodeFor,
  getState,
  listInstances,
  getInstance,
  instanceEvents,
  transitionState,
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
  const emitter = new EventEmitter<InstanceMessageEventMap>();
  return Object.assign(emitter, {
    ready: Promise.resolve(),
    state: 'spawning' as const,
    sendMessage: async () => {},
    interrupt: async () => {},
    destroy: () => {},
    getTranscript: async () => [],
    getSessionId: () => sessionId,
    getPid: () => pid,
    getInstanceId: () => id,
    setMeta: () => {},
    getMeta: <T = unknown>() => undefined as T | undefined,
  }) as unknown as AIConversationInstance;
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
      state: 'spawning',
      exitCode: null,
    });
    expect(getInstance('a')).toBe(fake);
  });

  it('register initializes exitCode to null', () => {
    const fake = makeFake({ id: 'init-ec' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
    expect(listInstances()[0].exitCode).toBeNull();
  });

  it('setExitCodeFor updates exitCode visible on the next instance:removed snapshot', () => {
    const fake = makeFake({ id: 'ec' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
    transitionState('ec', 'exiting');
    setExitCodeFor('ec', 1);

    const removed = vi.fn();
    instanceEvents.on('instance:removed', removed);
    unregister('ec');

    expect(removed).toHaveBeenCalledOnce();
    expect(removed.mock.calls[0][0].exitCode).toBe(1);
  });

  it('setExitCodeFor on unknown id is a silent no-op', () => {
    expect(() => setExitCodeFor('nope', 0)).not.toThrow();
  });

  it('getState returns the current state for a known id', () => {
    const fake = makeFake({ id: 'gs' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
    expect(getState('gs')).toBe('spawning');
    transitionState('gs', 'ready');
    expect(getState('gs')).toBe('ready');
  });

  it("getState returns 'exiting' for an unknown id (terminal fallback)", () => {
    expect(getState('does-not-exist')).toBe('exiting');
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

  it("unregister throws when state is not 'exiting'", () => {
    const fake = makeFake({ id: 'd' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

    expect(() => unregister('d')).toThrow(/must be exiting/);
    // Entry still present
    expect(listInstances()).toHaveLength(1);
  });

  it("unregister succeeds and is idempotent once state is 'exiting'", () => {
    const fake = makeFake({ id: 'd2' });
    register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
    transitionState('d2', 'exiting');

    unregister('d2');
    expect(getInstance('d2')).toBeUndefined();
    expect(listInstances()).toHaveLength(0);

    // Second call (unknown id) is a silent no-op
    expect(() => unregister('d2')).not.toThrow();
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
        state: 'spawning',
        exitCode: null,
      });
    });

    it("'instance:removed' fires on unregister with the final snapshot (after meta mutation)", () => {
      const fake = makeFake({ id: 'b', sessionId: 'sess-b', pid: 222 });
      const createdAt = new Date('2025-02-02T00:00:00Z');
      register({ instance: fake, provider: 'codex', cwd: '/w', createdAt, meta: undefined });

      setMetaFor('b', { last: true });
      transitionState('b', 'exiting');

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
        state: 'exiting',
        exitCode: null,
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
      transitionState('d', 'exiting');

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
      const emitter = new EventEmitter<InstanceMessageEventMap>();
      const fake = Object.assign(emitter, {
        ready: Promise.resolve(),
        state: 'spawning' as const,
        sendMessage: async () => {},
        interrupt: async () => {},
        destroy: () => {},
        getTranscript: async () => [],
        getSessionId: () => session,
        getPid: () => 99,
        getInstanceId: () => 'g',
        setMeta: () => {},
        getMeta: <T = unknown>() => undefined as T | undefined,
      }) as unknown as AIConversationInstance;

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

    it("'instance:meta-changed' fires with (info, prev) carrying old and new meta", () => {
      const fake = makeFake({ id: 'm1', sessionId: 'sess-m', pid: 333 });
      const createdAt = new Date('2025-03-03T00:00:00Z');
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt, meta: { v: 1 } });

      const listener = vi.fn();
      instanceEvents.on('instance:meta-changed', listener);

      setMetaFor('m1', { v: 2 });

      expect(listener).toHaveBeenCalledOnce();
      const [info, prev] = listener.mock.calls[0];
      expect(info).toEqual({
        id: 'm1',
        provider: 'claude',
        cwd: '/w',
        sessionId: 'sess-m',
        pid: 333,
        createdAt,
        meta: { v: 2 },
        state: 'spawning',
        exitCode: null,
      });
      expect(prev).toEqual({ v: 1 });
    });

    it("'instance:meta-changed' fires on every call (no equality check)", () => {
      const fake = makeFake({ id: 'm2' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      const listener = vi.fn();
      instanceEvents.on('instance:meta-changed', listener);

      const same = { x: 1 };
      setMetaFor('m2', same);
      setMetaFor('m2', same);

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("'instance:meta-changed' does not fire for unknown id", () => {
      const listener = vi.fn();
      instanceEvents.on('instance:meta-changed', listener);

      setMetaFor('nope', { any: 'thing' });

      expect(listener).not.toHaveBeenCalled();
    });

    it("'instance:meta-changed' does not fire on initial register", () => {
      const listener = vi.fn();
      instanceEvents.on('instance:meta-changed', listener);

      const fake = makeFake({ id: 'm3' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: { initial: true } });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('state machine', () => {
    it("initial state on register is 'spawning'", () => {
      const added = vi.fn();
      instanceEvents.on('instance:added', added);

      const fake = makeFake({ id: 's1' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      expect(added).toHaveBeenCalledOnce();
      expect(added.mock.calls[0][0].state).toBe('spawning');
    });

    it("transitionState updates entry.state and emits 'instance:state-changed' with [info, prev, next]", () => {
      const fake = makeFake({ id: 's2' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      const listener = vi.fn();
      instanceEvents.on('instance:state-changed', listener);

      transitionState('s2', 'ready');

      expect(listener).toHaveBeenCalledOnce();
      const call = listener.mock.calls[0];
      expect(call).toHaveLength(3);
      const [info, prev, next] = call;
      expect(prev).toBe('spawning');
      expect(next).toBe('ready');
      expect(info.state).toBe('ready');
      expect(info.id).toBe('s2');
      expect(listInstances()[0].state).toBe('ready');
    });

    it("'spawning → ready' also emits 'instance:ready'", () => {
      const fake = makeFake({ id: 's3' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      const ready = vi.fn();
      const stateChanged = vi.fn();
      instanceEvents.on('instance:ready', ready);
      instanceEvents.on('instance:state-changed', stateChanged);

      transitionState('s3', 'ready');

      expect(stateChanged).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready.mock.calls[0][0].state).toBe('ready');
    });

    it("'busy → ready' does NOT emit 'instance:ready'", () => {
      const fake = makeFake({ id: 's4' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      const ready = vi.fn();
      instanceEvents.on('instance:ready', ready);

      transitionState('s4', 'ready');
      transitionState('s4', 'busy');
      transitionState('s4', 'ready');

      expect(ready).toHaveBeenCalledOnce();
    });

    it.each([
      ['spawning', 'busy'],
      ['ready', 'spawning'],
      ['busy', 'spawning'],
    ] as const)('illegal transition %s → %s throws and does not emit', (from, to) => {
      const fake = makeFake({ id: `il-${from}-${to}` });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });

      if (from === 'ready') {
        transitionState(`il-${from}-${to}`, 'ready');
      } else if (from === 'busy') {
        transitionState(`il-${from}-${to}`, 'ready');
        transitionState(`il-${from}-${to}`, 'busy');
      }

      const stateChanged = vi.fn();
      instanceEvents.on('instance:state-changed', stateChanged);

      expect(() => transitionState(`il-${from}-${to}`, to)).toThrow(/Illegal state transition/);
      expect(stateChanged).not.toHaveBeenCalled();
    });

    it.each([
      ['ready'],
      ['busy'],
      ['spawning'],
    ] as const)("transitions out of 'exiting' to %s throw", (target) => {
      const fake = makeFake({ id: `ex-${target}` });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
      transitionState(`ex-${target}`, 'exiting');

      const stateChanged = vi.fn();
      instanceEvents.on('instance:state-changed', stateChanged);

      expect(() => transitionState(`ex-${target}`, target)).toThrow(/Illegal state transition/);
      expect(stateChanged).not.toHaveBeenCalled();
    });

    it('same-state self-transition is a no-op (no event, no throw)', () => {
      const fake = makeFake({ id: 'self' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
      transitionState('self', 'ready');

      const stateChanged = vi.fn();
      instanceEvents.on('instance:state-changed', stateChanged);

      expect(() => transitionState('self', 'ready')).not.toThrow();
      expect(stateChanged).not.toHaveBeenCalled();
    });

    it('unknown id is a silent no-op (no throw, no event)', () => {
      const stateChanged = vi.fn();
      instanceEvents.on('instance:state-changed', stateChanged);

      expect(() => transitionState('does-not-exist', 'ready')).not.toThrow();
      expect(stateChanged).not.toHaveBeenCalled();
    });

    it("unregister payload reflects current state ('exiting' after a full lifecycle)", () => {
      const fake = makeFake({ id: 'lc' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
      transitionState('lc', 'ready');
      transitionState('lc', 'busy');
      transitionState('lc', 'exiting');

      const removed = vi.fn();
      instanceEvents.on('instance:removed', removed);

      unregister('lc');

      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].state).toBe('exiting');
    });

    it('InstanceInfo.state round-trips through listInstances()', () => {
      const fake = makeFake({ id: 'rt' });
      register({ instance: fake, provider: 'claude', cwd: '/w', createdAt: new Date(), meta: undefined });
      transitionState('rt', 'ready');

      expect(listInstances()[0].state).toBe('ready');
    });
  });
});
