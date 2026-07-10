import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Link2,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wand2,
  Workflow,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '../api/client';
import { PolicyResourcePicker } from '../components/agents/PolicyResourcePicker';
import { useAgentProfilesStore } from '../stores/agent-profiles';
import { useSkillsStore } from '../stores/skills';
import { useMcpServersStore } from '../stores/mcp-servers';
import type {
  ProvidersListResponse,
  ProviderWithHealth,
} from '../components/settings/types';
import type { AgentProfileRuntimePolicy } from '../types';

const DEFAULT_RUNTIME_POLICY: AgentProfileRuntimePolicy = {
  provider_id: null,
  skills: { mode: 'inherit', ids: [] },
  mcp: { mode: 'inherit', ids: [] },
  tools: { mode: 'inherit' },
};

type RuntimePolicyMode = 'inherit' | 'custom' | 'disabled';
type ToolPolicyMode = 'inherit' | 'readonly' | 'restricted';

function normalizeRuntimePolicy(
  policy?: Partial<AgentProfileRuntimePolicy> | null,
): AgentProfileRuntimePolicy {
  return {
    provider_id: policy?.provider_id?.trim() || null,
    skills: {
      mode: policy?.skills?.mode ?? 'inherit',
      ids: policy?.skills?.ids ?? [],
    },
    mcp: {
      mode: policy?.mcp?.mode ?? 'inherit',
      ids: policy?.mcp?.ids ?? [],
    },
    tools: {
      mode: policy?.tools?.mode ?? 'inherit',
    },
  };
}

function sameRuntimePolicy(
  a?: Partial<AgentProfileRuntimePolicy> | null,
  b?: Partial<AgentProfileRuntimePolicy> | null,
): boolean {
  return (
    JSON.stringify(normalizeRuntimePolicy(a)) ===
    JSON.stringify(normalizeRuntimePolicy(b))
  );
}

