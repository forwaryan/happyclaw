import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Loader2,
  Link2,
  Unlink,
  MessageSquare,
  Users,
  ArrowRightLeft,
  Info,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useChatStore } from '../../stores/chat';
import { showToast } from '../../utils/toast';
import type { AgentInfo, AvailableImGroup } from '../../types';
import { ChannelBadge } from '../settings/channel-meta';
import { ACTIVATION_MODE_OPTIONS } from '../../constants/im';
import {
  getImChannelCapabilities,
  IM_CHANNEL_ORDER,
  type ImChannelType,
} from '../../constants/im-capabilities';

interface ImBindingDialogProps {
  open: boolean;
  groupJid: string;
  /** session id for workspace-session binding; null for main session binding */
  agentId: string | null;
  agent?: AgentInfo;
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
  onClose,
}: ImBindingDialogProps) {
  const [imGroups, setImGroups] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
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
    void loadGroupsForDialog();
  }, [open, groupJid, agentId, loadGroupsForDialog]);

  const channelFilters: { key: ChannelFilter; label: string; count: number }[] =
    useMemo(() => {
      const counts = new Map<string, number>();
      for (const group of imGroups) {
        counts.set(
          group.channel_type,
          (counts.get(group.channel_type) ?? 0) + 1,
        );
      }
      return [
        { key: 'all', label: '全部', count: imGroups.length },
        ...IM_CHANNEL_ORDER.map((type) => ({
          key: type,
          label: getImChannelCapabilities(type)?.label ?? type,
          count: counts.get(type) ?? 0,
        })),
      ];
    }, [imGroups]);

  const selectedChannelLabel =
    channelFilter === 'all'
      ? null
      : (getImChannelCapabilities(channelFilter)?.label ?? channelFilter);

  const filteredGroups = useMemo(() => {
    let groups = imGroups;
    if (channelFilter !== 'all') {
      groups = groups.filter((g) => g.channel_type === channelFilter);
    }
    if (!filter.trim()) return groups;
    const q = filter.trim().toLowerCase();
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q),
    );
  }, [imGroups, channelFilter, filter]);

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

  const handleUnbind = async (imJid: string) => {
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
        showToast('解绑失败');
      }
    } catch {
      showToast('解绑失败');
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
      return `工作区「${group.bound_target_name} / 主会话」`;
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

  const title = isMainMode
    ? '绑定消息渠道 — 工作区'
    : `绑定消息渠道${agent ? ` — ${agent.name}` : ' — 当前会话'}`;

  const renderThreadCapability = (group: AvailableImGroup) => {
    if (!group.is_thread_capable) return null;
    return (
      <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300">
        话题群
      </span>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              {title}
            </DialogTitle>
          </DialogHeader>

          {isMainMode && (
            <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              支持绑定飞书、Telegram、QQ、微信、钉钉、Discord、WhatsApp。具备话题能力的渠道绑定到工作区后，会按话题自动映射独立会话。
            </div>
          )}

          {!loading && !loadError && (
            <div className="space-y-2">
              <div className="flex items-center gap-1 flex-wrap">
                {channelFilters.map((ch) => (
                  <button
                    key={ch.key}
                    onClick={() => setChannelFilter(ch.key)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${
                      channelFilter === ch.key
                        ? 'bg-primary text-white'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                    }`}
                  >
                    {ch.label}
                    <span
                      className={`ml-1 ${channelFilter === ch.key ? 'text-white/80' : 'text-muted-foreground/70'}`}
                    >
                      {ch.count}
                    </span>
                  </button>
                ))}
              </div>
              {imGroups.length > 0 && (
                <SearchInput
                  value={filter}
                  onChange={setFilter}
                  placeholder="搜索群组..."
                  debounce={150}
                />
              )}
            </div>
          )}

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                加载中...
              </div>
            )}

            {!loading && loadError && (
              <div className="space-y-3 py-8 text-center">
                <div className="text-sm text-error">
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

            {!loading && !loadError && imGroups.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                暂无可绑定的消息通道。请先完成对应渠道配置，并在飞书、Telegram、QQ、微信、钉钉、Discord
                或 WhatsApp 中向 Bot 发送消息。
                <br />
                <span className="text-xs opacity-70">
                  普通群和私聊可绑定到会话；具备话题能力的渠道绑定到工作区后按话题自动分会话。
                </span>
              </div>
            )}

            {!loading &&
              !loadError &&
              imGroups.length > 0 &&
              filteredGroups.length === 0 && (
                <div className="text-center py-6 text-muted-foreground text-sm">
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
                const cannotBindToSession =
                  !isMainMode && !!group.is_thread_capable;
                const supportsActivation =
                  isMainMode && supportsActivationModes(group.channel_type);
                const effectiveMode = (activationModes[group.jid] ||
                  group.activation_mode ||
                  'auto') as string;

                return (
                  <div
                    key={group.jid}
                    className={`flex items-center gap-3 p-3 rounded-lg border ${
                      boundToThis
                        ? 'border-primary/30 bg-brand-50/50 dark:bg-brand-700/10'
                        : boundToOther
                          ? 'border-amber-200/50 dark:border-amber-800/30'
                          : 'border-border hover:border-border/80'
                    }`}
                  >
                    {/* Group avatar */}
                    {group.avatar ? (
                      <img
                        src={group.avatar}
                        alt=""
                        className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-muted flex items-center justify-center">
                        <MessageSquare className="w-5 h-5 text-muted-foreground" />
                      </div>
                    )}

                    {/* Group info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium truncate">
                          {group.name}
                        </div>
                        {renderThreadCapability(group)}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <ChannelBadge channelType={group.channel_type} />
                        {group.member_count != null && (
                          <span className="flex items-center gap-0.5">
                            <Users className="w-3 h-3" />
                            {group.member_count}
                          </span>
                        )}
                        {boundToOther && (
                          <span className="text-amber-500 truncate">
                            已绑定
                            {(group.bound_session_id ?? group.bound_agent_id)
                              ? '会话'
                              : '主会话'}
                            {group.bound_target_name &&
                              `「${
                                group.bound_workspace_name &&
                                group.bound_workspace_name !==
                                  group.bound_target_name
                                  ? `${group.bound_workspace_name} / ${group.bound_target_name}`
                                  : group.bound_target_name
                              }」`}
                          </span>
                        )}
                      </div>
                      {cannotBindToSession && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          该渠道会按话题自动映射会话，只能绑定到工作区。
                        </div>
                      )}
                    </div>

                    {/* Activation mode selector — only for main-mode channels that support trigger modes. */}
                    {supportsActivation && !boundToThis && !boundToOther && (
                      <div className="flex-shrink-0 flex flex-col items-end gap-1">
                        <select
                          value={activationModes[group.jid] || 'auto'}
                          onChange={(e) =>
                            setActivationModes((prev) => ({
                              ...prev,
                              [group.jid]: e.target.value,
                            }))
                          }
                          className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground"
                        >
                          {ACTIVATION_MODE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {effectiveMode === 'owner_mentioned' && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-0.5 max-w-[140px] leading-tight">
                            <Info className="w-3 h-3 flex-shrink-0 mt-px" />
                            绑定后需在群里发 /owner_mention 注册身份
                          </span>
                        )}
                        {effectiveMode === 'auto' && (
                          <span className="text-[10px] text-muted-foreground flex items-start gap-0.5 max-w-[140px] leading-tight">
                            兼容旧版设置，按需响应消息
                          </span>
                        )}
                      </div>
                    )}

                    {/* Action button — three states: unbind / rebind / bind */}
                    {boundToThis ? (
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        {supportsActivation && (
                          <div className="flex items-center gap-1.5">
                            <select
                              value={effectiveMode}
                              onChange={(e) =>
                                handleActivationModeChange(
                                  group.jid,
                                  e.target.value,
                                )
                              }
                              className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground"
                            >
                              {ACTIVATION_MODE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {supportsActivation &&
                          effectiveMode === 'owner_mentioned' &&
                          !group.owner_im_id && (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-0.5 max-w-[140px] leading-tight">
                              <Info className="w-3 h-3 flex-shrink-0 mt-px" />
                              请在群里发 /owner_mention 注册身份
                            </span>
                          )}
                        {supportsActivation && effectiveMode === 'auto' && (
                          <span className="text-[10px] text-muted-foreground flex items-start gap-0.5 max-w-[140px] leading-tight">
                            兼容旧版设置，按需响应消息
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleUnbind(group.jid)}
                          disabled={isActioning}
                        >
                          {isActioning ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Unlink className="w-3 h-3 mr-1" />
                          )}
                          解绑
                        </Button>
                      </div>
                    ) : boundToOther ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setRebindTarget({ imJid: group.jid, group })
                        }
                        disabled={isActioning}
                        className="flex-shrink-0 text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-950/30"
                      >
                        {isActioning ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <ArrowRightLeft className="w-3 h-3 mr-1" />
                        )}
                        换绑
                      </Button>
                    ) : cannotBindToSession ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        className="flex-shrink-0"
                      >
                        仅工作区绑定
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleBind(group.jid)}
                        disabled={isActioning}
                        className="flex-shrink-0"
                      >
                        {isActioning ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Link2 className="w-3 h-3 mr-1" />
                        )}
                        绑定
                      </Button>
                    )}
                  </div>
                );
              })}
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
            ? `该通道当前已绑定到${describeBindTarget(rebindTarget.group)}，确认换绑到当前${isMainMode ? '主会话' : '会话'}吗？`
            : ''
        }
        confirmText="换绑"
      />
    </>
  );
}
