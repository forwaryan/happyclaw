import { ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { getSystemSettings } from './runtime-config.js';
import {
  ContainerOutput,
  runContainerAgent,
  runHostAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  advanceSkippedTask,
  getAllTasks,
  cleanupOldTaskRunLogs,
  cleanupStaleRunningLogs,
  claimTaskForRun,
  deleteGroupData,
  getDueTasks,
  getSession,
  getTaskById,
  getUserById,
  getUserHomeGroup,
  getAgentProfileForWorkspace,
  getSessionAgentIdentity,
  logTaskRun,
  logTaskRunStart,
  updateTaskRunLog,
  pauseTaskAfterRun,
  setSession,
  deleteSession,
  deleteMessagesForChatJid,
  updateTaskAfterRun,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { removeFlowArtifacts } from './file-manager.js';
import { hasScriptCapacity, runScript } from './script-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import {
  AgentProfile,
  ExecutionMode,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';
import { checkBillingAccessFresh, isBillingEnabled } from './billing.js';
import { checkOwnerActive } from './owner-gate.js';
import {
  canExecuteOnHost,
  HOST_EXECUTION_FORBIDDEN_ERROR,
} from './host-execution-policy.js';
import { resolveEffectiveAgentProfile } from './agent-profile-runtime.js';
import { stripAgentInternalTags } from './utils.js';
import {
  markIsolatedTaskRunIpcComplete,
  tryCleanupCompletedIsolatedTaskRunIpc,
} from './isolated-task-ipc.js';

/**
 * Resolve the actual group JID to send a task to.
 * Falls back from the task's stored chat_jid to any group matching the same folder.
 */
function resolveTargetGroupJid(
  task: ScheduledTask,
  groups: Record<string, RegisteredGroup>,
): string {
  const directTarget = groups[task.chat_jid];
  if (directTarget && directTarget.folder === task.group_folder) {
    return task.chat_jid;
  }
  const sameFolder = Object.entries(groups).filter(
    ([, g]) => g.folder === task.group_folder,
  );
  const preferred =
    sameFolder.find(([jid]) => jid.startsWith('web:')) || sameFolder[0];
  return preferred?.[0] || '';
}

function resolveTaskExecutionMode(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): ExecutionMode {
  if (task.execution_mode === 'host' || task.execution_mode === 'container') {
    return task.execution_mode;
  }
  // Legacy fallback: inherit from the original group
  const groups = deps.registeredGroups();
  const group = groups[task.chat_jid];
  if (group) {
    if (!group.is_home) {
      const homeSibling = Object.values(groups).find(
        (g) => g.folder === group.folder && g.is_home,
      );
      if (homeSibling) return homeSibling.executionMode || 'container';
    }
    return group.executionMode || 'container';
  }
  return 'container';
}

function toRunnerAgentProfile(profile: AgentProfile | undefined) {
  profile = resolveEffectiveAgentProfile(profile);
  if (!profile) return undefined;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    identityHash: profile.identity_hash,
    identityPrompt: profile.identity_prompt,
    includeClaudePreset: profile.include_claude_preset,
    runtimePolicy: profile.runtime_policy,
  };
}

function taskSessionNeedsAgentProfileReset(
  groupFolder: string,
  profile: AgentProfile | undefined,
  sessionAgentId?: string | null,
): boolean {
  if (!profile) return false;
  const current = getSessionAgentIdentity(groupFolder, sessionAgentId);
  if (!current) return false;
  if (
    !current.agent_profile_id &&
    !current.identity_hash &&
    profile.identity_prompt.trim() === '' &&
    profile.include_claude_preset
  ) {
    return false;
  }
  if (current.identity_hash !== profile.identity_hash) return true;
  if (
    current.agent_profile_version != null &&
    current.agent_profile_version !== profile.version
  ) {
    return true;
  }
  return !!current.agent_profile_id && current.agent_profile_id !== profile.id;
}

function resolveTaskWorkspace(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): { jid: string; folder: string; group: RegisteredGroup } | null {
  const groups = deps.registeredGroups();
  const sameFolder = Object.entries(groups).filter(
    ([, g]) => g.folder === task.group_folder,
  );
  const preferred =
    sameFolder.find(([jid]) => jid.startsWith('web:')) ||
    (groups[task.chat_jid]
      ? ([task.chat_jid, groups[task.chat_jid]] as const)
      : undefined) ||
    sameFolder[0];
  if (!preferred) return null;
  const [jid, group] = preferred;
  return { jid, folder: group.folder, group };
}

function resolveTaskRunWorkspace(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): { jid: string; folder: string; group: RegisteredGroup } | null {
  if (options?.sourceWorkspaceJid && options.sourceWorkspaceFolder) {
    const group = deps.registeredGroups()[options.sourceWorkspaceJid];
    if (!group || group.folder !== options.sourceWorkspaceFolder) {
      logger.error(
        {
          taskId: task.id,
          workspaceJid: options.sourceWorkspaceJid,
          workspaceFolder: options.sourceWorkspaceFolder,
        },
        'Pinned task workspace disappeared before queued run started',
      );
      return null;
    }
    return {
      jid: options.sourceWorkspaceJid,
      folder: options.sourceWorkspaceFolder,
      group,
    };
  }
  return resolveTaskWorkspace(task, deps);
}

/**
 * Compute the queue JID for an isolated (non-group, non-script) task run.
 * The queue key is a virtual task chat under the source workspace. That keeps
 * scheduler execution out of the main session while still using the same
 * workspace directory and environment.
 *
 * Returns null when the source workspace cannot be resolved. The caller skips
 * the run and retries later instead of falling back to another workspace.
 */
function prepareIsolatedTaskRun(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  manualRun = false,
): { queueJid: string; options: RunTaskOptions } | null {
  const workspace = resolveTaskWorkspace(task, deps);
  if (!workspace) {
    logger.error(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
      },
      'Failed to resolve task workspace before enqueue; skipping this run (retries next tick)',
    );
    return null;
  }
  const taskRunId = createIsolatedTaskRunId(task.id);
  return {
    queueJid: `${workspace.jid}#task:${taskRunId}`,
    options: {
      taskRunId,
      manualRun,
      sourceWorkspaceJid: workspace.jid,
      sourceWorkspaceFolder: workspace.folder,
    },
  };
}

