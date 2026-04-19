import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises and os before importing
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock('node:fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

const { listSessions, loadSessionHistory } = await import('../sessions.js');

describe('listSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Claude sessions ---

  describe('claude', () => {
    it('encodes cwd by replacing / and spaces with -', async () => {
      // /home/testuser/projects/cortex → -home-testuser-projects-cortex
      mockReaddir.mockResolvedValue(['session-abc.jsonl']);
      mockStat.mockResolvedValue({ isFile: () => true, mtime: new Date('2026-01-15') });
      mockReadFile.mockResolvedValue(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-abc', timestamp: '2026-01-15T10:00:00Z' }) + '\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello AI' } }) + '\n',
      );

      const sessions = await listSessions('claude', '/home/testuser/projects/cortex');

      expect(mockReaddir).toHaveBeenCalledWith('/home/testuser/.claude/projects/-home-testuser-projects-cortex');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].provider).toBe('claude');
      expect(sessions[0].preview).toBe('Hello AI');
      expect(sessions[0].sessionId).toBe('session-abc');
    });

    it('uses file mtime as fallback timestamp', async () => {
      mockReaddir.mockResolvedValue(['no-ts.jsonl']);
      mockStat.mockResolvedValue({ isFile: () => true, mtime: new Date('2026-03-01') });
      mockReadFile.mockResolvedValue('{"type":"result","result":"hello"}\n');

      const sessions = await listSessions('claude', '/tmp/project');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].timestamp).toEqual(new Date('2026-03-01'));
    });

    it('skips non-jsonl files and directories', async () => {
      mockReaddir.mockResolvedValue(['session.jsonl', 'readme.txt', 'somedir.jsonl']);
      mockStat
        .mockResolvedValueOnce({ isFile: () => true, mtime: new Date() })  // session.jsonl isFile check
        .mockResolvedValueOnce({ isFile: () => true, mtime: new Date() })  // session.jsonl mtime fallback
        .mockResolvedValueOnce({ isFile: () => false, mtime: new Date() }) // somedir.jsonl isFile check → skip
      ;
      mockReadFile.mockResolvedValue('');

      const sessions = await listSessions('claude', '/tmp');

      expect(sessions).toHaveLength(1);
    });

    it('returns empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const sessions = await listSessions('claude', '/nonexistent');

      expect(sessions).toEqual([]);
    });

    it('skips files with malformed JSONL', async () => {
      mockReaddir.mockResolvedValue(['bad.jsonl']);
      mockStat.mockResolvedValue({ isFile: () => true, mtime: new Date('2026-01-01') });
      mockReadFile.mockResolvedValue('this is not json\n');

      const sessions = await listSessions('claude', '/tmp');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].preview).toBeNull();
    });
  });

  // --- Codex sessions ---

  describe('codex', () => {
    it('reads session_meta from payload and filters by cwd', async () => {
      mockReaddir.mockResolvedValue([
        '2026/01/15/rollout-123-thread-abc.jsonl',
        '2026/01/16/rollout-456-thread-def.jsonl',
      ]);

      // Real Codex format: session_meta has payload.id, payload.cwd, payload.timestamp
      // User messages are response_item with payload.role='user', payload.content[].text
      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({
            timestamp: '2026-01-15T10:00:00Z',
            type: 'session_meta',
            payload: { id: 'thread-abc', cwd: '/my/project', timestamp: '2026-01-15T10:00:00Z' },
          }) + '\n' +
          JSON.stringify({
            timestamp: '2026-01-15T10:01:00Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] },
          }) + '\n',
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            timestamp: '2026-01-16T10:00:00Z',
            type: 'session_meta',
            payload: { id: 'thread-def', cwd: '/other/project', timestamp: '2026-01-16T10:00:00Z' },
          }) + '\n',
        );

      const sessions = await listSessions('codex', '/my/project');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('thread-abc');
      expect(sessions[0].preview).toBe('Fix the bug');
    });

    it('extracts preview from event_msg user_message', async () => {
      mockReaddir.mockResolvedValue(['2026/04/08/rollout-test.jsonl']);

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          timestamp: '2026-04-08T09:00:00Z',
          type: 'session_meta',
          payload: { id: 'thread-evt', cwd: '/my/project', timestamp: '2026-04-08T09:00:00Z' },
        }) + '\n' +
        JSON.stringify({
          timestamp: '2026-04-08T09:01:00Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Hello from event' },
        }) + '\n',
      );

      const sessions = await listSessions('codex', '/my/project');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].preview).toBe('Hello from event');
    });

    it('returns empty when sessions dir does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const sessions = await listSessions('codex', '/tmp');

      expect(sessions).toEqual([]);
    });

    it('skips files with malformed JSONL gracefully', async () => {
      mockReaddir.mockResolvedValue(['2026/01/01/bad.jsonl']);
      mockReadFile.mockResolvedValue('not json at all\n');

      const sessions = await listSessions('codex', '/tmp');

      expect(sessions).toEqual([]);
    });
  });

  // --- loadSessionHistory ---

  describe('loadSessionHistory', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    describe('claude', () => {
      it('parses user string messages and assistant text blocks', async () => {
        const jsonl = [
          JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello AI' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'Hi there' }] } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'bash' }] } }),
          JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }),
          JSON.stringify({ type: 'progress', message: 'working...' }),
        ].join('\n');

        mockReadFile.mockResolvedValue(jsonl);

        const turns = await loadSessionHistory('claude', 'sess-1', '/my/project');

        expect(turns).toHaveLength(2);
        expect(turns[0].role).toBe('user');
        expect(turns[0].content).toBe('Hello AI');
        expect(turns[1].role).toBe('assistant');
        expect(turns[1].content).toBe('Hi there');
      });

      it('concatenates multiple text blocks in assistant message', async () => {
        const jsonl = JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: ' Part 2' }] },
        });

        mockReadFile.mockResolvedValue(jsonl);

        const turns = await loadSessionHistory('claude', 'sess-2', '/tmp');

        expect(turns).toHaveLength(1);
        expect(turns[0].content).toBe('Part 1 Part 2');
      });

      it('returns empty array on file not found', async () => {
        mockReadFile.mockRejectedValue(new Error('ENOENT'));

        const turns = await loadSessionHistory('claude', 'nonexistent', '/tmp');

        expect(turns).toEqual([]);
      });

      it('skips malformed lines gracefully', async () => {
        const jsonl = 'not json\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'Valid' } });

        mockReadFile.mockResolvedValue(jsonl);

        const turns = await loadSessionHistory('claude', 'sess-3', '/tmp');

        expect(turns).toHaveLength(1);
        expect(turns[0].content).toBe('Valid');
      });
    });

    describe('codex', () => {
      it('parses response_item user and assistant turns', async () => {
        const sessionMeta = JSON.stringify({
          type: 'session_meta',
          payload: { id: 'thread-abc', cwd: '/my/project', timestamp: '2026-01-01T00:00:00Z' },
        });
        const userItem = JSON.stringify({
          type: 'response_item',
          payload: { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        });
        const assistantItem = JSON.stringify({
          type: 'response_item',
          payload: { role: 'assistant', content: [{ type: 'output_text', text: 'World' }] },
        });
        const jsonl = [sessionMeta, userItem, assistantItem].join('\n');

        // findCodexSessionFile reads the dir and first lines to match sessionId
        mockReaddir.mockResolvedValue(['2026/01/01/rollout-thread-abc.jsonl']);
        // First readFile: findCodexSessionFile reads first lines via readFirstLines
        mockReadFile
          .mockResolvedValueOnce(sessionMeta + '\n')  // readFirstLines in findCodexSessionFile
          .mockResolvedValueOnce(jsonl);                // full file read in loadSessionHistory
        mockStat.mockResolvedValue({ isFile: () => true, mtime: new Date() });

        const turns = await loadSessionHistory('codex', 'thread-abc', '/my/project');

        expect(turns).toHaveLength(2);
        expect(turns[0].role).toBe('user');
        expect(turns[0].content).toBe('Hello');
        expect(turns[1].role).toBe('assistant');
        expect(turns[1].content).toBe('World');
      });

      it('returns empty array when session not found', async () => {
        mockReaddir.mockRejectedValue(new Error('ENOENT'));

        const turns = await loadSessionHistory('codex', 'nonexistent', '/tmp');

        expect(turns).toEqual([]);
      });
    });
  });

  // --- Sort order ---

  describe('sort order', () => {
    it('returns sessions sorted by timestamp descending (newest first)', async () => {
      mockReaddir.mockResolvedValue(['old.jsonl', 'new.jsonl']);
      mockStat
        .mockResolvedValueOnce({ isFile: () => true, mtime: new Date('2026-01-01') })
        .mockResolvedValueOnce({ isFile: () => true, mtime: new Date('2026-01-01') })
        .mockResolvedValueOnce({ isFile: () => true, mtime: new Date('2026-06-01') })
        .mockResolvedValueOnce({ isFile: () => true, mtime: new Date('2026-06-01') });

      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({ type: 'system', subtype: 'init', timestamp: '2026-01-01T00:00:00Z' }) + '\n',
        )
        .mockResolvedValueOnce(
          JSON.stringify({ type: 'system', subtype: 'init', timestamp: '2026-06-01T00:00:00Z' }) + '\n',
        );

      const sessions = await listSessions('claude', '/tmp');

      expect(sessions).toHaveLength(2);
      expect(sessions[0].timestamp.getTime()).toBeGreaterThan(sessions[1].timestamp.getTime());
    });
  });
});
