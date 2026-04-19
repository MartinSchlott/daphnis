import type { Effort } from './types.js';

export function effortToClaudeFlag(e: Effort): string | null {
  switch (e) {
    case 'default': return null;
    case 'min':     return 'low';
    case 'low':     return 'low';
    case 'medium':  return 'medium';
    case 'high':    return 'high';
    case 'xhigh':   return 'xhigh';
    case 'max':     return 'max';
  }
}

export function effortToCodexValue(e: Effort): string | null {
  switch (e) {
    case 'default': return null;
    case 'min':     return 'minimal';
    case 'low':     return 'low';
    case 'medium':  return 'medium';
    case 'high':    return 'high';
    case 'xhigh':   return 'xhigh';
    case 'max':     return 'xhigh';
  }
}