function createIsolatedTaskRunId(taskId: string): string {
  const safeTaskId = taskId
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `task-${safeTaskId || 'run'}-${randomUUID()}`;
}

function createTaskSessionAgentId(taskRunId: string): string {
  return `task-${taskRunId}`;
}

function cleanupIsolatedTaskRun(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): void {
  const taskRunId = options?.taskRunId;
  if (!taskRunId) return;

  // Only generated, Docker-safe identifiers may reach filesystem cleanup.
  // This guard prevents a future caller from turning RunTaskOptions into a
  // path traversal primitive.
  if (!/^[a-zA-Z0-9_-]+$/.test(taskRunId)) {
    logger.error(
      { taskId: task.id, taskRunId },
      'Refusing to clean unsafe isolated task run id',
    );
    return;
  }

  const resolvedWorkspace = resolveTaskRunWorkspace(task, deps, options);
  const workspace =
    resolvedWorkspace ??
    (options.sourceWorkspaceJid && options.sourceWorkspaceFolder
      ? {
          jid: options.sourceWorkspaceJid,
          folder: options.sourceWorkspaceFolder,
        }
      : null);
  if (!workspace) return;
  const sessionAgentId = createTaskSessionAgentId(taskRunId);
  const virtualChatJid = `${workspace.jid}#task:${taskRunId}`;

  const sessionPath = path.join(
    DATA_DIR,
    'sessions',
    workspace.folder,
    'agents',
    sessionAgentId,
  );
  const cleanupRuntimeArtifacts = () => {
    deleteSession(workspace.folder, sessionAgentId);
    deleteMessagesForChatJid(virtualChatJid);
    fs.rmSync(sessionPath, { recursive: true, force: true });
  };

  // send_message writes happen before the runner returns, but the host watcher
  // consumes them asynchronously.  Mark the producer complete and only remove
  // the IPC namespace when the watcher has ACKed every file by unlinking it.
  // If anything is still pending, leave the directory for the normal/startup
  // IPC scan; that scan performs the same cleanup once delivery succeeds.
  const ipcRunPath = path.join(
    DATA_DIR,
    'ipc',
    workspace.folder,
    'tasks-run',
    taskRunId,
  );
  try {
    markIsolatedTaskRunIpcComplete(ipcRunPath, {
      taskId: task.id,
      taskRunId,
      workspaceFolder: workspace.folder,
      virtualChatJid,
      sessionAgentId,
    });
    tryCleanupCompletedIsolatedTaskRunIpc(ipcRunPath, cleanupRuntimeArtifacts);
  } catch (err) {
    logger.warn(
      { taskId: task.id, taskRunId, runPath: ipcRunPath, err },
      'Failed to mark/clean completed isolated task IPC directory',
    );
  }
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string | null,
    groupFolder: string,
    displayName?: string,
    taskRunId?: string,
    selectedProviderId?: string | null,
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    options?: { source?: string },
  ) => Promise<string | undefined | void>;
  broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  onWorkspaceCreated?: (
    jid: string,
    folder: string,
    name: string,
    userId?: string,
  ) => void;
  /** Store task prompt as a user-visible message in the workspace chat */
  storePromptMessage?: (
    chatJid: string,
    senderId: string,
    senderName: string,
    text: string,
    taskId?: string,
  ) => void;
  /** Store task result in workspace chat and push to owner's IM channels */
  storeResultAndNotify?: (
    chatJid: string,
    text: string,
    options: {
      ownerId?: string;
      notifyChannels?: string[] | null;
      sourceKind?: ContainerOutput['sourceKind'];
      skipStore?: boolean;
      workspaceFolder?: string;
    },
  ) => Promise<void>;
  assistantName: string;
}

export interface RunTaskOptions {
  /** Unique ID for isolated task IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** Manual trigger — don't update next_run, skip isTaskStillActive check */
  manualRun?: boolean;
  /** Workspace pinned when this run entered GroupQueue. */
  sourceWorkspaceJid?: string;
  sourceWorkspaceFolder?: string;
}

const runningTaskIds = new Set<string>();
const pendingManualTaskIds = new Set<string>();
const pendingScheduledTaskIds = new Set<string>();

function isTaskReserved(taskId: string): boolean {
  return (
    runningTaskIds.has(taskId) ||
    pendingManualTaskIds.has(taskId) ||
    pendingScheduledTaskIds.has(taskId)
  );
}

export function getRunningTaskIds(): string[] {
  return [
    ...new Set([
      ...runningTaskIds,
      ...pendingManualTaskIds,
      ...pendingScheduledTaskIds,
    ]),
  ];
}

/**
 * Decide whether a due task is so overdue that we should skip this missed run
 * and advance to the next scheduled trigger instead. Prevents the
 * "restart-storm" failure mode where many tasks fire concurrently after a
 * long downtime. Exported for direct test coverage of the policy.
 */
export function shouldSkipBackfill(
  nextRunIso: string | null | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  if (graceMs <= 0 || !nextRunIso) return false;
  const overdueMs = nowMs - new Date(nextRunIso).getTime();
  return overdueMs > graceMs;
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = Number(task.schedule_value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const anchorRaw = task.next_run
      ? new Date(task.next_run).getTime()
      : Date.now();
    // 防御：损坏的 next_run（手工 SQL / 旧版宽松校验）会让 anchor=NaN，
    // 后续算术全变 NaN，最终 `new Date(NaN).toISOString()` 抛 RangeError，
    // 把任务永久卡死在 runningTaskIds。优雅 fallback 到 now。
    const anchor = Number.isFinite(anchorRaw) ? anchorRaw : Date.now();
    const now = Date.now();
    const elapsed = now - anchor;
    const periods = elapsed > 0 ? Math.ceil(elapsed / ms) : 1;
    const next = anchor + periods * ms;
    if (!Number.isFinite(next)) return null;
    return new Date(next).toISOString();
  }
  // 'once' tasks have no next run
  return null;
}

