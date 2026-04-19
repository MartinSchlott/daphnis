import type { AIConversationInstance, AIConversationOptions } from './types.js';
import { ClaudeCLIWrapper } from './claude-cli-wrapper.js';
import { CodexCLIWrapper } from './codex-cli-wrapper.js';

export function createAIConversation(options: AIConversationOptions): AIConversationInstance {
  const binary = options.binary ?? (options.provider === 'claude' ? 'claude' : 'codex');
  switch (options.provider) {
    case 'claude':
      return new ClaudeCLIWrapper(
        binary, options.cwd, options.handlers, options.systemPrompt,
        options.sessionId, options.effort, options.model, options.env,
      );
    case 'codex':
      return new CodexCLIWrapper(
        binary, options.cwd, options.handlers, options.systemPrompt, options.clientInfo,
        options.sessionId, options.effort, options.model, options.env,
      );
    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
