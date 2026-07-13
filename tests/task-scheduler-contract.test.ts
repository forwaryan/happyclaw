import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'task-scheduler-contract-'),
);
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { runContainerAgentMock, runHostAgentMock } = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(async (_group, input, onProcess, onOutput) => {
    const sessionDir = path.join(
      tmpDir,
      'sessions',
      input.groupFolder,
      'agents',
      input.sessionAgentId,
      '.claude',
    );
    const ipcDir = path.join(
      tmpDir,
      'ipc',
      input.groupFolder,
      'tasks-run',
      input.taskRunId,
      'input',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'transcript.jsonl'), '{}');
    fs.writeFileSync(path.join(ipcDir, 'request.json'), '{}');
    onProcess?.({} as never, `container-${input.taskRunId}`, null);
    await onOutput?.({
      status: 'stream',
      result: 'partial',
      streamEvent: { type: 'text', text: 'partial' },
    });
    return {
      status: 'success',
      result: 'task result',
      newSessionId: `task-session:${input.taskRunId}`,
    };
  }),
  runHostAgentMock: vi.fn(async () => ({
    status: 'success',
    result: 'host result',
  })),
}));

vi.mock('../src/container-runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/container-runner.js')>();
  return {
    ...actual,
    runContainerAgent: runContainerAgentMock,
    runHostAgent: runHostAgentMock,
  };
});

const db = await import('../src/db.js');
const {
  enqueueIsolatedScheduledTask,
  getRunningTaskIds,
  triggerTaskNow,
} = await import('../src/task-scheduler.js');

const GROUP_JID = 'web:task-contract';
const GROUP_FOLDER = 'task-contract';

function makeDeps(groups: Record<string, any>) {
  let runPromise: Promise<void> | null = null;
  const queue = {
    enqueueTask: vi.fn(
      (_jid: string, _taskId: string, fn: () => Promise<void>) => {
        runPromise = fn();
        return true;
      },
    ),
    closeStdin: vi.fn(),
    enqueueMessageCheck: vi.fn(),
    isShuttingDown: () => false,
  };

  return {
    deps: {
      registeredGroups: () => groups,
      getSessions: () => ({}),
      queue,
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
      broadcastStreamEvent: vi.fn(),
      storePromptMessage: vi.fn(),
      storeResultAndNotify: vi.fn(),
      assistantName: 'HappyClaw',
    } as any,
    queue,
    waitForRun: async () => {
      await runPromise;
    },
  };
}

