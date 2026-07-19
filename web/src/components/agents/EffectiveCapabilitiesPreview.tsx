import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { api } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  AgentCapabilityPreview,
  AgentProfileRuntimePolicy,
  AgentProfileWorkspace,
  EffectiveCapabilityEntry,
} from '@/types';
import { capabilitySourceLabel } from '@/utils/capability-sources';

export function EffectiveCapabilitiesPreview({
  profileId,
  runtimePolicy,
  workspaces,
}: {
  profileId: string;
  runtimePolicy: AgentProfileRuntimePolicy;
  workspaces: AgentProfileWorkspace[];
}) {
  const [workspaceJid, setWorkspaceJid] = useState('none');
  const [preview, setPreview] = useState<AgentCapabilityPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const policyKey = useMemo(
    () => JSON.stringify(runtimePolicy),
    [runtimePolicy],
  );

  useEffect(() => {
    if (
      workspaceJid !== 'none' &&
      !workspaces.some((item) => item.jid === workspaceJid)
    ) {
      setWorkspaceJid('none');
    }
  }, [workspaceJid, workspaces]);

  const loadPreview = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<{ preview: AgentCapabilityPreview }>(
        `/api/agent-profiles/${encodeURIComponent(profileId)}/effective-capabilities`,
        {
          runtime_policy: runtimePolicy,
          workspace_jid: workspaceJid === 'none' ? undefined : workspaceJid,
        },
      );
      if (sequence === requestSequence.current) setPreview(result.preview);
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(
          cause instanceof Error ? cause.message : '无法计算最终生效能力',
        );
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [profileId, runtimePolicy, workspaceJid]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPreview(), 250);
    return () => window.clearTimeout(timer);
  }, [loadPreview, policyKey]);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            最终生效能力
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            按实际运行顺序展示宿主机自动继承、项目上下文和 HappyClaw
            附加能力，并标出同名来源冲突。系统内置能力始终生效，不进入用户选择器。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={workspaceJid} onValueChange={setWorkspaceJid}>
            <SelectTrigger className="h-9 w-[190px]" aria-label="预览工作区">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不指定工作区</SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.jid} value={workspace.jid}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void loadPreview()}
            disabled={loading}
            aria-label="刷新最终生效能力"
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="px-5 py-4">
        {loading && !preview ? (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在计算
          </div>
        ) : error ? (
          <div
            className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
            role="alert"
          >
            <AlertTriangle className="size-4 shrink-0" />
            {error}
          </div>
        ) : preview ? (
          <div className="divide-y divide-border">
            <PreviewRow label="上下文">
              <Badge variant="secondary">
                {preview.context.source === 'host_claude'
                  ? '宿主机 ~/.claude'
                  : 'HappyClaw 管理'}
              </Badge>
              {preview.context.source === 'host_claude' && (
                <span className="text-xs text-muted-foreground">
                  提示词 {preview.context.claudeMd ? '已加载' : '缺失'} ·{' '}
                  {preview.context.rules} 项 Rules · Skills 与 MCP 全部自动继承
                </span>
              )}
            </PreviewRow>
            <CapabilityEntriesRow
              label="Skills"
              entries={preview.skills.entries}
              conflicts={preview.skills.conflicts}
            />
            <CapabilityEntriesRow
              label="MCP"
              entries={preview.mcp.entries}
              conflicts={preview.mcp.conflicts}
              disabled={preview.mcp.disabledByToolBoundary}
            />
            <PreviewRow label="能力边界">
              <span className="text-sm text-foreground">
                {preview.tools.summary}
              </span>
            </PreviewRow>
            <div className="space-y-1 py-3">
              {preview.notes.map((note) => (
                <p
                  key={note}
                  className="text-[11px] leading-5 text-muted-foreground"
                >
                  {note}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PreviewRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[110px_1fr] sm:items-start">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

function CapabilityEntriesRow({
  label,
  entries,
  conflicts,
  disabled = false,
}: {
  label: string;
  entries: EffectiveCapabilityEntry[];
  conflicts: string[];
  disabled?: boolean;
}) {
  return (
    <PreviewRow label={label}>
      {entries.length === 0 ? (
        <span className="text-xs text-muted-foreground">无</span>
      ) : (
        <div className="flex max-h-28 min-w-0 flex-wrap gap-1.5 overflow-y-auto">
          {entries.map((entry) => (
            <Badge
              key={entry.id}
              variant="outline"
              className={
                disabled || !entry.available ? 'opacity-50 line-through' : ''
              }
              title={
                entry.overrides.length > 0
                  ? `覆盖：${entry.overrides.map(capabilitySourceLabel).join('、')}`
                  : undefined
              }
            >
              {entry.id} · {capabilitySourceLabel(entry.source)}
            </Badge>
          ))}
        </div>
      )}
      {conflicts.length > 0 && (
        <span className="basis-full text-[11px] text-warning">
          {conflicts.length} 个同名覆盖：{conflicts.join('、')}
        </span>
      )}
      {disabled && (
        <span className="basis-full text-[11px] text-warning">
          已被当前能力边界关闭
        </span>
      )}
    </PreviewRow>
  );
}
