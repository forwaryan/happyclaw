import { Link, Loader2, MessageSquare, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentInfo } from '../../types';

interface SessionSidebarProps {
  sessions: AgentInfo[];
  activeSessionId: string | null;
  canModify?: boolean;
  isTopicWorkspace?: boolean;
  filter?: string;
  onFilterChange?: (value: string) => void;
  onSelectSession: (id: string | null) => void;
  onCreateSession?: () => void;
  onRenameSession?: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  onBindSession?: (id: string) => void;
  onBindMain?: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  canModify = false,
  isTopicWorkspace = false,
  filter = '',
  onFilterChange,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onBindSession,
  onBindMain,
}: SessionSidebarProps) {
  return (
    <div data-hc-session-sidebar className="flex h-full min-h-0 w-full flex-col bg-transparent">
      <div className="border-b border-border/80 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground">会话</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">上下文隔离</div>
          </div>
          {canModify && !isTopicWorkspace && onCreateSession && (
            <button
              onClick={onCreateSession}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="新建会话"
              aria-label="新建会话"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        {isTopicWorkspace && onFilterChange && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
              placeholder="搜索话题"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {canModify && onBindMain && (
          <button
            onClick={onBindMain}
            className="mb-2 flex w-full items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/80 px-3 py-2 text-left text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-brand-700/50 dark:bg-brand-700/10 dark:text-brand-300 dark:hover:bg-brand-700/20 cursor-pointer"
            title="绑定消息渠道到这个工作区"
            aria-label="绑定消息渠道到这个工作区"
          >
            <Link className="h-4 w-4 shrink-0" />
            <span className="min-w-0">
              <span className="block text-[12px] font-semibold leading-4">
                工作区消息渠道
              </span>
              <span className="block truncate text-[11px] leading-4 text-brand-600/80 dark:text-brand-300/80">
                绑定飞书、Telegram 等群聊
              </span>
            </span>
          </button>
        )}

        <SessionRow
          name="主会话"
          active={activeSessionId === null}
          isMain
          canModify={canModify}
          onSelect={() => onSelectSession(null)}
          onBind={onBindMain}
        />

        {sessions.length === 0 ? (
          <div className="px-2.5 pt-2 text-[11px] leading-5 text-muted-foreground">
            {isTopicWorkspace ? '暂无话题会话' : '暂无其他会话'}
          </div>
        ) : (
          <div className="mt-1 space-y-0.5">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                name={session.name}
                active={activeSessionId === session.id}
                running={session.status === 'running'}
                titleGenerating={session.title_generating}
                linkedCount={session.linked_im_groups?.length ?? 0}
                canModify={canModify}
                readonlyTitle={session.source_kind === 'feishu_thread'}
                onSelect={() => onSelectSession(session.id)}
                onBind={onBindSession ? () => onBindSession(session.id) : undefined}
                onRename={
                  onRenameSession && session.source_kind !== 'feishu_thread'
                    ? () => onRenameSession(session.id, session.name)
                    : undefined
                }
                onDelete={() => onDeleteSession(session.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  name,
  active,
  isMain = false,
  running = false,
  titleGenerating = false,
  linkedCount = 0,
  canModify,
  readonlyTitle = false,
  onSelect,
  onBind,
  onRename,
  onDelete,
}: {
  name: string;
  active: boolean;
  isMain?: boolean;
  running?: boolean;
  titleGenerating?: boolean;
  linkedCount?: number;
  canModify: boolean;
  readonlyTitle?: boolean;
  onSelect: () => void;
  onBind?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        'group flex min-h-10 items-center gap-1 rounded-lg border transition-colors',
        active
          ? 'border-primary/15 bg-primary/10 text-primary'
          : 'border-transparent text-foreground hover:border-border/70 hover:bg-muted/70',
      )}
    >
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        {titleGenerating ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-500" />
        ) : running ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-teal-500" />
        ) : linkedCount > 0 ? (
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-teal-600" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-border" />
        )}
        <span className={cn('truncate', active && 'font-medium')}>{name}</span>
      </button>
      {canModify && (
        <div className="mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onBind && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onBind();
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="绑定消息渠道"
              aria-label="绑定消息渠道"
            >
              <Link className="h-3.5 w-3.5" />
            </button>
          )}
          {!isMain && !readonlyTitle && onRename && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="重命名"
              aria-label="重命名"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {!isMain && onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="删除"
              aria-label="删除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
