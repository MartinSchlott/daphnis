import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { ConversationTurn } from './types.js';

export interface SessionInfo {
  sessionId: string;
  provider: 'claude' | 'codex';
  timestamp: Date;
  /** First user message as preview, if available */
  preview: string | null;
  /** Absolute path to the JSONL file */
  filePath: string;
}

/**
 * Encode a cwd path the same way Claude CLI does for its project directory name.
 * Observed format: `/home/ubuntu/projects/cortex` → `-home-ubuntu-projects-cortex`
 * Simply replaces `/` and spaces with `-`.
 */
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[/\s]/g, '-');
}

async function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  const content = await readFile(filePath, 'utf-8');
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < content.length && lines.length < maxLines; i++) {
    if (content[i] === '\n') {
      lines.push(content.slice(start, i));
      start = i + 1;
    }
  }
  if (start < content.length && lines.length < maxLines) {
    lines.push(content.slice(start));
  }
  return lines;
}

function extractPreviewFromLines(lines: string[], provider: 'claude' | 'codex'): { preview: string | null; timestamp: Date | null } {
  let preview: string | null = null;
  let timestamp: Date | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      if (provider === 'claude') {
        // Look for user message type
        if (obj['type'] === 'user') {
          const message = obj['message'] as Record<string, unknown> | undefined;
          const content = message?.['content'];
          if (typeof content === 'string') {
            preview = content.slice(0, 200);
          }
        }
        // Try to extract timestamp from system/init
        if (obj['type'] === 'system' && obj['subtype'] === 'init' && typeof obj['timestamp'] === 'string') {
          timestamp = new Date(obj['timestamp'] as string);
        }
      } else {
        // Codex: data is nested under `payload`
        const payload = obj['payload'] as Record<string, unknown> | undefined;

        // Timestamp from session_meta or top-level
        if (obj['type'] === 'session_meta') {
          const ts = (payload?.['timestamp'] as string) ?? (obj['timestamp'] as string);
          if (typeof ts === 'string') {
            timestamp = new Date(ts);
          }
        }

        // User message: response_item with payload.role === 'user'
        if (obj['type'] === 'response_item' && payload?.['role'] === 'user') {
          const contentArr = payload['content'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(contentArr)) {
            for (const item of contentArr) {
              if (item['type'] === 'input_text' && typeof item['text'] === 'string') {
                preview = (item['text'] as string).slice(0, 200);
                break;
              }
            }
          }
        }

        // Also try event_msg with payload.message (user_message events)
        if (!preview && obj['type'] === 'event_msg' && payload?.['type'] === 'user_message') {
          const message = payload['message'] as string | undefined;
          if (typeof message === 'string') {
            preview = message.slice(0, 200);
          }
        }
      }

      if (preview !== null) break;
    } catch {
      // Malformed line — skip
    }
  }

  return { preview, timestamp };
}

async function listClaudeSessions(cwd: string): Promise<SessionInfo[]> {
  const encoded = encodeClaudeCwd(cwd);
  const projectDir = join(homedir(), '.claude', 'projects', encoded);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;

    const filePath = join(projectDir, entry);

    // Verify it's a file (skip directories with same-ish names)
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }

    const sessionId = basename(entry, '.jsonl');

    let preview: string | null = null;
    let timestamp: Date | null = null;

    try {
      const lines = await readFirstLines(filePath, 20);
      const extracted = extractPreviewFromLines(lines, 'claude');
      preview = extracted.preview;
      timestamp = extracted.timestamp;
    } catch {
      // Can't read file — skip
    }

    if (!timestamp) {
      try {
        const st = await stat(filePath);
        timestamp = st.mtime;
      } catch {
        timestamp = new Date(0);
      }
    }

    sessions.push({
      sessionId,
      provider: 'claude',
      timestamp,
      preview,
      filePath,
    });
  }

  return sessions;
}

