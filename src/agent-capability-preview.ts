import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getEffectiveExternalDir } from './runtime-config.js';
import { loadManagedMcpLayers, parseManagedMcpReference } from './mcp-utils.js';
import {
  getHostClaudeMcpSourcePaths,
  readMcpServersFile,
} from './mcp-context.js';
import { scanSkillDirectory } from './skill-utils.js';
import type { AgentProfile, RegisteredGroup } from './types.js';

export type CapabilityLayerSource =
  | 'builtin'
  | 'host'
  | 'project'
  | 'workspace'
  | 'managed'
  | 'system'
  | 'user';

export interface EffectiveCapabilityEntry {
  id: string;
  source: CapabilityLayerSource;
  overrides: CapabilityLayerSource[];
  available: boolean;
  unavailableReason?: 'tool_boundary' | 'system_admin_only';
}

export interface AgentCapabilityPreview {
  workspace: { jid: string; name: string; folder: string } | null;
  context: {
    source: 'managed' | 'host_claude';
    claudeMd: boolean;
    rules: number;
  };
  skills: {
    mode: AgentProfile['runtime_policy']['skills']['mode'];
    entries: EffectiveCapabilityEntry[];
    conflicts: string[];
  };
  mcp: {
    mode: AgentProfile['runtime_policy']['mcp']['mode'];
    entries: EffectiveCapabilityEntry[];
    conflicts: string[];
    disabledByToolBoundary: boolean;
  };
  tools: {
    mode: AgentProfile['runtime_policy']['tools']['mode'];
    summary: string;
  };
  notes: string[];
}

function listSkillIds(root: string): string[] {
  return scanSkillDirectory(root, 'preview')
    .filter((skill) => skill.enabled)
    .map((skill) => skill.id)
    .sort();
}

function countEntries(root: string): number {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() || entry.isDirectory() || entry.isSymbolicLink(),
      ).length;
  } catch {
    return 0;
  }
}

