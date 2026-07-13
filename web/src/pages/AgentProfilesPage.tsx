import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { AgentPromptAssistant } from '../components/agents/AgentPromptAssistant';
import { EffectiveCapabilitiesPreview } from '../components/agents/EffectiveCapabilitiesPreview';
import { AgentGovernanceSection } from '../components/agents/AgentGovernanceSection';
import { PolicyResourcePicker } from '../components/agents/PolicyResourcePicker';
import { EmojiAvatar } from '../components/common/EmojiAvatar';
import { EmojiPicker } from '../components/common/EmojiPicker';
import { ColorPicker } from '../components/common/ColorPicker';
import { useAgentProfilesStore } from '../stores/agent-profiles';
import { useAuthStore } from '../stores/auth';
import { useSkillsStore } from '../stores/skills';
import { useMcpServersStore } from '../stores/mcp-servers';
import {
  getAgentContextSource,
  type AgentContextSource,
  type AgentProfileRuntimePolicy,
} from '../types';
import { getCustomAgentProfiles } from '../utils/agent-product';

const DEFAULT_RUNTIME_POLICY: AgentProfileRuntimePolicy = {
  context: {
    source: 'managed',
    auto_compact_window: 0,
    auto_compact_percentage: 0,
  },
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
    context: {
      source: getAgentContextSource(policy),
      auto_compact_window:
        typeof policy?.context?.auto_compact_window === 'number'
          ? policy.context.auto_compact_window
          : 0,
      auto_compact_percentage:
        typeof policy?.context?.auto_compact_percentage === 'number'
          ? policy.context.auto_compact_percentage
          : 0,
    },
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
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProfileId = searchParams.get('agent');
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
    uploadProfileAvatar,
    removeProfileAvatar,
    deleteProfile,
    setWorkspaceAgentProfile,
  } = useAgentProfilesStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState(false);
  const [name, setName] = useState('');
  const [identityPrompt, setIdentityPrompt] = useState('');
  const [includeClaudePreset, setIncludeClaudePreset] = useState(true);
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarStyleOpen, setAvatarStyleOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [contextSource, setContextSource] =
    useState<AgentContextSource>('managed');
  const [useSdkCompactDefault, setUseSdkCompactDefault] = useState(true);
  const [autoCompactPercentage, setAutoCompactPercentage] = useState('80');
  const [legacyAutoCompactWindow, setLegacyAutoCompactWindow] = useState(0);
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
  const [movingWorkspaceJid, setMovingWorkspaceJid] = useState<string | null>(
    null,
  );
  const [workspaceMoveTargets, setWorkspaceMoveTargets] = useState<
    Record<string, string>
  >({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState('');
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const mainAppearance = useAuthStore((state) => state.appearance);

  const customProfiles = useMemo(
    () => getCustomAgentProfiles(profiles),
    [profiles],
  );

  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void loadSkills();
    void loadMcpServers();
  }, [loadMcpServers, loadSkills]);

  useEffect(() => {
    if (draftMode) return;
    if (
      requestedProfileId &&
      customProfiles.some((profile) => profile.id === requestedProfileId)
    ) {
      if (selectedId !== requestedProfileId) {
        setSelectedId(requestedProfileId);
      }
      return;
    }
    if (
      selectedId &&
      customProfiles.some((profile) => profile.id === selectedId)
    ) {
      if (requestedProfileId && requestedProfileId !== selectedId) {
        setSearchParams({ agent: selectedId }, { replace: true });
      }
      return;
    }
    const fallbackId = customProfiles[0]?.id ?? null;
    setSelectedId(fallbackId);
    if (requestedProfileId) {
      setSearchParams(fallbackId ? { agent: fallbackId } : {}, {
        replace: true,
      });
    }
  }, [
    customProfiles,
    draftMode,
    requestedProfileId,
    selectedId,
    setSearchParams,
  ]);

  const selected = useMemo(
    () => customProfiles.find((profile) => profile.id === selectedId) ?? null,
    [customProfiles, selectedId],
  );

  useEffect(() => {
    if (!selected || location.hash !== '#agent-capabilities') return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById('agent-capabilities')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, selected]);

  const applyRuntimePolicyToForm = (
    policy?: AgentProfileRuntimePolicy | null,
  ) => {
    const normalized = normalizeRuntimePolicy(policy);
    setSkillsMode(normalized.skills.mode);
    setSkillIds(normalized.skills.ids);
    setMcpMode(normalized.mcp.mode);
    setMcpIds(normalized.mcp.ids);
    setToolsMode(normalized.tools.mode);
    setContextSource(getAgentContextSource(normalized));
    const compactWindow = normalized.context?.auto_compact_window ?? 0;
    const compactPercentage = normalized.context?.auto_compact_percentage ?? 0;
    setUseSdkCompactDefault(compactWindow === 0 && compactPercentage === 0);
    setAutoCompactPercentage(
      compactPercentage > 0
        ? String(compactPercentage)
        : compactWindow > 0
          ? 'legacy'
          : '80',
    );
    setLegacyAutoCompactWindow(compactWindow);
  };

  const autoCompactError = useMemo(() => {
    if (useSdkCompactDefault) return null;
    if (autoCompactPercentage === 'legacy') return null;
    if (!autoCompactPercentage.trim()) return '请输入压缩比例。';
    const value = Number(autoCompactPercentage);
    if (!Number.isInteger(value) || value < 50 || value > 90) {
      return '请输入 50–90 之间的整数。';
    }
    return null;
  }, [autoCompactPercentage, useSdkCompactDefault]);

  const currentRuntimePolicy = useMemo(
    () =>
      normalizeRuntimePolicy({
        context: {
          source: contextSource,
          auto_compact_window: useSdkCompactDefault
            ? 0
            : autoCompactPercentage === 'legacy'
              ? legacyAutoCompactWindow
              : 0,
          auto_compact_percentage: useSdkCompactDefault
            ? 0
            : autoCompactPercentage === 'legacy'
              ? 0
              : Number(autoCompactPercentage),
        },
        skills: { mode: skillsMode, ids: skillIds },
        mcp: { mode: mcpMode, ids: mcpIds },
        tools: { mode: toolsMode },
      }),
    [
      autoCompactPercentage,
      contextSource,
      legacyAutoCompactWindow,
      mcpIds,
      mcpMode,
      skillIds,
      skillsMode,
      toolsMode,
      useSdkCompactDefault,
    ],
  );

  useEffect(() => {
    if (draftMode) return;
    if (!selected) {
      setName('');
      setIdentityPrompt('');
      setIncludeClaudePreset(true);
      setAvatarEmoji(null);
      setAvatarColor(null);
      setAvatarUrl(null);
      setAvatarStyleOpen(false);
      applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
      return;
    }
    setName(selected.name);
    setIdentityPrompt(selected.identity_prompt);
    setIncludeClaudePreset(selected.include_claude_preset);
    setAvatarEmoji(selected.avatar_emoji);
    setAvatarColor(selected.avatar_color);
    setAvatarUrl(selected.avatar_url);
    setAvatarStyleOpen(!!(selected.avatar_emoji || selected.avatar_color));
    applyRuntimePolicyToForm(selected.runtime_policy);
  }, [draftMode, selected?.id]);

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
      avatarEmoji !== selected.avatar_emoji ||
      avatarColor !== selected.avatar_color ||
      !sameRuntimePolicy(currentRuntimePolicy, selected.runtime_policy));

  const draftDirty =
    draftMode &&
    (!!name.trim() ||
      !!identityPrompt.trim() ||
      !includeClaudePreset ||
      avatarEmoji !== null ||
      avatarColor !== null ||
      !sameRuntimePolicy(currentRuntimePolicy, DEFAULT_RUNTIME_POLICY));
  const hasUnsavedChanges = dirty || draftDirty;

  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    if (
      hasUnsavedChanges &&
      !confirm('当前 Agent 有未保存修改，继续会丢失。是否继续？')
    ) {
      setSearchParams(next, { replace: true });
      return;
    }
    setDraftMode(true);
    setSelectedId(null);
    setName('');
    setIdentityPrompt('');
    setIncludeClaudePreset(true);
    setAvatarEmoji(null);
    setAvatarColor(null);
    setAvatarUrl(null);
    setAvatarStyleOpen(false);
    applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
    setCreatePanelOpen(false);
    setSearchParams(next, { replace: true });
  }, [hasUnsavedChanges, searchParams, setSearchParams]);

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
    setSearchParams({ agent: profileId }, { replace: true });
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
      setAvatarEmoji(null);
      setAvatarColor(null);
      setAvatarUrl(null);
      setAvatarStyleOpen(false);
      applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
      setCreatePanelOpen(false);
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
    setAvatarEmoji(null);
    setAvatarColor(null);
    setAvatarUrl(null);
    setAvatarStyleOpen(false);
    applyRuntimePolicyToForm(DEFAULT_RUNTIME_POLICY);
    setCreatePanelOpen(false);
  };

  const handleDiscardDraft = () => {
    if (draftDirty && !confirm('确认放弃当前 Agent 草稿？')) return;
    setDraftMode(false);
    const fallback = customProfiles[0];
    setSelectedId(fallback?.id ?? null);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || autoCompactError) return;
    setCreating(true);
    try {
      const profile = await createProfile({
        name: trimmed,
        identity_prompt: identityPrompt.trim(),
        include_claude_preset: includeClaudePreset,
        avatar_emoji: avatarEmoji,
        avatar_color: avatarColor,
        runtime_policy: currentRuntimePolicy,
      });
      setCreateDescription('');
      setDraftMode(false);
      setSelectedId(profile.id);
      setSearchParams({ agent: profile.id }, { replace: true });
      toast.success('已创建 Agent');
    } catch (err) {
      toast.error(getErrorMessage(err, '创建失败'));
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!selected || !name.trim() || autoCompactError) return;
    setSaving(true);
    try {
      const changes: Parameters<typeof updateProfile>[1] = {};
      if (name.trim() !== selected.name) changes.name = name.trim();
      if (identityPrompt.trim() !== selected.identity_prompt) {
        changes.identity_prompt = identityPrompt.trim();
      }
      if (includeClaudePreset !== selected.include_claude_preset) {
        changes.include_claude_preset = includeClaudePreset;
      }
      if (avatarEmoji !== selected.avatar_emoji) {
        changes.avatar_emoji = avatarEmoji;
      }
      if (avatarColor !== selected.avatar_color) {
        changes.avatar_color = avatarColor;
      }
      if (!sameRuntimePolicy(currentRuntimePolicy, selected.runtime_policy)) {
        changes.runtime_policy = currentRuntimePolicy;
      }
      if (Object.keys(changes).length === 0) return;
      const profile = await updateProfile(selected.id, changes);
      setSelectedId(profile.id);
      toast.success('已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selected || draftMode) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error('图片文件不能超过 3MB');
      return;
    }
    if (
      !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
        file.type,
      )
    ) {
      toast.error('仅支持 jpg、png、gif、webp 格式');
      return;
    }
    setUploadingAvatar(true);
    try {
      const profile = await uploadProfileAvatar(selected.id, file);
      setAvatarUrl(profile.avatar_url);
      toast.success('Agent 头像已更新');
    } catch (error) {
      toast.error(getErrorMessage(error, '上传头像失败'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleInheritMainAvatar = async () => {
    if (!selected || draftMode) {
      setAvatarEmoji(null);
      setAvatarColor(null);
      setAvatarUrl(null);
      setAvatarStyleOpen(false);
      return;
    }
    setUploadingAvatar(true);
    try {
      if (selected.avatar_url) await removeProfileAvatar(selected.id);
      const profile = await updateProfile(selected.id, {
        avatar_emoji: null,
        avatar_color: null,
      });
      setAvatarEmoji(profile.avatar_emoji);
      setAvatarColor(profile.avatar_color);
      setAvatarUrl(profile.avatar_url);
      setAvatarStyleOpen(false);
      toast.success('已改为继承主 HappyClaw 头像');
    } catch (error) {
      toast.error(getErrorMessage(error, '恢复主头像失败'));
    } finally {
      setUploadingAvatar(false);
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
    const fallback = customProfiles.find(
      (profile) => profile.id !== selected.id,
    );
    setSelectedId(fallback?.id ?? null);
    setSearchParams(fallback ? { agent: fallback.id } : {}, { replace: true });
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
          customProfiles.find((profile) => profile.id !== selected.id) ??
          profiles.find(
            (profile) => profile.id !== selected.id && profile.is_default,
          );
        if (!fallback) {
          toast.error('没有可迁移工作区的目标 Agent');
          return;
        }
        setDeleteTargetId(fallback.id);
        setDeleteDialogOpen(true);
        return;
      }
      if (latestGovernance.channel_mounts.length > 0) {
        toast.error('该 Agent 仍有渠道绑定，请先在“渠道绑定”页面解绑或换绑');
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
    <div className="min-h-full bg-background lg:flex">
      <aside className="border-b border-border bg-muted/20 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-72 lg:flex-none lg:flex-col lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 px-4 py-4 lg:px-5 lg:pt-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground">
              自定义 Agent
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {customProfiles.length} 个 Agent
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleRefreshProfiles}
            disabled={loading}
            aria-label="刷新 Agent 列表"
            title="刷新 Agent 列表"
          >
            <RefreshCw
              className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
            />
          </Button>
          <Button
            size="sm"
            onClick={() => setCreatePanelOpen((open) => !open)}
            aria-expanded={createPanelOpen}
          >
            <Plus className="h-4 w-4" />
            新建
          </Button>
        </div>

        {createPanelOpen && (
          <div className="mx-3 mb-3 space-y-3 rounded-xl border border-border bg-background p-3 lg:mx-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                创建 Agent
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                描述它的角色，AI 会生成名称和身份提示词。
              </p>
            </div>
            <label className="block">
              <span className="sr-only">Agent 角色描述</span>
              <Textarea
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
                className="min-h-[88px] resize-y text-sm leading-5"
                placeholder="例如：帮我做代码评审，重点关注架构风险和测试缺口。"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                className="justify-center"
                onClick={handleGenerateDraft}
                disabled={generatingDraft || !createDescription.trim()}
              >
                {generatingDraft ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                AI 生成
              </Button>
              <Button
                variant="outline"
                className="justify-center"
                onClick={handleBlankDraft}
              >
                空白创建
              </Button>
            </div>
          </div>
        )}

        <nav
          aria-label="自定义 Agent 列表"
          className="flex gap-2 overflow-x-auto px-3 pb-4 lg:block lg:min-h-0 lg:flex-1 lg:space-y-1 lg:overflow-y-auto lg:px-4"
        >
          {draftMode && (
            <button
              className="flex min-w-[220px] items-center gap-3 rounded-lg bg-brand-50 px-3 py-2.5 text-left ring-1 ring-inset ring-primary/20 transition-colors lg:min-w-0 lg:w-full"
              onClick={() => setDraftMode(true)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">
                  {name.trim() || '新 Agent 草稿'}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  尚未保存
                </span>
              </span>
              <Badge variant="secondary">草稿</Badge>
            </button>
          )}
          {loading && customProfiles.length === 0 ? (
            <div className="flex min-w-48 justify-center py-8 lg:min-w-0">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : profilesError ? (
            <div className="min-w-56 space-y-3 py-4 text-center lg:min-w-0">
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
            customProfiles.map((profile) => {
              const active = profile.id === selectedId;
              return (
                <button
                  key={profile.id}
                  onClick={() => handleSelectProfile(profile.id)}
                  className={`flex min-w-[220px] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-w-0 lg:w-full ${
                    active && !draftMode
                      ? 'bg-brand-50 text-foreground ring-1 ring-inset ring-primary/15'
                      : 'hover:bg-accent/70'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {profile.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {profile.identity_prompt.replace(/\s+/g, ' ').trim() ||
                        '尚未设置身份描述'}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl p-4 pb-24 sm:p-6 sm:pb-24 lg:p-8">
          {!selected && !draftMode ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
                <Bot className="h-5 w-5" />
              </div>
              <div className="mt-4 text-sm font-medium text-foreground">
                {customProfiles.length === 0
                  ? '还没有自定义 Agent'
                  : '选择一个 Agent'}
              </div>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                {customProfiles.length === 0
                  ? '创建一个专门处理特定任务的 Agent。'
                  : '从左侧选择 Agent 查看配置，或创建一个新的 Agent。'}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              <header>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                      {name.trim() || '新 Agent'}
                    </h1>
                    {draftMode && <Badge variant="secondary">草稿</Badge>}
                    {hasUnsavedChanges && (
                      <Badge variant="outline">有未保存修改</Badge>
                    )}
                  </div>
                  <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
                    管理 Agent 的身份和能力，以及所属工作区和消息渠道。
                  </p>
                </div>
              </header>

              <div className="space-y-5">
                <div className="space-y-5">
                  <section className="overflow-hidden rounded-xl border border-border bg-card">
                    <div className="border-b border-border px-5 py-4">
                      <h2 className="text-sm font-semibold text-foreground">
                        身份
                      </h2>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        定义这个 Agent
                        如何称呼自己，以及它处理任务时遵循的角色设定。
                      </p>
                    </div>
                    <div className="space-y-4 px-5 py-5">
                      <div>
                        <label
                          htmlFor="agent-profile-name"
                          className="mb-2 flex items-center gap-2 text-sm font-medium"
                        >
                          名称
                        </label>
                        <Input
                          id="agent-profile-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                        />
                      </div>
                      <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                        <div className="flex flex-wrap items-center gap-4">
                          <EmojiAvatar
                            imageUrl={
                              avatarUrl ||
                              (!avatarEmoji && !avatarColor
                                ? mainAppearance?.aiAvatarUrl ||
                                  (mainAppearance?.aiAvatarMode !== 'emoji'
                                    ? `${import.meta.env.BASE_URL}icons/icon-192.png`
                                    : undefined)
                                : undefined)
                            }
                            emoji={
                              avatarEmoji ||
                              (!avatarUrl && !avatarColor
                                ? mainAppearance?.aiAvatarMode === 'emoji'
                                  ? mainAppearance.aiAvatarEmoji
                                  : undefined
                                : undefined)
                            }
                            color={
                              avatarColor ||
                              (!avatarUrl && !avatarEmoji
                                ? mainAppearance?.aiAvatarMode === 'emoji'
                                  ? mainAppearance.aiAvatarColor
                                  : undefined
                                : undefined)
                            }
                            fallbackChar={name || 'A'}
                            size="lg"
                            className="!h-12 !w-12 !text-xl"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-foreground">
                              Agent 头像
                            </div>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {avatarUrl || avatarEmoji || avatarColor
                                ? '当前使用这个 Agent 的自定义头像。'
                                : '未单独设置，自动继承主 HappyClaw 头像。'}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <input
                              ref={avatarInputRef}
                              type="file"
                              accept="image/jpeg,image/png,image/gif,image/webp"
                              className="hidden"
                              onChange={handleAvatarUpload}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={draftMode || uploadingAvatar}
                              onClick={() => avatarInputRef.current?.click()}
                            >
                              {uploadingAvatar ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Upload className="size-3.5" />
                              )}
                              上传图片
                            </Button>
                            {!avatarStyleOpen && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setAvatarStyleOpen(true)}
                              >
                                使用 Emoji
                              </Button>
                            )}
                            {(avatarUrl || avatarEmoji || avatarColor) && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={uploadingAvatar}
                                onClick={handleInheritMainAvatar}
                              >
                                <RotateCcw className="size-3.5" />
                                使用主头像
                              </Button>
                            )}
                          </div>
                        </div>
                        {avatarStyleOpen && (
                          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
                            <div>
                              <span className="mb-1.5 block text-xs text-muted-foreground">
                                Emoji（可选）
                              </span>
                              <EmojiPicker
                                value={avatarEmoji ?? undefined}
                                onChange={setAvatarEmoji}
                              />
                            </div>
                            <div>
                              <span className="mb-1.5 block text-xs text-muted-foreground">
                                背景色（可选）
                              </span>
                              <ColorPicker
                                value={avatarColor ?? undefined}
                                onChange={setAvatarColor}
                              />
                            </div>
                          </div>
                        )}
                        {draftMode && (
                          <p className="text-[11px] text-muted-foreground">
                            创建 Agent 后即可上传图片；Emoji
                            与背景色会随创建一起保存。
                          </p>
                        )}
                      </div>
                      <div>
                        <label
                          htmlFor="agent-profile-identity-prompt"
                          className="mb-2 block text-sm font-medium"
                        >
                          身份提示词
                        </label>
                        <Textarea
                          id="agent-profile-identity-prompt"
                          value={identityPrompt}
                          onChange={(event) =>
                            setIdentityPrompt(event.target.value)
                          }
                          className="min-h-[180px] resize-y text-sm leading-6"
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
                      {isAdmin && (
                        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground">
                              继承宿主机 Claude Code 配置
                            </div>
                            <div className="mt-1 text-xs leading-5 text-muted-foreground">
                              将 ~/.claude/ 作为这个 Agent
                              的基础上下文。无论工作区运行在 Docker
                              还是宿主机，该设置都会生效；HappyClaw 管理的
                              Skills 与 MCP 仍会作为附加能力生效。
                            </div>
                          </div>
                          <Switch
                            checked={contextSource === 'host_claude'}
                            onCheckedChange={(checked) =>
                              setContextSource(
                                checked ? 'host_claude' : 'managed',
                              )
                            }
                            aria-label="继承宿主机 Claude Code 配置"
                          />
                        </div>
                      )}
                    </div>
                  </section>

                  {!draftMode && selected && (
                    <AgentPromptAssistant
                      key={selected.id}
                      profileId={selected.id}
                      agentName={name.trim() || selected.name}
                      currentPrompt={identityPrompt}
                      onApply={setIdentityPrompt}
                    />
                  )}

                  <section
                    id="agent-capabilities"
                    className="scroll-mt-6 overflow-hidden rounded-xl border border-border bg-card"
                  >
                    <div className="border-b border-border px-5 py-4">
                      <h2 className="text-sm font-semibold text-foreground">
                        能力配置
                      </h2>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        这里控制 HappyClaw 附加给 Agent 的用户 Skills、用户 MCP
                        和工具边界。工作区中的 CLAUDE.md、.claude/skills 与项目
                        MCP 仍作为项目上下文加载；模型、Provider
                        与凭据使用系统设置。
                      </p>
                    </div>
                    <div className="space-y-5 px-5 py-5">
                      <div className="grid gap-4 xl:grid-cols-2">
                        <div className="min-w-0 space-y-2">
                          <label className="block text-xs font-medium text-muted-foreground">
                            Skills
                          </label>
                          <Select
                            value={skillsMode}
                            onValueChange={(value) =>
                              setSkillsMode(value as RuntimePolicyMode)
                            }
                          >
                            <SelectTrigger aria-label="Agent Skills">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inherit">
                                使用全部已启用 Skills
                              </SelectItem>
                              <SelectItem value="custom">
                                只允许所选 Skills
                              </SelectItem>
                              <SelectItem value="disabled">
                                关闭 Skills
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
                            选择这个 Agent 可以使用的用户 Skills；Skill
                            的最终动作仍受下方能力边界约束。
                          </p>
                        </div>

                        <div className="min-w-0 space-y-2">
                          <label className="block text-xs font-medium text-muted-foreground">
                            MCP
                          </label>
                          <Select
                            value={mcpMode}
                            onValueChange={(value) =>
                              setMcpMode(value as RuntimePolicyMode)
                            }
                          >
                            <SelectTrigger aria-label="Agent MCP">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inherit">
                                使用全部 HappyClaw 用户 MCP
                              </SelectItem>
                              <SelectItem value="custom">
                                只允许所选 HappyClaw 用户 MCP
                              </SelectItem>
                              <SelectItem value="disabled">
                                关闭 HappyClaw 用户 MCP
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
                            只控制 HappyClaw 附加的用户 MCP；项目 MCP
                            与管理员授权的宿主机 MCP 仍作为 Claude
                            上下文加载。“只读”或“严格只读”能力边界会统一关闭外部
                            MCP。
                          </p>
                        </div>
                      </div>

                      <div className="border-t border-border pt-5">
                        <div className="flex min-h-14 items-start justify-between gap-5">
                          <div className="min-w-0">
                            <label
                              htmlFor="agent-auto-compact-default"
                              className="text-xs font-medium text-muted-foreground"
                            >
                              SDK 自动压缩（推荐）
                            </label>
                            <p
                              id="agent-auto-compact-default-description"
                              className="mt-1 text-[11px] leading-5 text-muted-foreground"
                            >
                              根据当前模型自动决定压缩时机。普通模型通常为 200K
                              上下文；模型名带 [1m] 时按 1M 处理。
                            </p>
                          </div>
                          <Switch
                            id="agent-auto-compact-default"
                            checked={useSdkCompactDefault}
                            onCheckedChange={setUseSdkCompactDefault}
                            aria-describedby="agent-auto-compact-default-description"
                          />
                        </div>
                        {!useSdkCompactDefault && (
                          <div className="mt-4 max-w-xs">
                            {autoCompactPercentage === 'legacy' ? (
                              <div className="rounded-md border border-warning/30 bg-warning-bg p-3">
                                <p className="text-[11px] leading-5 text-warning">
                                  当前保留旧版固定阈值{' '}
                                  {Math.round(legacyAutoCompactWindow / 1000)}
                                  K。 固定值无法同时适配 200K 与 1M 模型。
                                </p>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="mt-2"
                                  onClick={() => {
                                    setAutoCompactPercentage('80');
                                    setLegacyAutoCompactWindow(0);
                                  }}
                                >
                                  改用 80% 模型比例
                                </Button>
                              </div>
                            ) : (
                              <>
                                <label
                                  htmlFor="agent-auto-compact-percentage"
                                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                                >
                                  上下文使用比例
                                </label>
                                <div className="flex items-center gap-2">
                                  <Input
                                    id="agent-auto-compact-percentage"
                                    type="number"
                                    inputMode="numeric"
                                    min={50}
                                    max={90}
                                    step={5}
                                    value={autoCompactPercentage}
                                    onChange={(event) => {
                                      setAutoCompactPercentage(
                                        event.target.value,
                                      );
                                      setLegacyAutoCompactWindow(0);
                                    }}
                                    aria-invalid={!!autoCompactError}
                                    aria-describedby={`agent-auto-compact-percentage-description${autoCompactError ? ' agent-auto-compact-percentage-error' : ''}`}
                                    className="h-11"
                                  />
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    %
                                  </span>
                                </div>
                                <p
                                  id="agent-auto-compact-percentage-description"
                                  className="mt-1.5 text-[11px] leading-5 text-muted-foreground"
                                >
                                  可设置 50–90%。例如 80% 在普通模型下为
                                  160K，在 [1m] 模型下为 800K。
                                </p>
                              </>
                            )}
                            {autoCompactError && (
                              <p
                                id="agent-auto-compact-percentage-error"
                                role="alert"
                                className="mt-1 text-xs text-destructive"
                              >
                                {autoCompactError}
                              </p>
                            )}
                          </div>
                        )}
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
                          <SelectTrigger aria-label="工具与扩展能力边界">
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
                              严格只读（在只读基础上禁用 WebSearch / WebFetch）
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
                  </section>
                  {!draftMode && selected && (
                    <EffectiveCapabilitiesPreview
                      profileId={selected.id}
                      runtimePolicy={currentRuntimePolicy}
                      workspaces={governance?.workspaces ?? []}
                    />
                  )}
                  {!draftMode && selected && (
                    <AgentGovernanceSection
                      selected={selected}
                      profiles={profiles}
                      governance={governance}
                      busy={governanceBusy}
                      error={governanceError}
                      workspaceMoveTargets={workspaceMoveTargets}
                      movingWorkspaceJid={movingWorkspaceJid}
                      onRefresh={() => void loadProfileGovernance(selected.id)}
                      onMoveTargetChange={(workspaceJid, targetProfileId) =>
                        setWorkspaceMoveTargets((current) => ({
                          ...current,
                          [workspaceJid]: targetProfileId,
                        }))
                      }
                      onMoveWorkspace={(workspaceJid, targetProfileId) =>
                        void handleMoveWorkspace(workspaceJid, targetProfileId)
                      }
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                  <div className="mr-auto text-xs text-muted-foreground">
                    {draftMode
                      ? '完成配置后创建 Agent'
                      : dirty
                        ? '有未保存的修改'
                        : '所有更改已保存'}
                  </div>
                  {draftMode ? (
                    <>
                      <Button
                        onClick={handleCreate}
                        disabled={
                          creating || !name.trim() || !!autoCompactError
                        }
                      >
                        {creating ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        创建 Agent
                      </Button>
                      <Button variant="outline" onClick={handleDiscardDraft}>
                        <X className="h-4 w-4" />
                        放弃草稿
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        onClick={handleSave}
                        disabled={
                          !dirty || saving || !name.trim() || !!autoCompactError
                        }
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
                        disabled={!selected || selected.is_default || deleting}
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
        </div>
      </main>

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
              Agent；渠道绑定会随工作区归属一起更新。
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
                        {profile.is_default ? '主 Agent' : profile.name}
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