async function listCodexSessions(cwd: string): Promise<SessionInfo[]> {
  const sessionsDir = join(homedir(), '.codex', 'sessions');

  let allFiles: string[];
  try {
    allFiles = await readdir(sessionsDir, { recursive: true }) as unknown as string[];
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];

  for (const relativePath of allFiles) {
    if (!relativePath.endsWith('.jsonl')) continue;

    const filePath = join(sessionsDir, relativePath);

    try {
      const lines = await readFirstLines(filePath, 20);

      let sessionCwd: string | null = null;
      let sessionId: string | null = null;
      let timestamp: Date | null = null;

      // Parse session_meta from first line — real format nests data under `payload`
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj['type'] === 'session_meta') {
            const payload = obj['payload'] as Record<string, unknown> | undefined;
            sessionCwd = (payload?.['cwd'] as string) ?? null;
            sessionId = (payload?.['id'] as string) ?? null;
            const ts = (payload?.['timestamp'] as string) ?? (obj['timestamp'] as string);
            if (typeof ts === 'string') {
              timestamp = new Date(ts);
            }
            break;
          }
        } catch {
          // skip malformed
        }
      }

      // Filter by cwd
      if (sessionCwd !== cwd) continue;

      // Extract thread ID from filename as fallback
      if (!sessionId) {
        const fname = basename(relativePath, '.jsonl');
        const parts = fname.split('-');
        // Filename format: rollout-<timestamp>-<thread-id>
        // Thread ID is the last UUID segment
        if (parts.length >= 3) {
          sessionId = parts.slice(-5).join('-'); // UUID has 5 segments
        } else {
          sessionId = fname;
        }
      }

      if (!timestamp) {
        try {
          const st = await stat(filePath);
          timestamp = st.mtime;
        } catch {
          timestamp = new Date(0);
        }
      }

      const extracted = extractPreviewFromLines(lines, 'codex');

      sessions.push({
        sessionId: sessionId!,
        provider: 'codex',
        timestamp,
        preview: extracted.preview,
        filePath,
      });
    } catch {
      // Can't read file — skip
    }
  }

  return sessions;
}

export async function loadSessionHistory(
  provider: 'claude' | 'codex',
  sessionId: string,
  cwd: string,
): Promise<ConversationTurn[]> {
  try {
    if (provider === 'claude') {
      const encoded = encodeClaudeCwd(cwd);
      const filePath = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
      const content = await readFile(filePath, 'utf-8');
      return parseClaudeHistory(content);
    } else {
      // Codex: scan sessions dir for matching sessionId
      const sessionsDir = join(homedir(), '.codex', 'sessions');
      const filePath = await findCodexSessionFile(sessionsDir, sessionId);
      if (!filePath) return [];
      const content = await readFile(filePath, 'utf-8');
      return parseCodexHistory(content);
    }
  } catch {
    return [];
  }
}

function parseClaudeHistory(content: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj['type'] === 'user') {
        const message = obj['message'] as Record<string, unknown> | undefined;
        const msgContent = message?.['content'];
        if (typeof msgContent === 'string') {
          turns.push({ role: 'user', content: msgContent, timestamp: new Date() });
        }
        // list content (tool_result) → skip
      } else if (obj['type'] === 'assistant') {
        const message = obj['message'] as Record<string, unknown> | undefined;
        const contentArr = message?.['content'] as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(contentArr)) {
          const textParts: string[] = [];
          for (const item of contentArr) {
            if (item['type'] === 'text' && typeof item['text'] === 'string') {
              textParts.push(item['text'] as string);
            }
          }
          const combined = textParts.join('');
          if (combined) {
            turns.push({ role: 'assistant', content: combined, timestamp: new Date() });
          }
        }
      }
      // queue-operation, progress, system, result → skip
    } catch {
      // Malformed line — skip
    }
  }
  return turns;
}

function parseCodexHistory(content: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj['type'] === 'response_item') {
        const payload = obj['payload'] as Record<string, unknown> | undefined;
        const role = payload?.['role'] as string | undefined;
        if (role === 'user' || role === 'assistant') {
          const contentArr = payload?.['content'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(contentArr)) {
            const textParts: string[] = [];
            for (const item of contentArr) {
              if (typeof item['text'] === 'string') {
                textParts.push(item['text'] as string);
              }
            }
            const combined = textParts.join('');
            if (combined) {
              turns.push({ role: role as 'user' | 'assistant', content: combined, timestamp: new Date() });
            }
          }
        }
      }
    } catch {
      // Malformed line — skip
    }
  }
  return turns;
}

async function findCodexSessionFile(sessionsDir: string, sessionId: string): Promise<string | null> {
  let allFiles: string[];
  try {
    allFiles = await readdir(sessionsDir, { recursive: true }) as unknown as string[];
  } catch {
    return null;
  }

  for (const relativePath of allFiles) {
    if (!relativePath.endsWith('.jsonl')) continue;
    const filePath = join(sessionsDir, relativePath);
    try {
      const lines = await readFirstLines(filePath, 5);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj['type'] === 'session_meta') {
            const payload = obj['payload'] as Record<string, unknown> | undefined;
            if (payload?.['id'] === sessionId) return filePath;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return null;
}

export async function listSessions(
  provider: 'claude' | 'codex',
  cwd: string,
): Promise<SessionInfo[]> {
  const sessions = provider === 'claude'
    ? await listClaudeSessions(cwd)
    : await listCodexSessions(cwd);

  // Sort by timestamp descending (newest first)
  sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return sessions;
}
