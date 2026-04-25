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

  // Registry identity & metadata
  getInstanceId: () => string;
  setMeta: (value: unknown) => void;
  /** Unchecked cast — the registry stores meta as `unknown`. */
  getMeta: <T = unknown>() => T | undefined;
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
  /** Session ID from a previous conversation. When provided, the CLI resumes that session. */
  sessionId?: string;
  /** Reasoning effort. Defaults to `'default'` (no flag passed; CLI decides). */
  effort?: Effort;
  /** Optional model identifier; passed to the CLI unchanged. No validation. */
  model?: string;
  /** Extra env vars merged into the child process env at spawn. */
  env?: Record<string, string>;
  /**
   * Permit unsandboxed execution. When `true`, Daphnis appends the provider's
   * full-access bypass flag — Claude: `--dangerously-skip-permissions`,
   * Codex: `--dangerously-bypass-approvals-and-sandbox`. When `false`
   * (default), no sandbox/permission flag is added; caller env and CLI
   * config decide. Note: Claude in non-interactive stream-json mode will
   * block on tool calls without a permission flag — set `fullAccess: true`
   * or supply `--permission-mode` via `extraArgs`.
   */
  fullAccess?: boolean;
  /**
   * Extra CLI arguments appended verbatim after Daphnis-managed args. No
   * validation. Provider-specific flags (e.g. `--permission-mode` for
   * Claude, `--sandbox` for Codex) are caller's responsibility. For Codex,
   * `extraArgs` lands in the global flag position, before the `app-server`
   * / `exec` subcommand.
   */
  extraArgs?: string[];
}
