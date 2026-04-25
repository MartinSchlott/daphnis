import { randomUUID } from 'node:crypto';
import type { AIConversationInstance, AIConversationOptions } from './types.js';
import { ClaudeCLIWrapper } from './claude-cli-wrapper.js';
import { CodexCLIWrapper } from './codex-cli-wrapper.js';

export function createAIConversation(options: AIConversationOptions): AIConversationInstance {
  const binary = options.binary ?? (options.provider === 'claude' ? 'claude' : 'codex');
  const id = randomUUID();
  switch (options.provider) {
    case 'claude':
      return new ClaudeCLIWrapper(
        binary, options.cwd, id, options.systemPrompt,
        options.sessionId, options.effort, options.model, options.env,
        options.fullAccess, options.extraArgs,
      );
    case 'codex':
      return new CodexCLIWrapper(
        binary, options.cwd, id, options.systemPrompt,
        options.sessionId, options.effort, options.model, options.env,
        options.fullAccess, options.extraArgs,
      );
    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