export function AgentProfilesPage() {
  const {
    profiles,
    loading,
    profilesError,
    loadProfiles,
    loadProfileGovernance,
    governanceByProfile,
    governanceLoading,
    governanceErrors,
    generateProfileDraft,
    createProfile,
    updateProfile,
    deleteProfile,
    setWorkspaceAgentProfile,
  } = useAgentProfilesStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState(false);
  const [name, setName] = useState('');
  const [identityPrompt, setIdentityPrompt] = useState('');
  const [includeClaudePreset, setIncludeClaudePreset] = useState(true);
  const [policyProviderId, setPolicyProviderId] = useState('');
  const [skillsMode, setSkillsMode] = useState<RuntimePolicyMode>('inherit');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [mcpMode, setMcpMode] = useState<RuntimePolicyMode>('inherit');
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [toolsMode, setToolsMode] = useState<ToolPolicyMode>('inherit');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [createDescription, setCreateDescription] = useState('');
  const [providers, setProviders] = useState<ProviderWithHealth[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [movingWorkspaceJid, setMovingWorkspaceJid] = useState<string | null>(
    null,
  );
  const [workspaceMoveTargets, setWorkspaceMoveTargets] = useState<
    Record<string, string>
  >({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState('');

  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    try {
      const data = await api.get<ProvidersListResponse>(
        '/api/config/claude/providers',
      );
      setProviders(data.providers.filter((provider) => provider.enabled));
    } catch (err) {
      setProvidersError(getErrorMessage(err, 'Provider 目录加载失败'));
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void loadProviders();
    void loadSkills();
    void loadMcpServers();
  }, [loadMcpServers, loadProviders, loadSkills]);

  useEffect(() => {
    if (draftMode) return;
    if (selectedId && profiles.some((profile) => profile.id === selectedId)) {
      return;
    }
    const defaultProfile =
      profiles.find((profile) => profile.is_default) ?? profiles[0];
    if (defaultProfile) setSelectedId(defaultProfile.id);
  }, [draftMode, profiles, selectedId]);

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  const applyRuntimePolicyToForm = (
    policy?: AgentProfileRuntimePolicy | null,
  ) => {
    const normalized = normalizeRuntimePolicy(policy);
    setPolicyProviderId(normalized.provider_id ?? '');
    setSkillsMode(normalized.skills.mode);
    setSkillIds(normalized.skills.ids);
    setMcpMode(normalized.mcp.mode);
    setMcpIds(normalized.mcp.ids);
    setToolsMode(normalized.tools.mode);
  };

  const currentRuntimePolicy = useMemo(
    () =>
      normalizeRuntimePolicy({
        provider_id: policyProviderId,
        skills: { mode: skillsMode, ids: skillIds },
        mcp: { mode: mcpMode, ids: mcpIds },
        tools: { mode: toolsMode },
      }),
    [mcpIds, mcpMode, policyProviderId, skillIds, skillsMode, toolsMode],
  );

  useEffect(() => {
    if (draftMode) return;
    if (!selected) {
      setName('');
      setIdentityPrompt('');
      setIncludeClaudePreset(true);
      applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
      return;
    }
    setName(selected.name);
    setIdentityPrompt(selected.identity_prompt);
    setIncludeClaudePreset(selected.include_claude_preset);
    applyRuntimePolicyToForm(selected.runtime_policy);
  }, [draftMode, selected]);

  useEffect(() => {
    if (draftMode || !selected) return;
    void loadProfileGovernance(selected.id).catch((err) => {
      toast.error(getErrorMessage(err, '加载 Agent 治理数据失败'));
    });
  }, [draftMode, loadProfileGovernance, selected?.id]);

  const dirty =
    !draftMode &&
    !!selected &&
    (name.trim() !== selected.name ||
      identityPrompt.trim() !== selected.identity_prompt ||
      includeClaudePreset !== selected.include_claude_preset ||
      !sameRuntimePolicy(currentRuntimePolicy, selected.runtime_policy));

  const draftDirty =
    draftMode &&
    (!!name.trim() ||
      !!identityPrompt.trim() ||
      !includeClaudePreset ||
      !sameRuntimePolicy(currentRuntimePolicy, DEFAULT_RUNTIME_POLICY));
  const hasUnsavedChanges = dirty || draftDirty;

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const handleNavigationClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.href === window.location.href)
        return;
      if (!confirm('当前 Agent 有未保存修改，离开页面会丢失。是否继续？')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleNavigationClick, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleNavigationClick, true);
    };
  }, [hasUnsavedChanges]);

  const getErrorMessage = (err: unknown, fallback: string) => {
    if (err instanceof Error) return err.message;
    if (err && typeof err === 'object' && 'message' in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
    return fallback;
  };

  const governance = selected ? governanceByProfile[selected.id] : undefined;
  const governanceBusy = selected ? !!governanceLoading[selected.id] : false;
  const governanceError = selected ? governanceErrors[selected.id] : undefined;
  const governanceRuntimeSessionCount =
    governance?.workspaces.reduce(
      (sum, workspace) => sum + workspace.runtime_sessions.length,
      0,
    ) ?? 0;

  const skillOptions = useMemo(() => {
    const available = skills
      .filter((skill) => skill.source === 'user' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
      }));
    const known = new Set(available.map((option) => option.id));
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
    const known = new Set(available.map((option) => option.id));
    return [
      ...available,
      ...mcpIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [mcpIds, mcpServers]);

  const confirmDiscardUnsavedChanges = () =>
    !hasUnsavedChanges ||
    confirm('当前 Agent 有未保存修改，继续会丢失。是否继续？');

  const handleSelectProfile = (profileId: string) => {
    if (profileId === selectedId && !draftMode) return;
    if (!confirmDiscardUnsavedChanges()) return;
    setDraftMode(false);
    setSelectedId(profileId);
  };

  const handleRefreshProfiles = () => {
    if (!confirmDiscardUnsavedChanges()) return;
    void loadProfiles();
  };

  const handleGenerateDraft = async () => {
    const description = createDescription.trim();
    if (!description) return;
    if (!confirmDiscardUnsavedChanges()) return;
    setGeneratingDraft(true);
    try {
      const draft = await generateProfileDraft(description);
      setDraftMode(true);
      setSelectedId(null);
      setName(draft.name);
      setIdentityPrompt(draft.identity_prompt);
      setIncludeClaudePreset(true);
      applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
      toast.success('已生成 Agent 配置');
    } catch (err) {
      toast.error(getErrorMessage(err, '生成失败'));
    } finally {
      setGeneratingDraft(false);
    }
  };

  const handleBlankDraft = () => {
    if (!confirmDiscardUnsavedChanges()) return;
    setDraftMode(true);
    setSelectedId(null);
    setName('');
    setIdentityPrompt('');
    setIncludeClaudePreset(true);
    applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
  };

  const handleDiscardDraft = () => {
    if (draftDirty && !confirm('确认放弃当前 Agent 草稿？')) return;
    setDraftMode(false);
    const fallback =
      profiles.find((profile) => profile.is_default) ?? profiles[0];
    setSelectedId(fallback?.id ?? null);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const profile = await createProfile({
        name: trimmed,
        identity_prompt: identityPrompt.trim(),
        include_claude_preset: includeClaudePreset,
        runtime_policy: currentRuntimePolicy,
      });
      setCreateDescription('');
      setDraftMode(false);
      setSelectedId(profile.id);
      toast.success('已创建 Agent');
    } catch (err) {
      toast.error(getErrorMessage(err, '创建失败'));
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selected || !name.trim()) return;
    setSaving(true);
    try {
      const profile = await updateProfile(selected.id, {
        name: name.trim(),
        identity_prompt: identityPrompt.trim(),
        include_claude_preset: includeClaudePreset,
        runtime_policy: currentRuntimePolicy,
      });
      setSelectedId(profile.id);
      toast.success('已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleMoveWorkspace = async (
    workspaceJid: string,
    targetProfileId: string,
  ) => {
    if (!selected || targetProfileId === selected.id) return;
    setMovingWorkspaceJid(workspaceJid);
    try {
      await setWorkspaceAgentProfile(workspaceJid, targetProfileId);
      const target = profiles.find((profile) => profile.id === targetProfileId);
      toast.success(`工作区已迁移到「${target?.name ?? '目标 Agent'}」`);
      await Promise.allSettled([
        loadProfileGovernance(selected.id),
        loadProfileGovernance(targetProfileId),
      ]);
      setWorkspaceMoveTargets((current) => {
        const next = { ...current };
        delete next[workspaceJid];
        return next;
      });
    } catch (err) {
      toast.error(getErrorMessage(err, '迁移工作区失败'));
    } finally {
      setMovingWorkspaceJid(null);
    }
  };

  const deleteSelectedProfile = async () => {
    if (!selected) return;
    await deleteProfile(selected.id);
    const fallback = profiles.find((profile) => profile.is_default);
    setSelectedId(fallback?.id ?? null);
    toast.success('已删除');
  };

  const handleDelete = async () => {
    if (!selected || selected.is_default) return;
    if (dirty && !confirmDiscardUnsavedChanges()) return;
    setDeleting(true);
    try {
      const latestGovernance = await loadProfileGovernance(selected.id);
      if (latestGovernance.workspaces.length > 0) {
        const fallback =
          profiles.find(
            (profile) => profile.id !== selected.id && profile.is_default,
          ) ?? profiles.find((profile) => profile.id !== selected.id);
        if (!fallback) {
          toast.error('没有可迁移工作区的目标 Agent');
          return;
        }
        setDeleteTargetId(fallback.id);
        setDeleteDialogOpen(true);
        return;
      }
      if (latestGovernance.channel_mounts.length > 0) {
        toast.error('该 Agent 仍有消息挂载，请先在“消息挂载”页面解绑或换绑');
        return;
      }
      if (!confirm(`确认删除 Agent「${selected.name}」？`)) return;
      await deleteSelectedProfile();
    } catch (err) {
      toast.error(getErrorMessage(err, '删除失败'));
    } finally {
      setDeleting(false);
    }
  };

  const handleMigrateAndDelete = async () => {
    if (!selected || !governance || !deleteTargetId) return;
    setDeleting(true);
    try {
      for (const workspace of governance.workspaces) {
        await setWorkspaceAgentProfile(workspace.jid, deleteTargetId);
      }
      await deleteSelectedProfile();
      setDeleteDialogOpen(false);
    } catch (err) {
      toast.error(
        getErrorMessage(
          err,
          '迁移或删除失败；已完成的工作区迁移会保留，可重试剩余操作',
        ),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <Card>
          <CardContent>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="rounded-lg bg-brand-100 p-2">
                  <Bot className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-2xl font-bold text-foreground">Agent</h1>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{profiles.length} 个 Agent</span>
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshProfiles}
                disabled={loading}
              >
                <RefreshCw
                  className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
                />
                刷新
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardContent>
              <div className="mb-4 space-y-3 rounded-lg border bg-muted/20 p-3">
                <Textarea
                  value={createDescription}
                  onChange={(event) => setCreateDescription(event.target.value)}
                  className="min-h-[96px] resize-y text-sm leading-5"
                  placeholder="用一段话描述你想要的 Agent，例如：帮我做代码评审，重点看架构风险、测试缺口和上线风险，回答要直接给结论。"
                />
                <Button
                  variant="outline"
                  className="w-full justify-center"
                  onClick={handleGenerateDraft}
                  disabled={generatingDraft || !createDescription.trim()}
                >
                  {generatingDraft ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  AI 生成并填入右侧
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-center"
                  onClick={handleBlankDraft}
                >
                  <Plus className="h-4 w-4" />
                  新建空白 Agent
                </Button>
              </div>

              <div className="space-y-2">
                {draftMode && (
                  <button
                    className="w-full rounded-lg border border-primary bg-brand-50 px-3 py-2 text-left transition-colors"
                    onClick={() => setDraftMode(true)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {name.trim() || '新 Agent 草稿'}
                      </span>
                      <Badge variant="secondary">草稿</Badge>
                    </div>
                  </button>
                )}
                {loading && profiles.length === 0 ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  </div>
                ) : profilesError ? (
                  <div className="space-y-3 py-4 text-center">
                    <div className="text-sm text-error">{profilesError}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRefreshProfiles}
                    >
                      重试
                    </Button>
                  </div>
                ) : (
                  profiles.map((profile) => {
                    const active = profile.id === selectedId;
                    return (
                      <button
                        key={profile.id}
                        onClick={() => handleSelectProfile(profile.id)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          active && !draftMode
                            ? 'border-primary bg-brand-50'
                            : 'border-border hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {profile.name}
                          </span>
                          {profile.is_default && (
                            <Badge variant="secondary">默认</Badge>
                          )}
                          <span className="text-[11px] text-muted-foreground">
                            v{profile.version}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              {!selected && !draftMode ? (
                <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
                  选择一个 Agent
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                    <div className="space-y-4">
                      <div>
                        <label className="mb-2 flex items-center gap-2 text-sm font-medium">
                          名称
                          {draftMode && <Badge variant="secondary">草稿</Badge>}
                          {hasUnsavedChanges && (
                            <Badge variant="outline">未保存</Badge>
                          )}
                        </label>
                        <Input
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm font-medium">
                          身份提示词
                        </label>
                        <Textarea
                          value={identityPrompt}
                          onChange={(event) =>
                            setIdentityPrompt(event.target.value)
                          }
                          className="min-h-[260px] resize-y font-mono text-sm leading-6"
                          placeholder="例如：你是一个偏产品架构的工程 Agent，回答时先明确边界，再给可执行方案。"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">
                            包含 Claude Code 原生提示词
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            关闭后该 Agent 运行时只使用 HappyClaw 与 Agent
                            提示词
                          </div>
                        </div>
                        <Switch
                          checked={includeClaudePreset}
                          onCheckedChange={setIncludeClaudePreset}
                          aria-label="包含 Claude Code 原生提示词"
                        />
                      </div>
                      <div className="space-y-4 rounded-lg border bg-muted/20 px-3 py-3">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            运行策略
                          </div>
                          <div className="mt-1 text-xs leading-5 text-muted-foreground">
                            策略在 Agent
                            启动新运行态时生效；已运行的会话会在保存后由服务端失效并重建。
                          </div>
                        </div>

                        <div className="min-w-0">
                          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                            Provider
                          </label>
                          <Select
                            value={policyProviderId || '__inherit__'}
                            onValueChange={(value) =>
                              setPolicyProviderId(
                                value === '__inherit__' ? '' : value,
                              )
                            }
                            disabled={providersLoading}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="跟随全局负载均衡" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__inherit__">
                                跟随全局负载均衡
                              </SelectItem>
                              {policyProviderId &&
                                !providers.some(
                                  (provider) =>
                                    provider.id === policyProviderId,
                                ) && (
                                  <SelectItem value={policyProviderId}>
                                    {policyProviderId}（当前不可用）
                                  </SelectItem>
                                )}
                              {providers.map((provider) => (
                                <SelectItem
                                  key={provider.id}
                                  value={provider.id}
                                >
                                  {provider.name} ·{' '}
                                  {provider.anthropicModel || '默认模型'}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {providersLoading ? (
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              正在加载 Provider 目录
                            </div>
                          ) : providersError ? (
                            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-error">
                              <span>{providersError}</span>
                              <button
                                className="underline"
                                onClick={() => void loadProviders()}
                              >
                                重试
                              </button>
                            </div>
                          ) : null}
                        </div>

                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="min-w-0 space-y-2">
                            <label className="block text-xs font-medium text-muted-foreground">
                              用户 Skills
                            </label>
                            <Select
                              value={skillsMode}
                              onValueChange={(value) =>
                                setSkillsMode(value as RuntimePolicyMode)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="inherit">
                                  继承全部已启用用户 Skills
                                </SelectItem>
                                <SelectItem value="custom">
                                  只允许所选用户 Skills
                                </SelectItem>
                                <SelectItem value="disabled">
                                  禁用用户 Skills
                                </SelectItem>
                              </SelectContent>
                            </Select>
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
                            <p className="text-[11px] leading-5 text-muted-foreground">
                              仅控制 HappyClaw 用户
                              Skills；项目、外部与插件提供的 Skill
                              不在该选择范围内，但 Skill
                              的最终动作仍受下方能力边界约束。
                            </p>
                          </div>

                          <div className="min-w-0 space-y-2">
                            <label className="block text-xs font-medium text-muted-foreground">
                              用户 MCP
                            </label>
                            <Select
                              value={mcpMode}
                              onValueChange={(value) =>
                                setMcpMode(value as RuntimePolicyMode)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="inherit">
                                  继承全部已启用用户 MCP
                                </SelectItem>
                                <SelectItem value="custom">
                                  只允许所选用户 MCP
                                </SelectItem>
                                <SelectItem value="disabled">
                                  禁用用户 MCP
                                </SelectItem>
                              </SelectContent>
                            </Select>
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
                            <p className="text-[11px] leading-5 text-muted-foreground">
                              仅控制用户 MCP
                              目录；选择“只读”或“严格只读”能力边界时，用户 MCP
                              会被统一关闭。
                            </p>
                          </div>
                        </div>

                        <div className="min-w-0">
                          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                            工具与扩展能力边界
                          </label>
                          <Select
                            value={toolsMode}
                            onValueChange={(value) =>
                              setToolsMode(value as ToolPolicyMode)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inherit">
                                不增加 Agent 级限制
                              </SelectItem>
                              <SelectItem value="readonly">
                                只读（禁写、Bash、子 Agent、用户 MCP 与插件）
                              </SelectItem>
                              <SelectItem value="restricted">
                                严格只读（在只读基础上禁用 WebSearch /
                                WebFetch）
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                            两种只读模式都会启用严格 MCP、关闭用户 MCP
                            与用户插件、禁用写入/Bash/子
                            Agent，并默认拒绝尚未分类的 HappyClaw
                            工具；仅保留已分类的查询、记忆读取和消息回复等内置能力。严格只读再关闭网页搜索与抓取。
                          </p>
                        </div>
                      </div>
                      {!draftMode && selected && (
                        <div className="space-y-4 border-t pt-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-foreground">
                                治理概览
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                工作区、运行态会话和消息挂载的当前归属
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void loadProfileGovernance(selected.id)
                              }
                              disabled={governanceBusy}
                            >
                              <RefreshCw
                                className={
                                  governanceBusy
                                    ? 'h-4 w-4 animate-spin'
                                    : 'h-4 w-4'
                                }
                              />
                              刷新
                            </Button>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-3">
                            <div className="min-w-0 rounded-md bg-muted/30 px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Workflow className="h-3.5 w-3.5" />
                                工作区
                              </div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {governance?.workspaces.length ?? 0}
                              </div>
                            </div>
                            <div className="min-w-0 rounded-md bg-muted/30 px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <MessagesSquare className="h-3.5 w-3.5" />
                                运行态会话
                              </div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {governanceRuntimeSessionCount}
                              </div>
                            </div>
                            <div className="min-w-0 rounded-md bg-muted/30 px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Link2 className="h-3.5 w-3.5" />
                                IM 挂载
                              </div>
                              <div className="mt-1 text-lg font-semibold text-foreground">
                                {governance?.channel_mounts.length ?? 0}
                              </div>
                            </div>
                          </div>

                          {governanceError && !governance ? (
                            <div className="flex flex-wrap items-center gap-3 rounded-md border border-error/30 bg-error-bg px-3 py-3 text-sm text-error">
                              <span className="min-w-0 flex-1">
                                {governanceError}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  void loadProfileGovernance(selected.id)
                                }
                              >
                                重试
                              </Button>
                            </div>
                          ) : governanceBusy && !governance ? (
                            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              正在加载
                            </div>
                          ) : (
                            <div className="grid gap-4 xl:grid-cols-2">
                              <div className="min-w-0 space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  工作区与运行态会话
                                </div>
                                <div className="max-h-64 overflow-auto rounded-md border">
                                  {(governance?.workspaces.length ?? 0) ===
                                  0 ? (
                                    <div className="px-3 py-4 text-sm text-muted-foreground">
                                      暂无工作区
                                    </div>
                                  ) : (
                                    governance?.workspaces.map((workspace) => (
                                      <div
                                        key={workspace.jid}
                                        className="border-b px-3 py-2 last:border-b-0"
                                      >
                                        <div className="flex min-w-0 items-center justify-between gap-2">
                                          <div className="min-w-0">
                                            <div className="truncate text-sm font-medium text-foreground">
                                              {workspace.name}
                                            </div>
                                            <div className="truncate text-xs text-muted-foreground">
                                              {workspace.folder}
                                            </div>
                                          </div>
                                          <Badge variant="secondary">
                                            {workspace.runtime_sessions.length}{' '}
                                            个运行态会话
                                          </Badge>
                                        </div>
                                        {workspace.runtime_sessions.length >
                                          0 && (
                                          <div className="mt-2 space-y-1">
                                            {workspace.runtime_sessions.map(
                                              (session) => (
                                                <div
                                                  key={`${workspace.jid}:${session.runtime_agent_id || 'main'}`}
                                                  className="truncate text-xs text-muted-foreground"
                                                >
                                                  {session.runtime_agent_id ||
                                                    'main'}{' '}
                                                  · v
                                                  {session.agent_profile_version ??
                                                    '-'}{' '}
                                                  ·{' '}
                                                  {session.sdk_session_id ||
                                                    '-'}
                                                </div>
                                              ),
                                            )}
                                          </div>
                                        )}
                                        <div className="mt-2 flex items-center gap-2">
                                          <Select
                                            value={
                                              workspaceMoveTargets[
                                                workspace.jid
                                              ] || ''
                                            }
                                            onValueChange={(value) =>
                                              setWorkspaceMoveTargets(
                                                (current) => ({
                                                  ...current,
                                                  [workspace.jid]: value,
                                                }),
                                              )
                                            }
                                          >
                                            <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
                                              <SelectValue placeholder="迁移到其他 Agent" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              {profiles
                                                .filter(
                                                  (profile) =>
                                                    profile.id !== selected.id,
                                                )
                                                .map((profile) => (
                                                  <SelectItem
                                                    key={profile.id}
                                                    value={profile.id}
                                                  >
                                                    {profile.name}
                                                  </SelectItem>
                                                ))}
                                            </SelectContent>
                                          </Select>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-8"
                                            disabled={
                                              movingWorkspaceJid ===
                                                workspace.jid ||
                                              !workspaceMoveTargets[
                                                workspace.jid
                                              ]
                                            }
                                            onClick={() =>
                                              void handleMoveWorkspace(
                                                workspace.jid,
                                                workspaceMoveTargets[
                                                  workspace.jid
                                                ],
                                              )
                                            }
                                          >
                                            {movingWorkspaceJid ===
                                            workspace.jid ? (
                                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                              <ArrowRight className="h-3.5 w-3.5" />
                                            )}
                                            迁移
                                          </Button>
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>

                              <div className="min-w-0 space-y-2">
                                <div className="text-xs font-medium text-muted-foreground">
                                  IM 挂载
                                </div>
                                <div className="max-h-64 overflow-auto rounded-md border">
                                  {(governance?.channel_mounts.length ?? 0) ===
                                  0 ? (
                                    <div className="px-3 py-4 text-sm text-muted-foreground">
                                      暂无 IM 挂载
                                    </div>
                                  ) : (
                                    governance?.channel_mounts.map((mount) => (
                                      <div
                                        key={mount.channel_jid}
                                        className="border-b px-3 py-2 last:border-b-0"
                                      >
                                        <div className="flex min-w-0 items-center justify-between gap-2">
                                          <div className="min-w-0">
                                            <div className="truncate text-sm font-medium text-foreground">
                                              {mount.channel_jid}
                                            </div>
                                            <div className="truncate text-xs text-muted-foreground">
                                              {mount.workspace_folder ||
                                                mount.workspace_jid}
                                            </div>
                                          </div>
                                          <Badge variant="outline">
                                            {mount.channel_type}
                                          </Badge>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                          <span>
                                            {mount.session_id
                                              ? `session ${mount.session_id}`
                                              : 'main'}
                                          </span>
                                          <span>{mount.routing_mode}</span>
                                          <span>{mount.reply_policy}</span>
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      {draftMode ? (
                        <>
                          <Button
                            onClick={handleCreate}
                            disabled={creating || !name.trim()}
                          >
                            {creating ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Plus className="h-4 w-4" />
                            )}
                            创建 Agent
                          </Button>
                          <Button
                            variant="outline"
                            onClick={handleDiscardDraft}
                          >
                            <X className="h-4 w-4" />
                            放弃草稿
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            onClick={handleSave}
                            disabled={!dirty || saving || !name.trim()}
                          >
                            {saving ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Save className="h-4 w-4" />
                            )}
                            保存
                          </Button>
                          <Button
                            variant="outline"
                            onClick={handleDelete}
                            disabled={
                              !selected || selected.is_default || deleting
                            }
                            className="text-error hover:bg-error-bg hover:text-error"
                          >
                            <Trash2 className="h-4 w-4" />
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => !deleting && setDeleteDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>迁移工作区后删除 Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="leading-6 text-muted-foreground">
              「{selected?.name}」仍归属 {governance?.workspaces.length ?? 0}{' '}
              个工作区。删除前必须把它们迁移到同一个目标
              Agent；消息挂载会随工作区归属一起更新。
            </p>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                目标 Agent
              </label>
              <Select
                value={deleteTargetId}
                onValueChange={setDeleteTargetId}
                disabled={deleting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择目标 Agent" />
                </SelectTrigger>
                <SelectContent>
                  {profiles
                    .filter((profile) => profile.id !== selected?.id)
                    .map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                        {profile.is_default ? '（默认）' : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="max-h-40 overflow-auto rounded-md border bg-muted/20 p-2">
              {governance?.workspaces.map((workspace) => (
                <div
                  key={workspace.jid}
                  className="truncate px-1 py-1 text-xs text-muted-foreground"
                >
                  {workspace.name} · {workspace.folder}
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleMigrateAndDelete()}
              disabled={deleting || !deleteTargetId}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              迁移并删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
