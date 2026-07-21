import path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contextSource(runtimePolicy: unknown): string | undefined {
  if (!isRecord(runtimePolicy) || !isRecord(runtimePolicy.context)) {
    return undefined;
  }
  return typeof runtimePolicy.context.source === 'string'
    ? runtimePolicy.context.source
    : undefined;
}

/**
 * Claude Code resolves user memory from the operating-system home directory,
 * even when CLAUDE_CONFIG_DIR points at HappyClaw's per-session directory.
 * In managed mode, exclude those host instructions explicitly while keeping
 * the session's selected user-source Skills available.
 */
export function resolveManagedHostClaudeMdExcludes(options: {
  executionMode: 'host' | 'container';
  runtimePolicy?: unknown;
  externalClaudeDir?: string;
  homeDir?: string;
}): string[] {
  if (
    options.executionMode !== 'host' ||
    contextSource(options.runtimePolicy) === 'host_claude'
  ) {
    return [];
  }

  const roots = new Set<string>();
  const candidates = [
    options.homeDir ? path.join(options.homeDir, '.claude') : undefined,
    options.externalClaudeDir,
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    roots.add(path.normalize(candidate));
  }

  return [...roots].flatMap((root) => [
    path.join(root, 'CLAUDE.md'),
    path.join(root, 'rules', '**'),
  ]);
}