/**
 * 为「新建 / 修改任务」计算 next_run（now 为锚点）。与上面的 computeNextRun 不同：
 * 后者按 task.next_run 为锚点推进周期（调度循环用），这里是从当前时刻起算第一次触发
 * （创建/更新时用）。非法 schedule 抛错，由调用方决定如何回执。
 */
export function computeNextRunForSchedule(
  type: 'cron' | 'interval' | 'once',
  value: string,
): string {
  if (type === 'cron') {
    const iso = CronExpressionParser.parse(value, { tz: TIMEZONE })
      .next()
      .toISOString();
    if (!iso) throw new Error(`Invalid cron expression: ${value}`);
    return iso;
  }
  if (type === 'interval') {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      throw new Error(
        `Invalid interval (must be at least ${MIN_INTERVAL_MS} milliseconds): ${value}`,
      );
    }
    return new Date(Date.now() + ms).toISOString();
  }
  // once：value 为不带 Z 的本地时间串，按进程本地时区解释再转 UTC 存储。
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return d.toISOString();
}

function safeComputeNextRun(
  task: ScheduledTask,
  manualRun?: boolean,
): string | null {
  if (manualRun) {
    if (
      task.schedule_type === 'once' &&
      task.next_run &&
      new Date(task.next_run).getTime() <= Date.now()
    ) {
      return null;
    }
    return task.next_run ?? null;
  }
  try {
    return computeNextRun(task);
  } catch (err) {
    logger.error(
      { taskId: task.id, err },
      'computeNextRun failed; leaving next_run unchanged',
    );
    return null;
  }
}

/**
 * Persist a finished task run. The single rule for every run path (normal,
 * error early-exit, manual, script, group-mode): a RECURRING task that can't
 * compute a next run is PAUSED, never silently 'completed'. updateTaskAfterRun
 * flips status to 'completed' when nextRun is null — correct for once-tasks, but
 * for a recurring task (corrupted schedule_value, transient cron parse failure)
 * it permanently disables it. Pausing records this run's last_run/last_result
 * and lets PATCH /api/tasks/:id recompute next_run on resume. Routing ALL finalize
 * sites through here keeps error/manual/script/group paths from re-introducing
 * the silent-disable this batch set out to remove.
 */
function finalizeRecurringRun(
  task: ScheduledTask,
  nextRun: string | null,
  resultSummary: string,
): void {
  if (nextRun === null && task.schedule_type !== 'once') {
    logger.error(
      {
        taskId: task.id,
        scheduleType: task.schedule_type,
        scheduleValue: task.schedule_value,
      },
      'Recurring task has null next_run; pausing instead of completing (fix schedule to resume)',
    );
    pauseTaskAfterRun(task.id, resultSummary);
  } else {
    updateTaskAfterRun(task.id, nextRun, resultSummary);
  }
}

/**
 * 包装 updateTaskRunLog 让 SQLite 临时抛错（WAL busy / 磁盘满 / migration
 * 期间 schema 锁）不会冒泡出函数体，否则会跳过下面 runningTaskIds.delete
 * 让任务永久卡在 running set。
 */
function safeUpdateTaskRunLog(
  taskId: string,
  runLogId: number,
  patch: Parameters<typeof updateTaskRunLog>[1],
): void {
  try {
    updateTaskRunLog(runLogId, patch);
  } catch (err) {
    logger.error(
      { taskId, runLogId, err },
      'updateTaskRunLog failed (continuing to free runningTaskIds)',
    );
  }
}

/**
 * Re-check DB before running — task may have been cancelled/paused while queued.
 * Returns true if the task is still active and should proceed.
 */
function isTaskStillActive(taskId: string, label?: string): boolean {
  const currentTask = getTaskById(taskId);
  if (!currentTask || currentTask.status !== 'active') {
    logger.info(
      { taskId },
      `Skipping ${label ?? 'task'}: deleted or no longer active since enqueue`,
    );
    return false;
  }
  return true;
}

const SCHEDULER_RUNNER_ID = `${process.pid}:${randomUUID()}`;
const MIN_INTERVAL_MS = 60 * 1000;

function getTaskLeaseMs(): number {
  const settings = getSystemSettings();
  return (
    Math.max(settings.containerTimeout, settings.idleTimeout) +
    SCHEDULER_POLL_INTERVAL
  );
}

function claimScheduledRun(taskId: string, label: string): boolean {
  const claimed = claimTaskForRun(
    taskId,
    SCHEDULER_RUNNER_ID,
    getTaskLeaseMs(),
  );
  if (!claimed) {
    logger.info(
      { taskId, runnerId: SCHEDULER_RUNNER_ID },
      `Skipping ${label}: another scheduler runner already claimed it`,
    );
  }
  return claimed;
}

async function runTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  if (!options?.manualRun && !isTaskStillActive(staleTask.id, 'task')) return;

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) return;
  if (!options?.manualRun && !claimScheduledRun(task.id, 'task')) return;

  runningTaskIds.add(task.id);
  // 顶层兜底 finally：runningTaskIds.add 之后到 inner runTask 真正进入 try
  // 之间还有 logTaskRunStart / ensureTaskWorkspace / mkdirSync / getUserById /
  // checkBilling / writeTasksSnapshot 等多次 DB/FS 调用，任意一处抛错都会
  // 让 task.id 永久挂在 runningTaskIds（scheduler 跳过该任务直到进程重启）。
  // 内层 try/finally 仍照常处理 next_run / 计费等逻辑；这层只兜底删 set。
  try {
    await runTaskInner(task, deps, options);
  } finally {
    cleanupIsolatedTaskRun(task, deps, options);
    runningTaskIds.delete(task.id);
  }
}

export function enqueueIsolatedScheduledTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): boolean {
  if (isTaskReserved(task.id)) return false;

  const prepared = prepareIsolatedTaskRun(task, deps);
  if (!prepared) return false;

  pendingScheduledTaskIds.add(task.id);
  const releaseReservation = () => {
    pendingScheduledTaskIds.delete(task.id);
  };

  try {
    const accepted = deps.queue.enqueueTask(
      prepared.queueJid,
      task.id,
      async () => {
        try {
          await runTask(task, deps, prepared.options);
        } finally {
          releaseReservation();
        }
      },
      { onDropped: releaseReservation },
    );
    if (accepted === false) {
      releaseReservation();
      return false;
    }
    return true;
  } catch (err) {
    releaseReservation();
    throw err;
  }
}

async function runTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  // Agent tasks run in the source workspace directory, but use a task-scoped
  // virtual chat/session so scheduled automation does not pollute the main chat.
  const workspace = resolveTaskRunWorkspace(task, deps, options);
  const workspaceGroup = workspace?.group;

  if (!workspace || !workspaceGroup) {
    logger.error(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
      },
      'Workspace group not found for scheduled task',
    );
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Workspace group not found: ${task.chat_jid}`,
    });
    try {
      const nextRun = safeComputeNextRun(task, options?.manualRun);
      finalizeRecurringRun(
        task,
        nextRun,
        `Error: Workspace group not found: ${task.chat_jid}`,
      );
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in early-exit',
      );
    } finally {
      runningTaskIds.delete(task.id);
    }
    return;
  }

  const effectiveJid = options?.taskRunId
    ? `${workspace.jid}#task:${options.taskRunId}`
    : workspace.jid;
  const taskOwnerId = task.created_by || workspaceGroup.created_by || null;

  const groupDir = path.join(GROUPS_DIR, workspace.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: workspace.folder },
    'Running scheduled task',
  );

  // Owner gate before running task: a disabled/deleted owner's scheduled
  // tasks must stop firing (billing only checks balance, not status, and is
  // skipped for admins — so it can't cover this). See `src/owner-gate.ts`.
  if (taskOwnerId) {
    const ownerGate = checkOwnerActive(getUserById(taskOwnerId));
    if (!ownerGate.allowed) {
      logger.info(
        {
          taskId: task.id,
          userId: taskOwnerId,
          ownerStatus: ownerGate.status,
        },
        'Owner not active, blocking scheduled task',
      );
      safeUpdateTaskRunLog(task.id, runLogId, {
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error: '账户已禁用',
      });
      try {
        const nextRun = safeComputeNextRun(task, options?.manualRun);
        finalizeRecurringRun(task, nextRun, 'Error: 账户已禁用');
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'updateTaskAfterRun failed in owner-gate',
        );
      } finally {
        runningTaskIds.delete(task.id);
      }
      return;
    }
  }

  // Billing quota check before running task
  if (isBillingEnabled() && taskOwnerId) {
    const owner = getUserById(taskOwnerId);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(taskOwnerId, owner.role);
      if (!accessResult.allowed) {
        const reason = accessResult.reason || '当前账户不可用';
        logger.info(
          {
            taskId: task.id,
            userId: taskOwnerId,
            reason,
            blockType: accessResult.blockType,
          },
          'Billing access denied, blocking scheduled task',
        );
        safeUpdateTaskRunLog(task.id, runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: `计费限制: ${reason}`,
        });
        try {
          // Still compute next run so the task isn't stuck (but preserve for manual runs)
          const nextRun = safeComputeNextRun(task, options?.manualRun);
          finalizeRecurringRun(task, nextRun, `Error: 计费限制: ${reason}`);
        } catch (err) {
          logger.error(
            { taskId: task.id, err },
            'updateTaskAfterRun failed in billing-gate',
          );
        } finally {
          runningTaskIds.delete(task.id);
        }
        return;
      }
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isHome = !!workspaceGroup.is_home;
  const owner = taskOwnerId ? getUserById(taskOwnerId) : null;
  const isAdminHome = isHome && owner?.role === 'admin';
  const tasks = getAllTasks();
  writeTasksSnapshot(
    workspace.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Store task prompt as a user message in workspace chat so it's visible in conversation
  if (deps.storePromptMessage) {
    const senderName = owner?.display_name || owner?.username || '定时任务';
    deps.storePromptMessage(
      effectiveJid,
      owner?.id || 'system',
      senderName,
      task.prompt,
      task.id,
    );
  }

  let result: string | null = null;
  let error: string | null = null;
  // Track the time of last meaningful output from the agent.
  // duration_ms should measure actual work time, not include idle wait.
  let lastOutputTime = startTime;
  let runLogFinalized = false;

  const finalizeRunLog = () => {
    if (runLogFinalized) return;
    runLogFinalized = true;
    // 注意：runningTaskIds.delete() 不在此处调用，
    // 必须等到 updateTaskAfterRun() ��新 next_run 后才能释放防重复屏障（#363）
    const durationMs = lastOutputTime - startTime;
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });
    // Send _close sentinel so the idle agent process exits promptly,
    // freeing the queue slot for the next run.
    if (idleTimer) clearTimeout(idleTimer);
    deps.queue.closeStdin(effectiveJid);
  };

  // Use a run-scoped Claude session in the same workspace folder. Reusing
  // `task:${task.id}` would let isolated scheduled tasks accumulate context
  // across runs, which contradicts the default isolated semantics.
  const taskSessionAgentId = options?.taskRunId
    ? createTaskSessionAgentId(options.taskRunId)
    : `task-${task.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const agentProfile = resolveEffectiveAgentProfile(
    getAgentProfileForWorkspace(workspace.folder, taskOwnerId),
  );
  if (
    taskSessionNeedsAgentProfileReset(
      workspace.folder,
      agentProfile,
      taskSessionAgentId,
    )
  ) {
    deleteSession(workspace.folder, taskSessionAgentId);
    logger.info(
      {
        taskId: task.id,
        groupFolder: workspace.folder,
        sessionAgentId: taskSessionAgentId,
        agentProfileId: agentProfile?.id,
      },
      'Cleared scheduled task Claude session after AgentProfile identity changed',
    );
  }
  const sessionId = getSession(workspace.folder, taskSessionAgentId);

  // Idle timer: writes _close sentinel after idleTimeout of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing container stdin',
      );
      deps.queue.closeStdin(effectiveJid);
    }, getSystemSettings().idleTimeout);
  };

  try {
    const executionMode = resolveTaskExecutionMode(task, deps);
    const workspaceOwnerId = workspaceGroup.created_by;
    if (
      executionMode === 'host' &&
      !canExecuteOnHost(
        workspaceOwnerId ? getUserById(workspaceOwnerId) : undefined,
      )
    ) {
      throw new Error(HOST_EXECUTION_FORBIDDEN_ERROR);
    }
    const runAgent =
      executionMode === 'host' ? runHostAgent : runContainerAgent;

    // Resolve owner's home folder for correct volume mounts (skills, memory, CLAUDE.md)
    const ownerHomeFolder = taskOwnerId
      ? getUserHomeGroup(taskOwnerId)?.folder || workspace.folder
      : workspace.folder;

    const output = await runAgent(
      workspaceGroup,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: workspace.folder,
        chatJid: workspace.jid,
        isMain: isAdminHome,
        isHome,
        isAdminHome,
        isScheduledTask: true,
        taskRunId: options?.taskRunId,
        // The run ID is only an IPC/session namespace.  Routing must use the
        // stable scheduled-task ID so notify_channels and chat_jid resolve.
        messageTaskId: task.id,
        sessionAgentId: taskSessionAgentId,
        agentProfile: toRunnerAgentProfile(agentProfile),
      },
      (proc, identifier, selectedProviderId) =>
        deps.onProcess(
          effectiveJid,
          proc,
          executionMode === 'container' ? identifier : null,
          workspace.folder,
          identifier,
          options?.taskRunId,
          selectedProviderId,
        ),
      async (streamedOutput: ContainerOutput) => {
        // Broadcast stream events to WebSocket clients viewing the task workspace
        if (streamedOutput.status === 'stream' && streamedOutput.streamEvent) {
          deps.broadcastStreamEvent?.(effectiveJid, streamedOutput.streamEvent);
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          lastOutputTime = Date.now();
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          lastOutputTime = Date.now();
        }
        if (
          streamedOutput.newSessionId &&
          streamedOutput.status !== 'error' &&
          !streamedOutput.providerFailure
        ) {
          setSession(
            workspace.folder,
            streamedOutput.newSessionId,
            taskSessionAgentId,
            {
              agentProfileId: agentProfile?.id,
              agentProfileVersion: agentProfile?.version,
              identityHash: agentProfile?.identity_hash,
            },
          );
        }
        // Finalize run log on first non-stream output (success/error/closed).
        // Don't wait for the process to exit — idle timeout can be very long.
        if (streamedOutput.status !== 'stream') {
          finalizeRunLog();
        }
      },
      ownerHomeFolder,
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      lastOutputTime = Date.now();
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
      lastOutputTime = Date.now();
    }
    if (
      output.newSessionId &&
      output.status !== 'error' &&
      !output.providerFailure
    ) {
      setSession(workspace.folder, output.newSessionId, taskSessionAgentId, {
        agentProfileId: agentProfile?.id,
        agentProfileVersion: agentProfile?.version,
        identityHash: agentProfile?.identity_hash,
      });
    }

    // Finalize if not already done by onOutput callback
    finalizeRunLog();

    logger.info(
      { taskId: task.id, durationMs: lastOutputTime - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    lastOutputTime = Date.now();
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    // Safety net: finalize run log if not already done by onOutput callback
    finalizeRunLog();
  }

  // 必须在 top-level try/finally 里清理 runningTaskIds：computeNextRun 抛错
  // （损坏 cron / 损坏 next_run 等）+ updateTaskAfterRun 抛错都不能让任务永久
  // 卡在 runningTaskIds 里被 scheduler 跳过。
  try {
    let nextRun: string | null = null;
    let resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    nextRun = safeComputeNextRun(task, options?.manualRun);
    try {
      // Routes through finalizeRecurringRun so an error/manual run that yields a
      // null next_run for a recurring task is paused, not silently completed.
      finalizeRecurringRun(task, nextRun, resultSummary);
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'Failed to finalize task run');
    }
  } finally {
    runningTaskIds.delete(task.id);
  }

  if (deps.storeResultAndNotify && (result || error)) {
    const text = error ? `执行出错: ${error}` : stripAgentInternalTags(result!);

    if (text) {
      try {
        await deps.storeResultAndNotify(effectiveJid, text, {
          // Successful scheduled Agent runs deliver user-visible output via
          // send_message/send_image.  Their IPC payload carries task.id and is
          // routed to chat_jid/notify_channels by the host watcher.  Keep the
          // SDK final in the web task session for audit, but do not broadcast
          // it a second time.  Failures still need the scheduler fallback.
          ownerId: error ? taskOwnerId || undefined : undefined,
          notifyChannels: task.notify_channels,
          sourceKind: 'sdk_final',
          // Use source workspace folder for IM routing; task sessions are virtual
          // chats under that workspace and should inherit its channel bindings.
          workspaceFolder: workspace.folder || undefined,
        });
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to store/notify task result',
        );
      }
    }
  }

  // Legacy cleanup: old isolated tasks may still point at task-* workspaces.
  // New tasks run inside the source workspace, which must never be deleted here.
  if (
    task.schedule_type === 'once' &&
    !options?.manualRun &&
    task.workspace_jid &&
    task.workspace_folder &&
    task.workspace_folder.startsWith('task-')
  ) {
    setTimeout(() => {
      try {
        const groups = deps.registeredGroups();
        if (groups[task.workspace_jid!]) {
          deleteGroupData(task.workspace_jid!, task.workspace_folder!);
          delete groups[task.workspace_jid!];
          removeFlowArtifacts(task.workspace_folder!);
          logger.info(
            { taskId: task.id, folder: task.workspace_folder },
            'Cleaned up once-task workspace',
          );
        }
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to cleanup once-task workspace',
        );
      }
    }, 60_000);
  }
}

async function runScriptTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
): Promise<void> {
  if (!manualRun && !isTaskStillActive(staleTask.id, 'script task')) return;

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) return;
  if (!manualRun && !claimScheduledRun(task.id, 'script task')) return;

  runningTaskIds.add(task.id);
  // 顶层兜底 finally（同 runTask）。
  try {
    await runScriptTaskInner(task, deps, groupJid, manualRun);
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runScriptTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
): Promise<void> {
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

  // Owner gate before running script task: same as the Agent-task path, a
  // disabled/deleted owner's scheduled scripts must stop firing regardless of
  // billing toggle or role. See `src/owner-gate.ts`.
  {
    const ownerId =
      task.created_by || deps.registeredGroups()[groupJid]?.created_by;
    if (ownerId) {
      const ownerGate = checkOwnerActive(getUserById(ownerId));
      if (!ownerGate.allowed) {
        logger.info(
          { taskId: task.id, userId: ownerId, ownerStatus: ownerGate.status },
          'Owner not active, blocking script task',
        );
        safeUpdateTaskRunLog(task.id, runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: '账户已禁用',
        });
        runningTaskIds.delete(task.id);
        const nextRun = safeComputeNextRun(task, manualRun);
        try {
          finalizeRecurringRun(task, nextRun, 'Error: 账户已禁用');
        } catch (err) {
          logger.error(
            { taskId: task.id, err },
            'updateTaskAfterRun failed in script owner-gate',
          );
        }
        return;
      }
    }
  }

  // Billing quota check before running script task
  if (isBillingEnabled() && task.group_folder) {
    const groups = deps.registeredGroups();
    const group = groups[groupJid];
    const ownerId = task.created_by || group?.created_by;
    if (ownerId) {
      const owner = getUserById(ownerId);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccessFresh(ownerId, owner.role);
        if (!accessResult.allowed) {
          const reason = accessResult.reason || '当前账户不可用';
          logger.info(
            {
              taskId: task.id,
              userId: ownerId,
              reason,
              blockType: accessResult.blockType,
            },
            'Billing access denied, blocking script task',
          );
          safeUpdateTaskRunLog(task.id, runLogId, {
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error: `计费限制: ${reason}`,
          });
          runningTaskIds.delete(task.id);
          const nextRun = safeComputeNextRun(task, manualRun);
          try {
            finalizeRecurringRun(task, nextRun, `Error: 计费限制: ${reason}`);
          } catch (err) {
            logger.error(
              { taskId: task.id, err },
              'updateTaskAfterRun failed in script billing-gate',
            );
          }
          return;
        }
      }
    }
  }

  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  if (!task.script_command) {
    logger.error(
      { taskId: task.id },
      'Script task has no script_command, skipping',
    );
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: 'script_command is empty',
    });
    try {
      const nextRun = safeComputeNextRun(task, manualRun);
      finalizeRecurringRun(task, nextRun, 'Error: script_command is empty');
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in script no-command',
      );
    } finally {
      runningTaskIds.delete(task.id);
    }
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    // Script tasks execute directly on the host even when their source
    // workspace is container-backed. Re-authorize against the current DB role
    // immediately before spawning the process.
    const currentOwnerId = deps.registeredGroups()[groupJid]?.created_by;
    if (
      !canExecuteOnHost(
        currentOwnerId ? getUserById(currentOwnerId) : undefined,
      )
    ) {
      throw new Error(HOST_EXECUTION_FORBIDDEN_ERROR);
    }
    const scriptResult = await runScript(
      task.script_command,
      task.group_folder,
      { ownerId: currentOwnerId },
    );

    if (scriptResult.timedOut) {
      error = `脚本执行超时 (${Math.round(scriptResult.durationMs / 1000)}s)`;
    } else if (scriptResult.exitCode !== 0) {
      error = scriptResult.stderr.trim() || `退出码: ${scriptResult.exitCode}`;
      result = scriptResult.stdout.trim() || null;
    } else {
      result = scriptResult.stdout.trim() || null;
    }

    // Send result to user (skip if no output and no error)
    if (error || result) {
      const text = error
        ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
        : `[脚本] ${result!.slice(0, 1000)}`;
      const fullText = `${deps.assistantName}: ${text}`;

      await deps.sendMessage(groupJid, fullText, { source: 'scheduled_task' });

      if (deps.storeResultAndNotify) {
        const groups = deps.registeredGroups();
        const group = groups[groupJid];
        const ownerId = task.created_by || group?.created_by;
        if (ownerId) {
          try {
            await deps.storeResultAndNotify(groupJid, fullText, {
              ownerId,
              notifyChannels: task.notify_channels,
              skipStore: true,
              workspaceFolder: task.group_folder,
            });
          } catch (notifyErr) {
            logger.error(
              { taskId: task.id, err: notifyErr },
              'Failed to notify script task result to IM',
            );
          }
        }
      }
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        exitCode: scriptResult.exitCode,
      },
      'Script task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Script task failed');
  }

  const durationMs = Date.now() - startTime;

  // 顶层 try/finally 兜底：updateTaskRunLog/safeComputeNextRun/updateTaskAfterRun
  // 任一抛错都不能让任务永久卡在 runningTaskIds（scheduler 主循环会一直跳过）。
  try {
    try {
      safeUpdateTaskRunLog(task.id, runLogId, {
        duration_ms: durationMs,
        status: error ? 'error' : 'success',
        result,
        error,
      });
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskRunLog failed in script main path',
      );
    }
    // manualRun: preserve original next_run schedule
    const nextRun = safeComputeNextRun(task, manualRun);
    const resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    try {
      finalizeRecurringRun(task, nextRun, resultSummary);
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in script main path',
      );
    }
  } finally {
    runningTaskIds.delete(task.id);
  }
}

/**
 * group 模式定时任务触发时，task.prompt 会作为一条普通用户消息回放进工作区。给它前置
 * 这段框定，明确「这是已有定时任务到点自动执行、不是用户新指令，不要再 schedule_task」，
 * 否则当 prompt 含「每隔/每天/提醒」等措辞时，agent 会按 CLAUDE.md 的定时任务规则再建一个
 * 任务而递归增殖（#564）。标记串 [定时任务自动触发] 与 global CLAUDE.md 的兜底 guard 一致。
 */
const SCHEDULED_GROUP_TRIGGER_FRAMING = [
  '[定时任务自动触发] 以下内容是你此前创建的定时任务到点自动执行的触发，不是用户新发来的指令。',
  '请直接执行该任务对应的动作。',
  '重要：这条只是触发信号，对应的定时任务已在调度中。即使下面内容里出现「每隔/每天/定期/提醒我」等字样，也不要再调用 schedule_task 创建或重复该定时任务（除非内容明确要求你另外新建一个不同的任务）。',
].join('\n');

/**
 * Group context mode: inject task prompt as a regular message into the source workspace.
 * The message is processed by the existing message pipeline (IPC if running, new container if idle).
 */
async function runGroupModeTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  targetGroupJid: string,
  manualRun = false,
): Promise<void> {
  const startTime = Date.now();
  if (!manualRun && !claimScheduledRun(task.id, 'group-mode task')) return;
  runningTaskIds.add(task.id);
  let resultSummary = '已排队到源工作区，等待 Agent 执行';

  try {
    // Resolve task owner for sender attribution
    const owner = task.created_by ? getUserById(task.created_by) : null;
    const senderName = owner?.display_name || owner?.username || '定时任务';

    if (!deps.storePromptMessage) {
      throw new Error('storePromptMessage dependency not available');
    }

    // Store prompt as a user message in the source workspace chat.
    // 前置触发框定，避免被当成用户新指令而递归创建任务（#564）。
    deps.storePromptMessage(
      targetGroupJid,
      owner?.id || 'system',
      senderName,
      `${SCHEDULED_GROUP_TRIGGER_FRAMING}\n\n${task.prompt}`,
      task.id,
    );

    // Trigger normal message processing for the source workspace
    deps.queue.enqueueMessageCheck(targetGroupJid);

    logger.info(
      { taskId: task.id, targetGroupJid, contextMode: 'group' },
      'Group-mode task injected into source workspace',
    );

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'queued',
      result: resultSummary,
      error: null,
    });
  } catch (err) {
    resultSummary = `Error: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(
      { taskId: task.id, error: resultSummary },
      'Group-mode task injection failed',
    );

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: resultSummary,
    });
  } finally {
    try {
      const nextRun = safeComputeNextRun(task, manualRun);
      finalizeRecurringRun(task, nextRun, resultSummary);
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in group-mode',
      );
    } finally {
      runningTaskIds.delete(task.id);
    }
  }
}

