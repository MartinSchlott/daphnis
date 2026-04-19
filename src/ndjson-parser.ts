export interface NdjsonCallbacks {
  onParsed: (obj: unknown) => void;
  onError: (line: string, error: Error) => void;
}

export class NdjsonParser {
  private buffer = '';
  private callbacks: NdjsonCallbacks;

  constructor(callbacks: NdjsonCallbacks) {
    this.callbacks = callbacks;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep incomplete trailing line in buffer
    this.buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      try {
        const obj: unknown = JSON.parse(trimmed);
        this.callbacks.onParsed(obj);
      } catch (err) {
        this.callbacks.onError(trimmed, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
