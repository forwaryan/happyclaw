import { useEffect } from 'react';
import { Bot, Cpu, FolderCog, Loader2, Puzzle, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import type { AgentProfileRuntimePolicy } from '../../types';

interface WorkspaceCapabilitiesPanelProps {
  agentProfileId?: string;
  agentName: string;
  canManage: boolean;
  onManageAgent: () => void;
}

const DEFAULT_POLICY: AgentProfileRuntimePolicy = {
  skills: { mode: 'inherit', ids: [] },
  mcp: { mode: 'inherit', ids: [] },
};

function policyLabel(
  policy:
    | AgentProfileRuntimePolicy['skills']
    | AgentProfileRuntimePolicy['mcp'],
): string {
  if (policy.mode === 'disabled') return '关闭';
  if (policy.mode === 'custom') return `仅允许指定项（${policy.ids.length}）`;
  return '继承全部已启用项';
}

function policyDetail(
  capability: 'Skill' | 'MCP',
  policy:
    | AgentProfileRuntimePolicy['skills']
    | AgentProfileRuntimePolicy['mcp'],
): string {
  if (policy.mode === 'disabled') {
    return `这个 Agent 不使用用户级 ${capability}。`;
  }
  if (policy.mode === 'custom') {
    return policy.ids.length > 0
      ? `允许：${policy.ids.join('、')}`
      : `尚未选择允许的 ${capability}。`;
  }
  return `使用当前用户已启用的全部 ${capability}。`;
}

export function WorkspaceCapabilitiesPanel({
  agentProfileId,
  agentName,
  canManage,
  onManageAgent,
}: WorkspaceCapabilitiesPanelProps) {
  const profiles = useAgentProfilesStore((state) => state.profiles);
  const loading = useAgentProfilesStore((state) => state.loading);
  const error = useAgentProfilesStore((state) => state.profilesError);
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);

  useEffect(() => {
    if (profiles.length === 0 && !loading) void loadProfiles();
  }, [loadProfiles, loading, profiles.length]);

  const profile =
    profiles.find((item) => item.id === agentProfileId) ??
    profiles.find((item) => item.is_default);
  const policy = profile?.runtime_policy ?? DEFAULT_POLICY;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {agentName}
            </h3>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              Agent 管理系统附加能力；工作区继续提供项目自己的上下文。
            </p>
          </div>
          <span className="ml-auto shrink-0 rounded-md bg-brand-50 px-2 py-1 text-[10px] font-medium text-primary dark:bg-brand-700/20 dark:text-brand-300">
            {profile
              ? profile.is_default
                ? '默认 Agent'
                : '自定义 Agent'
              : 'Agent'}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <CapabilitySection
          icon={Puzzle}
          title="Skills"
          value={policyLabel(policy.skills)}
          detail={policyDetail('Skill', policy.skills)}
        />

        <CapabilitySection
          icon={FolderCog}
          title="项目上下文"
          value="随工作区加载"
          detail="工作区中的 CLAUDE.md、.claude/skills 和项目 MCP 属于项目本身；Agent 策略决定 HappyClaw 管理的用户 Skills 与用户 MCP。"
        />

        <CapabilitySection
          icon={Server}
          title="MCP"
          value={policyLabel(policy.mcp)}
          detail={policyDetail('MCP', policy.mcp)}
        />

        <CapabilitySection
          icon={Cpu}
          title="模型与运行环境"
          value="系统统一管理"
          detail="模型、Provider 与凭据使用系统配置；项目需要的普通环境变量可在工作区高级设置中管理。"
        />

        {loading && (
          <div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取 Agent 能力…
          </div>
        )}
        {error && !loading && (
          <div className="mx-4 my-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs leading-5 text-destructive">
            Agent 能力加载失败：{error}
          </div>
        )}
      </div>

      {canManage && (
        <div className="border-t border-border p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center"
            onClick={onManageAgent}
          >
            管理 {agentName} 的能力
          </Button>
        </div>
      )}
    </div>
  );
}

function CapabilitySection({
  icon: Icon,
  title,
  value,
  detail,
}: {
  icon: typeof Puzzle;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <span className="ml-auto text-right text-xs font-medium text-foreground">
          {value}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        {detail}
      </p>
    </section>
  );
}
