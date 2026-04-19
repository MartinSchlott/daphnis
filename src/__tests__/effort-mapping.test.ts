import { describe, it, expect } from 'vitest';
import { effortToClaudeFlag, effortToCodexValue } from '../effort-mapping.js';
import type { Effort } from '../types.js';

describe('effortToClaudeFlag', () => {
  const cases: Array<[Effort, string | null]> = [
    ['default', null],
    ['min',     'low'],
    ['low',     'low'],
    ['medium',  'medium'],
    ['high',    'high'],
    ['xhigh',   'xhigh'],
    ['max',     'max'],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${input} → ${expected}`, () => {
      expect(effortToClaudeFlag(input)).toBe(expected);
    });
  }
});

describe('effortToCodexValue', () => {
  const cases: Array<[Effort, string | null]> = [
    ['default', null],
    ['min',     'minimal'],
    ['low',     'low'],
    ['medium',  'medium'],
    ['high',    'high'],
    ['xhigh',   'xhigh'],
    ['max',     'xhigh'],
  ];

  for (const [input, expected] of cases) {
    it(`maps ${input} → ${expected}`, () => {
      expect(effortToCodexValue(input)).toBe(expected);
    });
  }
});
