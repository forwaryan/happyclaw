import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useMcpServersStore } from '../../stores/mcp-servers';
import { useSkillsStore } from '../../stores/skills';
import type { AgentProfileRuntimePolicy } from '../../types';
import { PolicyResourcePicker } from '../agents/PolicyResourcePicker';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type CapabilityMode = 'inherit' | 'custom' | 'disabled';
type ToolMode = 'inherit' | 'readonly' | 'restricted';

export function MainAgentCapabilitiesSection() {
  const profiles = useAgentProfilesStore((state) => state.profiles);
  const profilesLoading = useAgentProfilesStore((state) => state.loading);
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);
  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);
  const profile = profiles.find((item) => item.is_default);

  const [skillsMode, setSkillsMode] = useState<CapabilityMode>('inherit');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [mcpMode, setMcpMode] = useState<CapabilityMode>('inherit');
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [toolsMode, setToolsMode] = useState<ToolMode>('inherit');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([loadProfiles(), loadSkills(), loadMcpServers()]);
  }, [loadMcpServers, loadProfiles, loadSkills]);

  useEffect(() => {
    if (!profile) return;
    setSkillsMode(profile.runtime_policy.skills.mode);
    setSkillIds(profile.runtime_policy.skills.ids);
    setMcpMode(profile.runtime_policy.mcp.mode);
    setMcpIds(profile.runtime_policy.mcp.ids);
    setToolsMode(profile.runtime_policy.tools.mode);
  }, [profile?.id, profile?.updated_at]);

  const skillOptions = useMemo(() => {
    const available = skills
      .filter((skill) => skill.source === 'user' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
      }));
    const known = new Set(available.map((item) => item.id));
    return [
      ...available,
      ...skillIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [skillIds, skills]);

  const mcpOptions = useMemo(() => {
    const available = mcpServers
      .filter((server) => server.enabled)
      .map((server) => ({
        id: server.id,
        name: server.id,
        description: server.description,
      }));
    const known = new Set(available.map((item) => item.id));
    return [
      ...available,
      ...mcpIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [mcpIds, mcpServers]);

  const dirty =
    !!profile &&
    (skillsMode !== profile.runtime_policy.skills.mode ||
      JSON.stringify(skillIds) !==
        JSON.stringify(profile.runtime_policy.skills.ids) ||
      mcpMode !== profile.runtime_policy.mcp.mode ||
      JSON.stringify(mcpIds) !==
        JSON.stringify(profile.runtime_policy.mcp.ids) ||
      toolsMode !== profile.runtime_policy.tools.mode);

  const save = async () => {
    if (!profile || !dirty) return;
    setSaving(true);
    try {
      await api.patch(`/api/agent-profiles/${encodeURIComponent(profile.id)}`, {
        runtime_policy: {
          skills: { mode: skillsMode, ids: skillIds },
          mcp: { mode: mcpMode, ids: mcpIds },
          tools: { mode: toolsMode },
        } satisfies Partial<AgentProfileRuntimePolicy>,
      });
      await loadProfiles();
      toast.success('主 HappyClaw 能力已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存能力失败');
    } finally {
      setSaving(false);
    }
  };

  if (profilesLoading && !profile) {
    return (
      <div className="flex min-h-28 items-center justify-center border-b border-border py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="border-b border-border py-6 text-sm text-destructive">
        无法读取当前管理员的主 HappyClaw 配置。
      </div>
    );
  }

  return (
    <section className="space-y-5 border-b border-border py-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground">系统附加能力</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          控制 HappyClaw 为主 Agent 附加的用户 Skills、用户 MCP
          和工具边界。工作区中的 CLAUDE.md、.claude/skills 与项目 MCP
          仍按项目上下文加载。
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <CapabilityPicker
          label="用户 Skills"
          value={skillsMode}
          onValueChange={setSkillsMode}
          customLabel="只允许所选 Skills"
          disabledLabel="关闭用户 Skills"
        >
          {skillsMode === 'custom' && (
            <PolicyResourcePicker
              label="允许目录"
              options={skillOptions}
              selectedIds={skillIds}
              onChange={setSkillIds}
              loading={skillsLoading}
              error={skillsError}
              emptyText="没有已启用的用户 Skill"
            />
          )}
        </CapabilityPicker>

        <CapabilityPicker
          label="用户 MCP"
          value={mcpMode}
          onValueChange={setMcpMode}
          customLabel="只允许所选 MCP"
          disabledLabel="关闭用户 MCP"
        >
          {mcpMode === 'custom' && (
            <PolicyResourcePicker
              label="允许目录"
              options={mcpOptions}
              selectedIds={mcpIds}
              onChange={setMcpIds}
              loading={mcpLoading}
              error={mcpError}
              emptyText="没有已启用的用户 MCP"
            />
          )}
        </CapabilityPicker>
      </div>

      <div className="space-y-2 border-t border-border pt-5">
        <label className="text-xs font-medium text-muted-foreground">
          工具与扩展能力边界
        </label>
        <Select
          value={toolsMode}
          onValueChange={(value) => setToolsMode(value as ToolMode)}
        >
          <SelectTrigger aria-label="主 HappyClaw 工具能力边界">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">完整能力</SelectItem>
            <SelectItem value="readonly">
              只读（禁写、Bash、子 Agent、用户 MCP 与插件）
            </SelectItem>
            <SelectItem value="restricted">
              严格只读（额外关闭 WebSearch / WebFetch）
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="min-h-11"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          保存附加能力
        </Button>
      </div>
    </section>
  );
}

function CapabilityPicker({
  label,
  value,
  onValueChange,
  customLabel,
  disabledLabel,
  children,
}: {
  label: string;
  value: CapabilityMode;
  onValueChange: (mode: CapabilityMode) => void;
  customLabel: string;
  disabledLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select
        value={value}
        onValueChange={(next) => onValueChange(next as CapabilityMode)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">使用全部已启用项</SelectItem>
          <SelectItem value="custom">{customLabel}</SelectItem>
          <SelectItem value="disabled">{disabledLabel}</SelectItem>
        </SelectContent>
      </Select>
      {children}
    </div>
  );
}
