export type AgentToolPolicyMode = 'inherit' | 'readonly' | 'restricted';
export type AgentMcpPolicyMode = 'inherit' | 'custom' | 'disabled';

export interface ResolvedAgentToolPolicy {
  mode: AgentToolPolicyMode;
  disallowedTools: string[];
  loadUserPlugins: boolean;
  includeUserMcpServers: boolean;
  strictMcpConfig: boolean;
  settingSources: Array<'project' | 'user'>;
  managedSettings?: {
    allowManagedHooksOnly: true;
  };
  disableSkillShellExecution: boolean;
  /** Explicit SDK builtin allowlist. Undefined preserves Claude Code defaults. */
  builtinTools?: string[];
  /** Exact HappyClaw MCP definitions to register. Undefined registers all. */
  allowedHappyclawTools?: string[];
}

const READONLY_DISALLOWED_BUILTINS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'TaskOutput',
  'TaskStop',
  'Agent',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
];

// Output tools are response channels rather than workspace/config mutation.
// The remaining allowlist is read-only. Every newly registered HappyClaw MCP
// tool is denied by default until it is explicitly classified here.
const READONLY_HAPPYCLAW_TOOLS = new Set([
  'send_message',
  'send_image',
  'send_file',
  'list_tasks',
  'discord_get_history',
  'discord_get_channel_info',
  'discord_get_server_info',
  'memory_search',
  'memory_get',
]);

export function parseAgentToolPolicyMode(
  raw: string | undefined,
): AgentToolPolicyMode {
  return raw === 'readonly' || raw === 'restricted' ? raw : 'inherit';
}

export function parseAgentMcpPolicyMode(
  raw: string | undefined,
): AgentMcpPolicyMode {
  return raw === 'custom' || raw === 'disabled' ? raw : 'inherit';
}

export function resolveAgentToolPolicy(
  mode: AgentToolPolicyMode,
  happyclawToolNames: string[],
  mcpMode: AgentMcpPolicyMode = 'inherit',
): ResolvedAgentToolPolicy {
  if (mode === 'inherit') {
    const exactUserMcpSet = mcpMode !== 'inherit';
    return {
      mode,
      disallowedTools: [],
      // Plugins may declare opaque MCP servers. An exact Agent MCP policy
      // therefore cannot safely load the plugin bundle as a side channel.
      loadUserPlugins: !exactUserMcpSet,
      // container-runner materializes Claude-native project/authorized-host
      // MCP plus the Agent-filtered HappyClaw user MCP into one trusted map.
      // Even `disabled` means "disable managed user MCP", not project context.
      includeUserMcpServers: true,
      // Keep project/user setting sources for context and managed Skills, but
      // ignore their MCP declarations. Selected user MCP is supplied through
      // options.mcpServers by the runner.
      strictMcpConfig: exactUserMcpSet,
      settingSources: ['project', 'user'],
      disableSkillShellExecution: false,
    };
  }

  const disallowedTools = new Set(READONLY_DISALLOWED_BUILTINS);
  if (mode === 'restricted') {
    disallowedTools.add('WebSearch');
    disallowedTools.add('WebFetch');
  }
  for (const toolName of happyclawToolNames) {
    const shortName = toolName.replace(/^mcp__happyclaw__/, '');
    if (!READONLY_HAPPYCLAW_TOOLS.has(shortName)) {
      disallowedTools.add(`mcp__happyclaw__${shortName}`);
    }
  }

  return {
    mode,
    disallowedTools: [...disallowedTools],
    // Plugins can contribute hooks and MCP tools whose write semantics cannot
    // be inferred safely, so policy modes do not load them.
    loadUserPlugins: false,
    // User MCP servers are likewise opaque. Read-only integrations should be
    // promoted to an explicitly classified built-in capability first.
    includeUserMcpServers: false,
    // Ignore project/user/plugin/agent MCP declarations. Only the explicitly
    // supplied in-process HappyClaw server remains reachable.
    strictMcpConfig: true,
    // Keep project/user sources so CLAUDE.md and selected skills still load,
    // but apply managed-tier locks to the executable settings surfaces that
    // bypass normal tool permissions.
    settingSources: ['project', 'user'],
    managedSettings: {
      allowManagedHooksOnly: true,
    },
    disableSkillShellExecution: true,
    builtinTools:
      mode === 'readonly'
        ? ['Read', 'Glob', 'Grep', 'Skill', 'WebSearch', 'WebFetch']
        : ['Read', 'Glob', 'Grep', 'Skill'],
    allowedHappyclawTools: happyclawToolNames
      .map((name) => name.replace(/^mcp__happyclaw__/, ''))
      .filter((name) => READONLY_HAPPYCLAW_TOOLS.has(name)),
  };
}

export function getAgentToolPolicyFlagSettings(
  policy: ResolvedAgentToolPolicy,
): Record<string, unknown> {
  return policy.disableSkillShellExecution
    ? { disableSkillShellExecution: true }
    : {};
}

export function filterHappyclawToolsForPolicy<T extends { name: string }>(
  policy: ResolvedAgentToolPolicy,
  tools: T[],
): T[] {
  if (!policy.allowedHappyclawTools) return tools;
  const allowed = new Set(policy.allowedHappyclawTools);
  return tools.filter((tool) => allowed.has(tool.name));
}
