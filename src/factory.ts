import { randomUUID } from 'node:crypto';
import type { AIConversationInstance, AIConversationOptions } from './types.js';
import { ClaudeCLIWrapper } from './claude-cli-wrapper.js';
import { CodexCLIWrapper } from './codex-cli-wrapper.js';
import { assertSupportedProvider } from './providers.js';

export function createAIConversation(options: AIConversationOptions): AIConversationInstance {
  assertSupportedProvider(options.provider);
  const binary = options.binary ?? options.provider;
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
      throw new Error(`Unknown provider: ${options.provider as string}`);
  }
}
