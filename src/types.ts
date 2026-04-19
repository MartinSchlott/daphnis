export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface AIConversationHandlers {
  onReady?: () => void;
  onMessage?: (text: string) => void;
  onConversation?: (turn: ConversationTurn) => void;
  onError?: (error: Error) => void;
  onExit?: (exitCode: number | null) => void;
}

export interface AIConversationInstance {
  // Lifecycle
  onReady: () => void;
  onExit: (exitCode: number | null) => void;
  onError: (error: Error) => void;
  destroy: () => void;

  // Communication
  sendMessage: (text: string) => void;
  onMessage: (text: string) => void;

  // History
  onConversation: (turn: ConversationTurn) => void;
  getTranscript: () => Promise<ConversationTurn[]>;

  // Session identity
  getSessionId: () => string | null;

  // Process identity
  getPid: () => number;
}

/**
 * Provider-agnostic reasoning effort level. `min`/`max` map silently to the
 * nearest supported gear per provider; `default` omits the flag and the CLI
 * decides.
 */
export type Effort = 'default' | 'min' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AIConversationOptions {
  provider: 'claude' | 'codex';
  cwd: string;
  handlers?: AIConversationHandlers;
  /** Path to the provider binary. Defaults to 'claude' or 'codex' (resolved via PATH). */
  binary?: string;
  /** System prompt / developer instructions passed to the AI agent. */
  systemPrompt?: string;
  /** Client identity for the Codex JSON-RPC handshake. Ignored for Claude. */
  clientInfo?: { name: string; title?: string; version: string };
  /** Session ID from a previous conversation. When provided, the CLI resumes that session. */
  sessionId?: string;
  /** Reasoning effort. Defaults to `'default'` (no flag passed; CLI decides). */
  effort?: Effort;
  /** Optional model identifier; passed to the CLI unchanged. No validation. */
  model?: string;
  /** Extra env vars merged into the child process env at spawn. */
  env?: Record<string, string>;
}
