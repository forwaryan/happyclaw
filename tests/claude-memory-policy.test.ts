import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolveManagedHostClaudeMdExcludes } from '../container/agent-runner/src/claude-memory-policy.js';

describe('managed host Claude memory policy', () => {
  test('excludes OS-home and configured host instructions in managed mode', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/Users/operator',
        externalClaudeDir: '/Volumes/config/claude',
      }),
    ).toEqual([
      path.join('/Users/operator/.claude', 'CLAUDE.md'),
      path.join('/Users/operator/.claude', 'rules', '**'),
      path.join('/Volumes/config/claude', 'CLAUDE.md'),
      path.join('/Volumes/config/claude', 'rules', '**'),
    ]);
  });

  test('treats a missing legacy context source as managed and deduplicates roots', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: {},
        homeDir: '/Users/operator',
        externalClaudeDir: '/Users/operator/.claude',
      }),
    ).toEqual([
      path.join('/Users/operator/.claude', 'CLAUDE.md'),
      path.join('/Users/operator/.claude', 'rules', '**'),
    ]);
  });

  test('preserves explicitly enabled host context and ignores container runs', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'host_claude' } },
        homeDir: '/Users/operator',
      }),
    ).toEqual([]);
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'container',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/home/node',
      }),
    ).toEqual([]);
  });
});
