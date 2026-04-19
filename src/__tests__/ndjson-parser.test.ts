import { describe, it, expect, vi } from 'vitest';
import { NdjsonParser } from '../ndjson-parser.js';

describe('NdjsonParser', () => {
  it('parses a complete line', () => {
    const onParsed = vi.fn();
    const onError = vi.fn();
    const parser = new NdjsonParser({ onParsed, onError });

    parser.feed('{"type":"test"}\n');

    expect(onParsed).toHaveBeenCalledOnce();
    expect(onParsed).toHaveBeenCalledWith({ type: 'test' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('buffers incomplete lines across chunks', () => {
    const onParsed = vi.fn();
    const onError = vi.fn();
    const parser = new NdjsonParser({ onParsed, onError });

    parser.feed('{"type":');
    expect(onParsed).not.toHaveBeenCalled();

    parser.feed('"test"}\n');
    expect(onParsed).toHaveBeenCalledOnce();
    expect(onParsed).toHaveBeenCalledWith({ type: 'test' });
  });

  it('handles multiple lines in one chunk', () => {
    const onParsed = vi.fn();
    const onError = vi.fn();
    const parser = new NdjsonParser({ onParsed, onError });

    parser.feed('{"a":1}\n{"b":2}\n{"c":3}\n');

    expect(onParsed).toHaveBeenCalledTimes(3);
    expect(onParsed).toHaveBeenNthCalledWith(1, { a: 1 });
    expect(onParsed).toHaveBeenNthCalledWith(2, { b: 2 });
    expect(onParsed).toHaveBeenNthCalledWith(3, { c: 3 });
  });

  it('calls onError for invalid JSON', () => {
    const onParsed = vi.fn();
    const onError = vi.fn();
    const parser = new NdjsonParser({ onParsed, onError });

    parser.feed('not-json\n');

    expect(onParsed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe('not-json');
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('skips empty lines', () => {
    const onParsed = vi.fn();
    const onError = vi.fn();
    const parser = new NdjsonParser({ onParsed, onError });

    parser.feed('\n\n{"ok":true}\n\n');

    expect(onParsed).toHaveBeenCalledOnce();
    expect(onParsed).toHaveBeenCalledWith({ ok: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it('handles trailing newline correctly', () => {
    const onParsed = vi.fn();
    const onError = vi.fn();
    const parser = new NdjsonParser({ onParsed, onError });

    parser.feed('{"a":1}\n');
    parser.feed('{"b":2}\n');

    expect(onParsed).toHaveBeenCalledTimes(2);
  });
});
