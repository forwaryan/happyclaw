import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Loader2,
  Link2,
  RotateCcw,
  MessageSquare,
  Users,
  ArrowRightLeft,
  Info,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useChatStore } from '../../stores/chat';
import { showToast } from '../../utils/toast';
import type { AgentInfo, AvailableImGroup } from '../../types';
import { ChannelAccountBadge, ChannelBadge } from '../settings/channel-meta';
import { ACTIVATION_MODE_OPTIONS } from '../../constants/im';
import {
  getImChannelCapabilities,
  IM_CHANNEL_ORDER,
  type ImChannelType,
} from '../../constants/im-capabilities';
import {
  buildChannelAccountFilterOptions,
  channelAccountKey,
} from '../../utils/channel-accounts';

interface ImBindingDialogProps {
  open: boolean;
  groupJid: string;
  /** session id for workspace-session binding; null for main session binding */
  agentId: string | null;
  agent?: AgentInfo;
  targetMode?: 'workspace' | 'session';
  onClose: () => void;
}

type ChannelFilter = 'all' | ImChannelType;

function supportsActivationModes(
  channelType: string | null | undefined,
): boolean {
  return (
    getImChannelCapabilities(channelType)?.supports_activation_modes === true
  );
}

export function ImBindingDialog({
  open,
  groupJid,
  agentId,
  agent,
  targetMode = 'session',
  onClose,
}: ImBindingDialogProps) {
  const [imGroups, setImGroups] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [rebindTarget, setRebindTarget] = useState<{
    imJid: string;
    group: AvailableImGroup;
  } | null>(null);
  const [activationModes, setActivationModes] = useState<
    Record<string, string>
  >({});

  const loadAvailableImGroups = useChatStore((s) => s.loadAvailableImGroups);
  const bindImGroup = useChatStore((s) => s.bindImGroup);
  const unbindImGroup = useChatStore((s) => s.unbindImGroup);
  const bindMainImGroup = useChatStore((s) => s.bindMainImGroup);
  const unbindMainImGroup = useChatStore((s) => s.unbindMainImGroup);

  const isMainMode = agentId === null;
  const isWorkspaceMode = targetMode === 'workspace';

  const compatibleGroups = useMemo(
    () =>
      imGroups.filter((group) => {
        const capabilities = getImChannelCapabilities(group.channel_type);
        return isWorkspaceMode
          ? capabilities?.can_bind_workspace === true
          : capabilities?.can_bind_session === true && !group.is_thread_capable;
      }),
    [imGroups, isWorkspaceMode],
  );

  const loadGroupsForDialog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const groups = await loadAvailableImGroups(groupJid);
      setImGroups(groups);
      const initial: Record<string, string> = {};
      for (const group of groups) {
        if (
          supportsActivationModes(group.channel_type) &&
          group.activation_mode &&
          group.activation_mode !== 'auto'
        ) {
          initial[group.jid] = group.activation_mode;
        }
      }
      setActivationModes(initial);
    } catch (err) {
      setImGroups([]);
      setLoadError(err instanceof Error ? err.message : '消息渠道加载失败');
    } finally {
      setLoading(false);
    }
  }, [groupJid, loadAvailableImGroups]);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setActionLoading(null);
      setFilter('');
      setChannelFilter('all');
      setAccountFilter('all');
      setRebindTarget(null);
      setActivationModes({});
      setLoadError(null);
      return;
    }

    setActionLoading(null);
    setRebindTarget(null);
    setActivationModes({});
    setFilter('');
    setChannelFilter('all');
    setAccountFilter('all');
    void loadGroupsForDialog();
  }, [open, groupJid, agentId, loadGroupsForDialog]);

  const channelFilters: { key: ChannelFilter; label: string; count: number }[] =
    useMemo(() => {
      const counts = new Map<string, number>();
      for (const group of compatibleGroups) {
        counts.set(
          group.channel_type,
          (counts.get(group.channel_type) ?? 0) + 1,
        );
      }
      return [
        { key: 'all', label: '全部', count: compatibleGroups.length },
        ...IM_CHANNEL_ORDER.map((type) => ({
          key: type,
          label: getImChannelCapabilities(type)?.label ?? type,
          count: counts.get(type) ?? 0,
        })).filter((item) => item.count > 0),
      ];
    }, [compatibleGroups]);

  const selectedChannelLabel =
    channelFilter === 'all'
      ? null
      : (getImChannelCapabilities(channelFilter)?.label ?? channelFilter);
  const accountOptions = useMemo(
    () => buildChannelAccountFilterOptions(compatibleGroups),
    [compatibleGroups],
  );

  const filteredGroups = useMemo(() => {
    let groups = compatibleGroups;
    if (accountFilter !== 'all') {
      groups = groups.filter(
        (group) => channelAccountKey(group) === accountFilter,
      );
    }
    if (channelFilter !== 'all') {
      groups = groups.filter((g) => g.channel_type === channelFilter);
    }
    if (!filter.trim()) return groups;
    const q = filter.trim().toLowerCase();
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q),
    );
  }, [accountFilter, compatibleGroups, channelFilter, filter]);

  const isBoundToThis = (group: AvailableImGroup): boolean => {
    if (isMainMode) {
      return (group.bound_workspace_jid ?? group.bound_main_jid) === groupJid;
    }
    return (group.bound_session_id ?? group.bound_agent_id) === agentId;
  };

  const isBoundToOther = (group: AvailableImGroup): boolean => {
    if (isBoundToThis(group)) return false;
    return (
      !!(group.bound_session_id ?? group.bound_agent_id) ||
      !!(group.bound_workspace_jid ?? group.bound_main_jid)
    );
  };

  const reloadGroups = async () => {
    try {
      const groups = await loadAvailableImGroups(groupJid);
      setImGroups(groups);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '消息渠道刷新失败');
      showToast('刷新失败', '消息渠道列表可能已过期');
    }
  };

  const handleBind = async (imJid: string) => {
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        const target = imGroups.find((g) => g.jid === imJid);
        const mode = supportsActivationModes(target?.channel_type)
          ? activationModes[imJid] || 'auto'
          : undefined;
        ok = await bindMainImGroup(groupJid, imJid, false, mode);
      } else {
        ok = await bindImGroup(groupJid, agentId, imJid);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('绑定失败');
      }
    } catch {
      showToast('绑定失败');
    }
    setActionLoading(null);
  };

  const handleRestoreDefault = async (imJid: string) => {
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        ok = await unbindMainImGroup(groupJid, imJid);
      } else {
        ok = await unbindImGroup(groupJid, agentId!, imJid);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('恢复默认工作区失败');
      }
    } catch {
      showToast('恢复默认工作区失败');
    }
    setActionLoading(null);
  };

  const handleActivationModeChange = useCallback(
    async (imJid: string, mode: string) => {
      setActivationModes((prev) => ({ ...prev, [imJid]: mode }));
      // Re-bind with force to update activation_mode on already-bound group
      try {
        await bindMainImGroup(groupJid, imJid, true, mode);
        await reloadGroups();
      } catch {
        showToast('更新触发模式失败');
      }
    },
    [groupJid, bindMainImGroup],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const describeBindTarget = (group: AvailableImGroup): string => {
    if (
      (group.bound_session_id ?? group.bound_agent_id) &&
      group.bound_target_name
    ) {
      return group.bound_workspace_name &&
        group.bound_workspace_name !== group.bound_target_name
        ? `会话「${group.bound_workspace_name} / ${group.bound_target_name}」`
        : `会话「${group.bound_target_name}」`;
    }
    if (group.bound_main_jid && group.bound_target_name) {
      return `工作区「${group.bound_target_name}」`;
    }
    return '其他对话';
  };

  const confirmRebind = async () => {
    if (!rebindTarget) return;
    const { imJid, group: rebindGroup } = rebindTarget;
    setRebindTarget(null);
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isMainMode) {
        const mode = supportsActivationModes(rebindGroup.channel_type)
          ? activationModes[imJid] || 'auto'
          : undefined;
        ok = await bindMainImGroup(groupJid, imJid, true, mode);
      } else {
        ok = await bindImGroup(groupJid, agentId!, imJid, true);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('换绑失败');
      }
    } catch {
      showToast('换绑失败');
    }
    setActionLoading(null);
  };

  const title = isWorkspaceMode
    ? '工作区绑定'
    : `会话绑定${agent ? ` — ${agent.name}` : ' — 主会话'}`;

  const renderThreadCapability = (group: AvailableImGroup) => {
    if (!group.is_thread_capable) return null;
    return (
      <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        原生话题
      </span>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-1rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        >
          <DialogHeader className="border-b border-border/70 px-4 pb-4 pt-5 pr-12 sm:px-5 sm:pr-12">
            <DialogTitle className="flex items-center gap-2.5 text-base font-semibold leading-6">
              <MessageSquare className="size-4.5 text-primary" />
              {title}
            </DialogTitle>
            <DialogDescription className="flex items-start gap-2 text-left text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {isWorkspaceMode
                  ? '普通聊天进入工作区主会话；原生话题会自动创建独立会话。'
                  : '绑定后，普通群聊或私聊会继续使用当前会话上下文。'}
              </span>
            </DialogDescription>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-2 top-2"
              >
                <X className="size-4" />
                <span className="sr-only">关闭</span>
              </Button>
            </DialogClose>
          </DialogHeader>

          <div className="min-h-0 space-y-4 p-4 sm:p-5">
            {!loading && !loadError && compatibleGroups.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div
                    role="group"
                    aria-label="按渠道筛选"
                    className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 pb-1"
                  >
                    {channelFilters.map((ch) => {
                      const selected = channelFilter === ch.key;
                      return (
                        <button
                          key={ch.key}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setChannelFilter(ch.key)}
                          className={`flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                            selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border/70 bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                          }`}
                        >
                          <span>{ch.label}</span>
                          <span
                            className={
                              selected
                                ? 'text-primary-foreground/75'
                                : 'text-muted-foreground/70'
                            }
                          >
                            {ch.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {filteredGroups.length} 个聊天
                  </span>
                </div>

                <div
                  className={`grid gap-2 ${
                    accountOptions.length > 1
                      ? 'sm:grid-cols-[minmax(0,1fr)_auto]'
                      : ''
                  }`}
                >
                  <SearchInput
                    value={filter}
                    onChange={setFilter}
                    placeholder="搜索名称或群组 ID"
                    ariaLabel="搜索渠道聊天"
                    debounce={150}
                  />
                  {accountOptions.length > 1 && (
                    <select
                      value={accountFilter}
                      onChange={(event) => setAccountFilter(event.target.value)}
                      aria-label="筛选 Bot 账号"
                      className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <option value="all">全部 Bot 账号</option>
                      {accountOptions.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            <div
              className="max-h-[min(58dvh,32rem)] space-y-2 overflow-y-auto overscroll-contain pr-1"
              aria-live="polite"
            >
              {loading && (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  正在加载渠道聊天…
                </div>
              )}

              {!loading && loadError && (
                <div className="space-y-3 py-8 text-center">
                  <div className="text-sm text-error" role="alert">
                    消息渠道加载失败：{loadError}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadGroupsForDialog()}
                  >
                    重试
                  </Button>
                </div>
              )}

              {!loading && !loadError && compatibleGroups.length === 0 && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {isWorkspaceMode
                    ? '暂无可绑定的渠道聊天。请先完成渠道接入，并向 Bot 发送一条消息。'
                    : '暂无可绑定的普通群或私聊。请先在对应渠道中向 Bot 发送一条消息。'}
                </div>
              )}

              {!loading &&
                !loadError &&
                compatibleGroups.length > 0 &&
                filteredGroups.length === 0 && (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    {selectedChannelLabel && !filter.trim()
                      ? `暂无 ${selectedChannelLabel} 可绑定渠道。请先完成该渠道配置，并向 Bot 发送一条消息。`
                      : '没有匹配的群组'}
                  </div>
                )}

              {!loading &&
                !loadError &&
                filteredGroups.map((group) => {
                  const boundToThis = isBoundToThis(group);
                  const boundToOther = isBoundToOther(group);
                  const isActioning = actionLoading === group.jid;
                  const supportsActivation =
                    isMainMode && supportsActivationModes(group.channel_type);
                  const effectiveMode = (activationModes[group.jid] ||
                    group.activation_mode ||
                    'auto') as string;

                  return (
                    <article
                      key={group.jid}
                      className={`grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 rounded-xl border p-3 transition-colors sm:grid-cols-[2.75rem_minmax(0,1fr)_auto] sm:items-center sm:p-4 ${
                        boundToThis
                          ? 'border-primary/35 bg-primary/[0.045]'
                          : boundToOther
                            ? 'border-amber-300/60 bg-amber-50/35 dark:border-amber-800/50 dark:bg-amber-950/10'
                            : 'border-border/80 bg-background hover:border-foreground/20'
                      }`}
                    >
                      {/* Group avatar */}
                      {group.avatar ? (
                        <img
                          src={group.avatar}
                          alt=""
                          className="size-11 shrink-0 rounded-xl object-cover"
                        />
                      ) : (
                        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted">
                          <MessageSquare className="size-5 text-muted-foreground" />
                        </div>
                      )}

                      {/* Group info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <div className="min-w-0 truncate text-sm font-semibold">
                            {group.name}
                          </div>
                          {renderThreadCapability(group)}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <ChannelBadge channelType={group.channel_type} />
                          <ChannelAccountBadge
                            accountId={group.channel_account_id}
                            accountName={group.channel_account_name}
                          />
                          {group.member_count != null &&
                            group.member_count > 0 && (
                              <span className="flex items-center gap-0.5">
                                <Users className="w-3 h-3" />
                                {group.member_count}
                              </span>
                            )}
                        </div>
                        {boundToThis && (
                          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            <Link2 className="size-3" />
                            已绑定当前{isWorkspaceMode ? '工作区' : '会话'}
                          </div>
                        )}
                        {boundToOther && (
                          <div className="mt-2 flex min-w-0 items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            <ArrowRightLeft className="size-3 shrink-0" />
                            <span className="truncate">
                              已绑定至{describeBindTarget(group)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Activation mode selector — only for main-mode channels that support trigger modes. */}
                      {supportsActivation && !boundToThis && !boundToOther && (
                        <div className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:min-w-64">
                          <div className="grid gap-2 min-[460px]:grid-cols-[minmax(0,1fr)_auto]">
                            <div className="min-w-0">
                              <label
                                htmlFor={`activation-${group.jid}`}
                                className="sr-only"
                              >
                                {group.name} 的消息触发策略
                              </label>
                              <select
                                id={`activation-${group.jid}`}
                                value={activationModes[group.jid] || 'auto'}
                                onChange={(e) =>
                                  setActivationModes((prev) => ({
                                    ...prev,
                                    [group.jid]: e.target.value,
                                  }))
                                }
                                className="h-9 w-full min-w-0 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                              >
                                {ACTIVATION_MODE_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              {effectiveMode === 'owner_mentioned' && (
                                <span className="mt-1 flex items-start gap-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                                  <Info className="mt-0.5 size-3 shrink-0" />
                                  绑定后在群里发送 /owner_mention
                                </span>
                              )}
                            </div>
                            <Button
                              onClick={() => handleBind(group.jid)}
                              disabled={isActioning}
                              className="h-9 min-w-20"
                            >
                              {isActioning ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Link2 className="size-3.5" />
                              )}
                              绑定
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Action button — three states: unbind / rebind / bind */}
                      {boundToThis ? (
                        <div className="col-span-2 flex w-full flex-col items-stretch gap-2 min-[460px]:flex-row min-[460px]:items-start sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:w-auto sm:min-w-64">
                          {supportsActivation && (
                            <div className="min-w-0 flex-1">
                              <label
                                htmlFor={`activation-${group.jid}`}
                                className="sr-only"
                              >
                                {group.name} 的消息触发策略
                              </label>
                              <select
                                id={`activation-${group.jid}`}
                                value={effectiveMode}
                                onChange={(e) =>
                                  handleActivationModeChange(
                                    group.jid,
                                    e.target.value,
                                  )
                                }
                                aria-label={`${group.name} 的消息触发策略`}
                                className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                              >
                                {ACTIVATION_MODE_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              {effectiveMode === 'owner_mentioned' &&
                                !group.owner_im_id && (
                                  <span className="mt-1 flex items-start gap-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300">
                                    <Info className="mt-0.5 size-3 shrink-0" />
                                    请在群里发 /owner_mention 注册身份
                                  </span>
                                )}
                            </div>
                          )}
                          <Button
                            variant="outline"
                            onClick={() => handleRestoreDefault(group.jid)}
                            disabled={isActioning}
                            className="h-9 min-w-24"
                          >
                            {isActioning ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="size-3.5" />
                            )}
                            恢复默认
                          </Button>
                        </div>
                      ) : boundToOther ? (
                        <Button
                          variant="outline"
                          onClick={() =>
                            setRebindTarget({ imJid: group.jid, group })
                          }
                          disabled={isActioning}
                          className="col-span-2 h-9 w-full min-w-20 border-amber-300 text-amber-700 hover:bg-amber-50 min-[460px]:w-auto sm:col-span-1 sm:col-start-3 sm:row-start-1 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/30"
                        >
                          {isActioning ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <ArrowRightLeft className="size-3.5" />
                          )}
                          换绑
                        </Button>
                      ) : supportsActivation ? null : (
                        <Button
                          onClick={() => handleBind(group.jid)}
                          disabled={isActioning}
                          className="col-span-2 h-9 w-full min-w-20 min-[460px]:w-auto sm:col-span-1 sm:col-start-3 sm:row-start-1"
                        >
                          {isActioning ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Link2 className="size-3.5" />
                          )}
                          绑定
                        </Button>
                      )}
                    </article>
                  );
                })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!rebindTarget}
        onClose={() => setRebindTarget(null)}
        onConfirm={confirmRebind}
        title="确认换绑"
        message={
          rebindTarget
            ? `该渠道当前已绑定到${describeBindTarget(rebindTarget.group)}，确认换绑到当前${isWorkspaceMode ? '工作区' : '会话'}吗？`
            : ''
        }
        confirmText="换绑"
      />
    </>
  );
}