function createTask(
  overrides: Partial<Parameters<typeof db.createTask>[0]> = {},
) {
  const id = overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`;
  db.createTask({
    id,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    prompt: 'write a short status',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    created_by: undefined,
    ...overrides,
  });
  return id;
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  runContainerAgentMock.mockClear();
  runHostAgentMock.mockClear();
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Task Contract Workspace',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    is_home: false,
  } as any);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduled task workspace/session contract', () => {
  test('isolated task runs in the source workspace with a task-scoped Claude session', async () => {
    const taskId = createTask({ id: 'task-session-contract' });
    db.setSession(GROUP_FOLDER, 'main-session');
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, queue, waitForRun } = makeDeps(groups);
    let virtualChatJid = '';
    deps.storePromptMessage.mockImplementation(
      (chatJid: string, senderId: string, senderName: string, text: string) => {
        virtualChatJid = chatJid;
        db.ensureChatExists(chatJid);
        db.storeMessageDirect(
          `prompt-${taskId}`,
          chatJid,
          senderId,
          senderName,
          text,
          new Date().toISOString(),
          false,
        );
      },
    );
    deps.storeResultAndNotify.mockImplementation(
      async (chatJid: string, text: string) => {
        db.ensureChatExists(chatJid);
        db.storeMessageDirect(
          `result-${taskId}`,
          chatJid,
          'assistant',
          'HappyClaw',
          text,
          new Date().toISOString(),
          true,
        );
      },
    );

    const result = triggerTaskNow(taskId, deps);
    expect(result.success).toBe(true);
    await waitForRun();

    expect(queue.enqueueTask).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${GROUP_JID}#task:task-${taskId}-[a-f0-9-]+$`),
      ),
      taskId,
      expect.any(Function),
      { allowInactive: true, onDropped: expect.any(Function) },
    );
    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    const input = runContainerAgentMock.mock.calls[0][1];
    expect(input.groupFolder).toBe(GROUP_FOLDER);
    expect(input.chatJid).toBe(GROUP_JID);
    expect(input.taskRunId).toMatch(
      new RegExp(`^task-${taskId}-[a-f0-9-]+$`),
    );
    expect(input.taskRunId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(input.sessionAgentId).toBe(`task-${input.taskRunId}`);
    expect(input.sessionAgentId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(input.isScheduledTask).toBe(true);
    expect(input.messageTaskId).toBe(taskId);

    expect(db.getSession(GROUP_FOLDER)).toBe('main-session');
    expect(db.getSession(GROUP_FOLDER, input.sessionAgentId)).toBeUndefined();
    expect(
      db.getWorkspaceRuntimeSession(GROUP_FOLDER, input.sessionAgentId),
    ).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'sessions',
          GROUP_FOLDER,
          'agents',
          input.sessionAgentId,
        ),
      ),
    ).toBe(false);
    expect(virtualChatJid).toBe(`${GROUP_JID}#task:${input.taskRunId}`);
    expect(db.getMessagesPage(virtualChatJid)).toEqual([]);
    expect(db.getAllChats().some((chat) => chat.jid === virtualChatJid)).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'ipc',
          GROUP_FOLDER,
          'tasks-run',
          input.taskRunId,
        ),
      ),
    ).toBe(false);
    const storedTask = db.getTaskById(taskId)!;
    expect(storedTask.workspace_jid).toBeNull();
    expect(storedTask.workspace_folder).toBeNull();
  });

  test('isolated manual runs get distinct Claude session namespaces', async () => {
    const taskId = createTask({ id: 'task-per-run-session' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const first = makeDeps(groups);
    expect(triggerTaskNow(taskId, first.deps).success).toBe(true);
    await first.waitForRun();

    const second = makeDeps(groups);
    expect(triggerTaskNow(taskId, second.deps).success).toBe(true);
    await second.waitForRun();

    const firstInput = runContainerAgentMock.mock.calls[0][1];
    const secondInput = runContainerAgentMock.mock.calls[1][1];
    expect(firstInput.taskRunId).toMatch(new RegExp(`^task-${taskId}-`));
    expect(secondInput.taskRunId).toMatch(new RegExp(`^task-${taskId}-`));
    expect(secondInput.taskRunId).not.toBe(firstInput.taskRunId);
    expect(firstInput.sessionAgentId).toBe(`task-${firstInput.taskRunId}`);
    expect(secondInput.sessionAgentId).toBe(`task-${secondInput.taskRunId}`);
  });

  test('group-mode delivery is logged as queued, not falsely completed', async () => {
    const taskId = createTask({
      id: 'task-group-queued-status',
      context_mode: 'group',
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, queue } = makeDeps(groups);

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith(GROUP_JID);
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'queued',
      result: '已排队到源工作区，等待 Agent 执行',
      error: null,
    });
  });

  test('host task cannot use an admin creator to bypass a downgraded workspace owner', async () => {
    const now = new Date().toISOString();
    for (const id of ['host-workspace-owner', 'host-task-creator']) {
      db.createUser({
        id,
        username: id,
        password_hash: 'hash',
        display_name: id,
        role: 'admin',
        status: 'active',
        must_change_password: false,
        created_at: now,
        updated_at: now,
      });
    }
    const hostGroup = {
      ...db.getRegisteredGroup(GROUP_JID)!,
      created_by: 'host-workspace-owner',
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(GROUP_JID, hostGroup);
    db.updateUserFields('host-workspace-owner', { role: 'member' });
    const taskId = createTask({
      id: 'host-owner-revoked-task',
      execution_mode: 'host',
      created_by: 'host-task-creator',
    });
    const { deps, waitForRun } = makeDeps({ [GROUP_JID]: hostGroup });

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    await waitForRun();

    expect(runHostAgentMock).not.toHaveBeenCalled();
    expect(db.getTaskRunLogs(taskId, 1)[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('active administrator'),
    });
  });

  test('manual trigger reserves a capacity-blocked task and releases after execution', async () => {
    const taskId = createTask({ id: 'task-manual-idempotency' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    let queuedRun: (() => Promise<void>) | null = null;
    const queue = {
      enqueueTask: vi.fn(
        (_jid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedRun = fn;
          return true;
        },
      ),
      closeStdin: vi.fn(),
      isShuttingDown: () => false,
    };
    const deps = {
      ...makeDeps(groups).deps,
      queue,
    } as any;

    expect(triggerTaskNow(taskId, deps)).toEqual({ success: true });
    expect(triggerTaskNow(taskId, deps)).toEqual({
      success: false,
      error: 'Task is already running',
    });
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);

    await queuedRun!();
    expect(triggerTaskNow(taskId, deps)).toEqual({ success: true });
    await queuedRun!();
  });

  test('manual reservation is released when the queue drops work before start', () => {
    const taskId = createTask({ id: 'task-manual-drop' });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    let onDropped: (() => void) | undefined;
    const queue = {
      enqueueTask: vi.fn(
        (
          _jid: string,
          _taskId: string,
          _fn: () => Promise<void>,
          options?: { onDropped?: () => void },
        ) => {
          onDropped = options?.onDropped;
          return true;
        },
      ),
      closeStdin: vi.fn(),
      isShuttingDown: () => false,
    };
    const deps = { ...makeDeps(groups).deps, queue } as any;

    expect(triggerTaskNow(taskId, deps).success).toBe(true);
    expect(triggerTaskNow(taskId, deps).success).toBe(false);
    onDropped?.();
    expect(triggerTaskNow(taskId, deps).success).toBe(true);
  });

  test('capacity-queued scheduled run keeps one reservation and one pinned JID', async () => {
    const taskId = createTask({
      id: 'task-scheduled-queued-jid',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    const originalGroup = db.getRegisteredGroup(GROUP_JID)!;
    const movedJid = 'web:task-contract-moved';
    const movedFolder = 'task-contract-moved';
    db.setRegisteredGroup(movedJid, {
      ...originalGroup,
      name: 'Moved Workspace',
      folder: movedFolder,
    } as any);
    const groups = {
      [GROUP_JID]: originalGroup,
      [movedJid]: db.getRegisteredGroup(movedJid)!,
    };
    let queuedJid = '';
    let queuedRun: (() => Promise<void>) | null = null;
    const queue = {
      enqueueTask: vi.fn(
        (jid: string, _taskId: string, fn: () => Promise<void>) => {
          queuedJid = jid;
          queuedRun = fn;
          return true;
        },
      ),
      closeStdin: vi.fn(),
      isShuttingDown: () => false,
    };
    const deps = { ...makeDeps(groups).deps, queue } as any;
    const snapshot = db.getTaskById(taskId)!;

    expect(enqueueIsolatedScheduledTask(snapshot, deps)).toBe(true);
    expect(enqueueIsolatedScheduledTask(snapshot, deps)).toBe(false);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(getRunningTaskIds()).toContain(taskId);

    // Even an out-of-band DB mutation cannot split GroupQueue tracking from
    // runTask's effective/onProcess JID. Supported PATCH is separately blocked
    // by the reservation contract in routes-tasks-contract.test.ts.
    db.updateTask(taskId, {
      chat_jid: movedJid,
      group_folder: movedFolder,
    } as any);
    await queuedRun!();

    const input = runContainerAgentMock.mock.calls[0][1];
    expect(input.chatJid).toBe(GROUP_JID);
    expect(input.groupFolder).toBe(GROUP_FOLDER);
    expect(deps.onProcess).toHaveBeenCalledWith(
      queuedJid,
      expect.anything(),
      expect.stringContaining(input.taskRunId),
      GROUP_FOLDER,
      expect.any(String),
      input.taskRunId,
      null,
    );
    expect(getRunningTaskIds()).not.toContain(taskId);
  });

  test('scheduled reservation releases on enqueue rejection, throw, and claim loss', async () => {
    const taskId = createTask({
      id: 'task-scheduled-release-paths',
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const baseDeps = makeDeps(groups).deps;
    const snapshot = db.getTaskById(taskId)!;

    const rejectedDeps = {
      ...baseDeps,
      queue: { enqueueTask: () => false },
    } as any;
    expect(enqueueIsolatedScheduledTask(snapshot, rejectedDeps)).toBe(false);
    expect(getRunningTaskIds()).not.toContain(taskId);

    const throwingDeps = {
      ...baseDeps,
      queue: {
        enqueueTask: () => {
          throw new Error('queue failed');
        },
      },
    } as any;
    expect(() =>
      enqueueIsolatedScheduledTask(snapshot, throwingDeps),
    ).toThrow('queue failed');
    expect(getRunningTaskIds()).not.toContain(taskId);

    let queuedRun: (() => Promise<void>) | null = null;
    const claimLostDeps = {
      ...baseDeps,
      queue: {
        enqueueTask: (
          _jid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          queuedRun = fn;
          return true;
        },
      },
    } as any;
    expect(db.claimTaskForRun(taskId, 'another-scheduler', 60_000)).toBe(true);
    expect(enqueueIsolatedScheduledTask(snapshot, claimLostDeps)).toBe(true);
    await queuedRun!();
    expect(getRunningTaskIds()).not.toContain(taskId);
    expect(runContainerAgentMock).not.toHaveBeenCalled();
    db.updateTaskAfterRun(
      taskId,
      new Date(Date.now() + 60_000).toISOString(),
      'released competing lease',
    );
  });

  test('paused tasks can still be run manually once', async () => {
    const taskId = createTask({
      id: 'paused-manual-task',
      status: 'paused',
      next_run: null,
    });
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
    };
    const { deps, waitForRun } = makeDeps(groups);

    const result = triggerTaskNow(taskId, deps);
    expect(result.success).toBe(true);
    await waitForRun();

    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
    expect(db.getTaskById(taskId)?.status).toBe('paused');
  });
});
