import fs from 'node:fs';
import path from 'node:path';

export type McpServerMap = Record<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read only the MCP declaration from a Claude settings/.mcp.json file. */
export function readMcpServersFile(filePath: string): McpServerMap {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
    return Object.fromEntries(
      Object.entries(parsed.mcpServers).filter(
        ([name, server]) => name.trim().length > 0 && isRecord(server),
      ),
    ) as McpServerMap;
  } catch {
    return {};
  }
}

/**
 * Claude-native MCP is project/host context, not a HappyClaw-managed user MCP
 * grant.  Materialize it explicitly so strict Agent MCP filtering cannot hide
 * it (and cannot accidentally re-enable unselected HappyClaw user servers).
 * Later/more-local sources win, matching Claude settings precedence.
 */
export function loadClaudeContextMcpServers(options: {
  workspaceDir: string;
  externalClaudeDir?: string;
  includeHostClaudeContext?: boolean;
}): McpServerMap {
  const hostSettings =
    options.includeHostClaudeContext && options.externalClaudeDir
      ? readMcpServersFile(
          path.join(options.externalClaudeDir, 'settings.json'),
        )
      : {};
  // Claude Code persists user-scoped `claude mcp add --scope user` entries in
  // ~/.claude.json, next to ~/.claude/.  Include that source only for the
  // administrator-authorized host context; container-only users never see it.
  const hostGlobalConfig =
    options.includeHostClaudeContext && options.externalClaudeDir
      ? readMcpServersFile(
          path.join(path.dirname(options.externalClaudeDir), '.claude.json'),
        )
      : {};
  const projectFile = readMcpServersFile(
    path.join(options.workspaceDir, '.mcp.json'),
  );
  const projectSettings = readMcpServersFile(
    path.join(options.workspaceDir, '.claude', 'settings.json'),
  );
  const projectLocalSettings = readMcpServersFile(
    path.join(options.workspaceDir, '.claude', 'settings.local.json'),
  );
  return {
    ...hostSettings,
    ...hostGlobalConfig,
    ...projectFile,
    ...projectSettings,
    ...projectLocalSettings,
  };
}

/** HappyClaw-managed MCP is an additive final layer. */
export function mergeMcpServerLayers(
  contextServers: McpServerMap,
  managedUserServers: McpServerMap,
): McpServerMap {
  return { ...contextServers, ...managedUserServers };
}