let schedulerRunning = false;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastCleanupTime = 0;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  // Clean up stale state from previous process crash
  runningTaskIds.clear();
  pendingManualTaskIds.clear();
  pendingScheduledTaskIds.clear();
  try {
    const cleaned = cleanupStaleRunningLogs();
    if (cleaned > 0) {
      logger.info(
        { cleaned },
        'Cleaned up stale running task logs from previous session',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup stale running task logs');
  }

  // Clean up orphaned legacy task-* workspaces from completed once-tasks
  // (covers the case where process restarted before setTimeout cleanup fired).
  // New scheduled tasks run inside the source workspace and must never delete
  // the source workspace during task cleanup.
  try {
    const allTasks = getAllTasks();
    const groups = deps.registeredGroups();
    let cleaned = 0;
    for (const t of allTasks) {
      if (
        t.schedule_type === 'once' &&
        t.status === 'completed' &&
        t.workspace_jid &&
        t.workspace_folder &&
        t.workspace_folder.startsWith('task-') &&
        groups[t.workspace_jid]
      ) {
        deleteGroupData(t.workspace_jid, t.workspace_folder);
        delete groups[t.workspace_jid];
        removeFlowArtifacts(t.workspace_folder);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(
        { cleaned },
        'Cleaned up orphaned once-task workspaces from previous session',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup orphaned once-task workspaces');
  }

  logger.info('Scheduler loop started');

  const loop = async () => {
    // Shutdown 自检：grace 期间若有任务到点会 spawn 子进程，孤儿化风险。
    // GroupQueue.isShuttingDown 在 src/index.ts shutdown handler 一开始
    // 就被设为 true（queue.shutdown 内部），所以 scheduler 看到后停 tick。
    if (deps.queue.isShuttingDown?.()) {
      logger.info('Scheduler tick skipped: queue is shutting down');
      // 仍排下一次 tick，让 process exit 退出循环（如果 shutdown 完成可恢复）
      setTimeout(loop, 60_000);
      return;
    }
    try {
      // Periodic cleanup of old task run logs (every 24h)
      const now = Date.now();
      if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
        lastCleanupTime = now;
        try {
          const deleted = cleanupOldTaskRunLogs();
          if (deleted > 0) {
            logger.info({ deleted }, 'Cleaned up old task run logs');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to cleanup old task run logs');
        }
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      const graceMs = getSystemSettings().taskBackfillGraceMs;

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        if (isTaskReserved(currentTask.id)) {
          continue;
        }

        if (shouldSkipBackfill(currentTask.next_run, Date.now(), graceMs)) {
          const overdueMs =
            Date.now() - new Date(currentTask.next_run!).getTime();
          // Once-tasks 行为：用户明确希望它至少跑一次。跳过 backfill 会让
          // computeNextRun 返回 null，advanceSkippedTask(null) 把 status 翻为
          // completed —— 用户重启系统后 once-task 直接消失，没运行过。改为
          // 直接 fall through 到正常运行路径（让它一次性跑完）；否则按原 backfill
          // 跳过逻辑，cron / interval 推到下一次触发。
          if (currentTask.schedule_type === 'once') {
            logger.info(
              { taskId: currentTask.id, overdueMs, graceMs },
              'Once-task overdue but running it anyway (no auto-complete on skip)',
            );
            // intentional fall-through to normal run below
          } else {
            const advancedNextRun = safeComputeNextRun(currentTask);
            if (advancedNextRun === null) {
              // Corrupted recurring schedule: advanceSkippedTask(null) would
              // silently flip status to 'completed', permanently disabling the
              // task — the same trap runTaskInner pauses to avoid. Pause here too
              // (don't touch last_run; this skip wasn't an actual run).
              logger.error(
                {
                  taskId: currentTask.id,
                  scheduleType: currentTask.schedule_type,
                  scheduleValue: currentTask.schedule_value,
                },
                'Overdue recurring task has null next_run; pausing instead of completing',
              );
              updateTask(currentTask.id, { status: 'paused', next_run: null });
              logTaskRun({
                task_id: currentTask.id,
                run_at: new Date().toISOString(),
                duration_ms: 0,
                status: 'error',
                result: null,
                error:
                  'Paused: schedule produces no next run (fix schedule_value to re-activate)',
              });
              continue;
            }
            advanceSkippedTask(currentTask.id, advancedNextRun);
            logTaskRun({
              task_id: currentTask.id,
              run_at: new Date().toISOString(),
              duration_ms: 0,
              status: 'success',
              result: `Skipped: overdue by ${Math.round(overdueMs / 1000)}s, exceeds backfill grace window (${Math.round(graceMs / 1000)}s)`,
              error: null,
            });
            logger.info(
              {
                taskId: currentTask.id,
                overdueMs,
                graceMs,
                nextRun: advancedNextRun,
              },
              'Skipping overdue task: exceeds backfill grace window',
            );
            continue;
          }
        }

        const groups = deps.registeredGroups();
        const targetGroupJid = resolveTargetGroupJid(currentTask, groups);

        if (!targetGroupJid) {
          logger.error(
            { taskId: currentTask.id, groupFolder: currentTask.group_folder },
            'Target group not registered, skipping scheduled task',
          );
          // 对 once-task 主动止损：若目标群组永远找不到，advanceSkippedTask
          // 把它推到 completed，避免每 60s tick 一次反复打 error 日志。
          // cron / interval 不动 next_run（重启后可能群组恢复），只 once 自动收尾。
          if (currentTask.schedule_type === 'once') {
            try {
              advanceSkippedTask(currentTask.id, null);
              logTaskRun({
                task_id: currentTask.id,
                run_at: new Date().toISOString(),
                duration_ms: 0,
                status: 'error',
                result: null,
                error: `Target group not registered: ${currentTask.chat_jid ?? currentTask.group_folder}`,
              });
            } catch (err) {
              logger.error(
                { taskId: currentTask.id, err },
                'Failed to mark once-task as completed after missing target',
              );
            }
          }
          continue;
        }

        if (currentTask.execution_type === 'script') {
          if (!hasScriptCapacity()) {
            logger.debug(
              { taskId: currentTask.id },
              'Script concurrency limit reached, skipping',
            );
            continue;
          }
          // Script tasks run directly, not through GroupQueue
          runScriptTask(currentTask, deps, targetGroupJid).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runScriptTask',
            );
          });
        } else if (currentTask.context_mode === 'group') {
          // Group mode: inject prompt into source workspace as a regular message
          runGroupModeTask(currentTask, deps, targetGroupJid).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runGroupModeTask',
            );
          });
        } else {
          // Isolated mode (default): reserve before enqueue so route mutation,
          // duplicate scheduler ticks, and manual triggers all see this queued
          // run as active even while GroupQueue is capacity-blocked.
          enqueueIsolatedScheduledTask(currentTask, deps);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/**
 * Manually trigger a task to run now (fire-and-forget).
 * Does not change next_run — the task continues its normal schedule.
 */
export function triggerTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
): { success: boolean; error?: string } {
  const task = getTaskById(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.status === 'completed')
    return { success: false, error: 'Task already completed' };
  if (task.status === 'parsing')
    return { success: false, error: '任务仍在解析中，请稍后再运行' };
  if (isTaskReserved(taskId))
    return { success: false, error: 'Task is already running' };

  const groups = deps.registeredGroups();
  const targetGroupJid = resolveTargetGroupJid(task, groups);
  if (!targetGroupJid)
    return { success: false, error: 'Target group not registered' };

  pendingManualTaskIds.add(taskId);
  const releaseManualReservation = () => {
    pendingManualTaskIds.delete(taskId);
  };

  if (task.execution_type === 'script') {
    if (!hasScriptCapacity()) {
      releaseManualReservation();
      return { success: false, error: 'Script concurrency limit reached' };
    }
    runScriptTask(task, deps, targetGroupJid, true)
      .catch((err) =>
        logger.error({ taskId, err }, 'Manual script task failed'),
      )
      .finally(releaseManualReservation);
  } else if (task.context_mode === 'group') {
    runGroupModeTask(task, deps, targetGroupJid, true)
      .catch((err) =>
        logger.error({ taskId, err }, 'Manual group-mode task failed'),
      )
      .finally(releaseManualReservation);
  } else {
    const prepared = prepareIsolatedTaskRun(task, deps, true);
    if (!prepared) {
      releaseManualReservation();
      return { success: false, error: 'Failed to prepare task workspace' };
    }
    try {
      const accepted = deps.queue.enqueueTask(
        prepared.queueJid,
        task.id,
        async () => {
          try {
            await runTask(task, deps, prepared.options);
          } finally {
            releaseManualReservation();
          }
        },
        {
          allowInactive: true,
          onDropped: releaseManualReservation,
        },
      );
      if (accepted === false) {
        releaseManualReservation();
        return { success: false, error: 'Task queue is shutting down' };
      }
    } catch (err) {
      releaseManualReservation();
      logger.error({ taskId, err }, 'Failed to enqueue manual task');
      return { success: false, error: 'Failed to enqueue task' };
    }
  }

  return { success: true };
}
