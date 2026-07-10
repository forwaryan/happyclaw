import type { GroupInfo } from '../types';
import type { GroupEntry } from './group-utils';

export interface AgentWorkspaceSection {
  id: string;
  name: string;
  version?: number;
  items: GroupEntry[];
}

export function groupWorkspacesByAgent(
  groups: GroupEntry[],
): AgentWorkspaceSection[] {
  const byAgent = new Map<string, AgentWorkspaceSection>();
  for (const group of groups) {
    const id = group.agent_profile_id || '__default__';
    const existing = byAgent.get(id) ?? {
      id,
      name: group.agent_profile_name || 'Default Agent',
      version: group.agent_profile_version,
      items: [],
    };
    existing.items.push(group);
    if (!existing.version && group.agent_profile_version) {
      existing.version = group.agent_profile_version;
    }
    byAgent.set(id, existing);
  }

  return Array.from(byAgent.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN'),
  );
}

export function buildWorkspaceAgentProfilePatch(agentProfileId: string) {
  return { agent_profile_id: agentProfileId };
}

export function workspaceCreationBlockReason(input: {
  name: string;
  submitting: boolean;
  profilesLoading: boolean;
  profilesError: string | null;
  selectedAgentProfileId: string;
}): string | null {
  if (!input.name.trim()) return '请输入工作区名称';
  if (input.submitting) return '正在创建工作区';
  if (input.profilesLoading) return '正在加载 Agent';
  if (input.profilesError) return 'Agent 列表加载失败';
  if (!input.selectedAgentProfileId) return '请选择 Agent';
  return null;
}

export function getWorkspaceExecutionMode(
  groups: Record<string, GroupInfo>,
  jid: string,
): 'host' | 'container' | null {
  const mode = groups[jid]?.execution_mode;
  return mode === 'host' || mode === 'container' ? mode : null;
}