function mergeLayers(
  layers: Array<{
    source: CapabilityLayerSource;
    ids: string[];
    available?: boolean;
    unavailableReason?: EffectiveCapabilityEntry['unavailableReason'];
  }>,
  available = true,
): { entries: EffectiveCapabilityEntry[]; conflicts: string[] } {
  const entries = new Map<string, EffectiveCapabilityEntry>();
  const conflicts = new Set<string>();
  for (const layer of layers) {
    for (const id of new Set(layer.ids)) {
      const previous = entries.get(id);
      if (previous) conflicts.add(id);
      entries.set(id, {
        id,
        source: layer.source,
        overrides: previous
          ? [...previous.overrides, previous.source].filter(
              (source, index, all) => all.indexOf(source) === index,
            )
          : [],
        available: available && layer.available !== false,
        ...(!available
          ? { unavailableReason: 'tool_boundary' as const }
          : layer.available === false && layer.unavailableReason
            ? { unavailableReason: layer.unavailableReason }
            : {}),
      });
    }
  }
  return {
    entries: [...entries.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    conflicts: [...conflicts].sort(),
  };
}

function mcpIds(filePath: string): string[] {
  return Object.keys(readMcpServersFile(filePath));
}

export function buildAgentCapabilityPreview(options: {
  profile: AgentProfile;
  workspace?: { jid: string; group: RegisteredGroup };
  ownerRole?: 'admin' | 'member';
}): AgentCapabilityPreview {
  const { profile, workspace } = options;
  const policy = profile.runtime_policy;
  const externalClaudeDir = getEffectiveExternalDir();
  const workspaceDir = workspace
    ? path.join(GROUPS_DIR, workspace.group.folder)
    : undefined;
  const hostContext = policy.context.source === 'host_claude';

  const allManagedSkills = listSkillIds(
    path.join(DATA_DIR, 'skills', profile.owner_user_id),
  );
  const managedSkills =
    policy.skills.mode === 'disabled'
      ? []
      : policy.skills.mode === 'custom'
        ? allManagedSkills.filter((id) => policy.skills.ids.includes(id))
        : allManagedSkills;
  const skillLayers: Array<{ source: CapabilityLayerSource; ids: string[] }> = [
    {
      source: 'builtin',
      ids: listSkillIds(path.join(DATA_DIR, 'builtin-skills')),
    },
    ...(hostContext
      ? [
          {
            source: 'host' as const,
            ids: listSkillIds(path.join(externalClaudeDir, 'skills')),
          },
        ]
      : []),
    {
      source: 'project',
      ids: listSkillIds(path.resolve(process.cwd(), 'container', 'skills')),
    },
    { source: 'managed', ids: managedSkills },
    ...(workspaceDir
      ? [
          {
            source: 'workspace' as const,
            ids: listSkillIds(path.join(workspaceDir, '.claude', 'skills')),
          },
        ]
      : []),
  ];
  const skills = mergeLayers(skillLayers);

  const allowAdminOnlySystemMcp = options.ownerRole === 'admin';
  const managedMcpLayers = loadManagedMcpLayers(profile.owner_user_id, {
    // Preview needs the complete catalogue so it can explain why a system
    // server is unavailable instead of making it disappear.
    allowAdminOnlySystemMcp: true,
  });
  const restrictedSystemIds = new Set(
    allowAdminOnlySystemMcp ? [] : managedMcpLayers.restrictedSystemIds,
  );
  let selectedSystemMcpIds: string[] = [];
  let selectedUserMcpIds: string[] = [];
  if (policy.mcp.mode === 'inherit') {
    selectedSystemMcpIds = Object.keys(managedMcpLayers.system);
    selectedUserMcpIds = Object.keys(managedMcpLayers.user);
  } else if (policy.mcp.mode === 'custom') {
    for (const reference of policy.mcp.ids) {
      const parsed = parseManagedMcpReference(reference);
      if (
        Object.prototype.hasOwnProperty.call(
          managedMcpLayers[parsed.scope],
          parsed.id,
        )
      ) {
        if (parsed.scope === 'system') selectedSystemMcpIds.push(parsed.id);
        else selectedUserMcpIds.push(parsed.id);
      }
    }
  }
  const mcpLayers: Array<{
    source: CapabilityLayerSource;
    ids: string[];
    available?: boolean;
    unavailableReason?: EffectiveCapabilityEntry['unavailableReason'];
  }> = [];
  if (hostContext) {
    mcpLayers.push({
      source: 'host',
      ids: getHostClaudeMcpSourcePaths(externalClaudeDir).flatMap(mcpIds),
    });
  }
  if (workspaceDir) {
    mcpLayers.push({
      source: 'workspace',
      ids: [
        ...mcpIds(path.join(workspaceDir, '.mcp.json')),
        ...mcpIds(path.join(workspaceDir, '.claude', 'settings.json')),
        ...mcpIds(path.join(workspaceDir, '.claude', 'settings.local.json')),
      ],
    });
  }
  mcpLayers.push({
    source: 'system',
    ids: selectedSystemMcpIds.filter((id) => !restrictedSystemIds.has(id)),
  });
  mcpLayers.push({
    source: 'system',
    ids: selectedSystemMcpIds.filter((id) => restrictedSystemIds.has(id)),
    available: false,
    unavailableReason: 'system_admin_only',
  });
  mcpLayers.push({ source: 'user', ids: selectedUserMcpIds });
  const mcpDisabled = policy.tools.mode !== 'inherit';
  const mcp = mergeLayers(mcpLayers, !mcpDisabled);

  const notes = [
    '系统附加能力与宿主机、项目上下文是叠加关系，不会因继承宿主机配置而被替换。',
  ];
  if (!workspace)
    notes.push('选择一个工作区后可检查该工作区的项目级 Skills 与 MCP。');
  if (skills.conflicts.length > 0) {
    notes.push(
      '同名 Skill 按内置 → 宿主机 → HappyClaw 项目 → 系统附加 → 工作区项目的顺序覆盖。',
    );
  }
  if (mcp.conflicts.length > 0)
    notes.push(
      '同名 MCP 按宿主机 → 工作区 → 系统 MCP → 用户 MCP 的稳定顺序覆盖。',
    );
  if (mcpDisabled) notes.push('当前工具边界会在执行时关闭所有外部 MCP。');
  if (restrictedSystemIds.size > 0) {
    notes.push(
      `有 ${restrictedSystemIds.size} 个系统 MCP 仅限管理员，普通成员 Agent 不会继承。`,
    );
  }

  return {
    workspace: workspace
      ? {
          jid: workspace.jid,
          name: workspace.group.name,
          folder: workspace.group.folder,
        }
      : null,
    context: {
      source: policy.context.source,
      claudeMd:
        hostContext && fs.existsSync(path.join(externalClaudeDir, 'CLAUDE.md')),
      rules: hostContext
        ? countEntries(path.join(externalClaudeDir, 'rules'))
        : 0,
    },
    skills: { mode: policy.skills.mode, ...skills },
    mcp: {
      mode: policy.mcp.mode,
      ...mcp,
      disabledByToolBoundary: mcpDisabled,
    },
    tools: {
      mode: policy.tools.mode,
      summary:
        policy.tools.mode === 'inherit'
          ? '完整能力'
          : policy.tools.mode === 'readonly'
            ? '只读：禁写入、Bash、子 Agent、外部 MCP 与插件'
            : '严格只读：额外禁用网页搜索与抓取',
    },
    notes,
  };
}
