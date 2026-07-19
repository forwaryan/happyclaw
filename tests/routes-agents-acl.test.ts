/**
 * Verifies Sub-Agent CRUD (create / rename / delete) requires workspace
 * ownership (canModifyGroup).
 *
 * Coverage matrix:
 *   - owner        → POST creates a conversation (200)
 *   - non-owner → routes return 404 (group hidden by canAccessGroup)
 *
 * Mirrors tests/routes-workspace-config-acl.test.ts. web.js's broadcast is
 * mocked so the success path doesn't pull in the full Hono app / WebSocket.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-agents-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

// Avoid loading the full web.js (Hono app + WebSocket) for the success path.
vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: () => {},
  broadcastAgentRemoved: () => {},
}));

const agentRoutesModule = await import('../src/routes/agents.js');
const db = await import('../src/db.js');
const mountService = await import('../src/channel-mount-service.js');
const webContext = await import('../src/web-context.js');

const agentRoutes = agentRoutesModule.default;

const OWNER_ID = 'alice';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:agents-acl-group';
const GROUP_FOLDER = 'agents-acl-group';

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Agents ACL Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
}

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
  try {
    db.deleteRegisteredGroup('telegram:bound-session');
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

async function postAgent(
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postSession(
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteSessionRoute(
  sessionId: string,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/sessions/${sessionId}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchAgent(
  agentId: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents/${agentId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteAgent(
  agentId: string,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents/${agentId}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getAgents(): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents`,
    { method: 'GET' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('agents CRUD ACL', () => {
  test('owner can POST (create) a conversation', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const { status, body } = await postAgent({ name: 'My conversation' });
    expect(status).toBe(200);
    expect(body.agent?.id).toBeTruthy();
    expect(body.agent?.name).toBe('My conversation');
  });

  test('non-member returns 404 on POST (group hidden)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);

    const { status, body } = await postAgent({ name: 'Nope' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});

describe('formal sessions API', () => {
  test('owner can POST /sessions (create) a conversation session', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const { status, body } = await postSession({ name: 'Session API' });
    expect(status).toBe(200);
    expect(body.session?.id).toBeTruthy();
    expect(body.session?.name).toBe('Session API');
    expect(body.agent?.id).toBe(body.session?.id);
  });

  test('DELETE /sessions/:id is blocked by channel_mounts session binding', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const created = await postSession({ name: 'Bound session' });
    const sessionId = created.body.session.id as string;
    db.setRegisteredGroup('telegram:bound-session', {
      name: 'Bound Telegram',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      target_agent_id: sessionId,
    } as any);

    const { status, body } = await deleteSessionRoute(sessionId);
    expect(status).toBe(409);
    expect(body.linked_im_groups).toEqual([
      { jid: 'telegram:bound-session', name: 'Bound Telegram' },
    ]);
  });

  test('native-thread sessions have read-only titles and cannot be deleted directly', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = `native-session-${Date.now()}`;
    db.createAgent({
      id: sessionId,
      group_folder: GROUP_FOLDER,
      chat_jid: GROUP_JID,
      name: 'Native topic',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
      source_kind: 'native_thread',
      title_source: 'native_root',
    });

    const rename = await patchAgent(sessionId, { name: 'Do not rename' });
    expect(rename.status, JSON.stringify(rename.body)).toBe(400);
    expect(rename.body.error).toMatch(/read-only/i);

    const deletion = await deleteSessionRoute(sessionId);
    expect(deletion.status).toBe(409);
    expect(deletion.body.error).toMatch(/managed by their channel container/i);
  });
});

describe('agents IM-binding ACL (owner-only, mirrors CRUD)', () => {
  async function req(
    pathSuffix: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await agentRoutes.request(
      `/${encodeURIComponent(GROUP_JID)}${pathSuffix}`,
      {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  test('non-member returns 404 on PUT /im-binding (group hidden)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);
    const { status, body } = await req('/im-binding', 'PUT', {
      im_jid: 'feishu:x',
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('IM candidates expose account identity and keep same-chat bots distinct', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const first = db.createChannelAccount({
      id: `account-a-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Support bot',
      secret_ref: `channel-account:account-a-${suffix}`,
    });
    const second = db.createChannelAccount({
      id: `account-b-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Review bot',
      secret_ref: `channel-account:account-b-${suffix}`,
    });
    for (const account of [first, second]) {
      db.setRegisteredGroup(`telegram:shared#account:${account.id}`, {
        name: 'Shared external chat',
        folder: GROUP_FOLDER,
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        channel_account_id: account.id,
      });
    }

    const { status, body } = await req('/im-groups', 'GET');
    expect(status).toBe(200);
    const matching = body.imGroups.filter((item: any) =>
      item.jid.startsWith('telegram:shared#account:'),
    );
    expect(matching).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_account_id: first.id,
          channel_account_name: 'Support bot',
        }),
        expect.objectContaining({
          channel_account_id: second.id,
          channel_account_name: 'Review bot',
        }),
      ]),
    );
    expect(new Set(matching.map((item: any) => item.jid)).size).toBe(2);
  });

  test('ordinary chats can bind to a workspace main conversation', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-workspace-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: 'QQ bot',
      secret_ref: `channel-account:qq-workspace-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    const { status } = await req('/sessions/main/im-binding', 'PUT', {
      im_jid: imJid,
    });
    expect(status).toBe(200);
    expect(db.getRegisteredGroup(imJid)).toMatchObject({
      target_main_jid: GROUP_JID,
      binding_mode: 'single_context',
    });
  });

  test('a concurrent write during checkThreadCapableBinding is not clobbered by the pre-await snapshot', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-toctou-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ TOCTOU bot ${suffix}`,
      secret_ref: `channel-account:qq-toctou-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    // checkThreadCapableBinding awaits deps.getChannelChatInfo — a real
    // network call in production (e.g. Feishu getFeishuChatInfo). Use that
    // await as the injection point to simulate a concurrent write landing
    // on this exact imJid (e.g. the message router auto-learning
    // owner_im_id, or a second bind request) while the first request is
    // still suspended.
    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          owner_im_id: 'concurrent-writer',
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status } = await req('/sessions/main/im-binding', 'PUT', {
        im_jid: imJid,
      });
      expect(status).toBe(200);
      const after = db.getRegisteredGroup(imJid);
      // Both writes must survive: the intended bind (this request) and the
      // concurrent write that landed mid-await. A stale pre-await snapshot
      // would silently overwrite owner_im_id back to its original value.
      expect(after).toMatchObject({
        target_main_jid: GROUP_JID,
        binding_mode: 'single_context',
        owner_im_id: 'concurrent-writer',
      });
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a concurrent ownership transfer during checkThreadCapableBinding is rejected, not silently applied', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-reauth-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ reauth bot ${suffix}`,
      secret_ref: `channel-account:qq-reauth-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    // The pre-await canModifyGroup/hasConsistentChannelAccount checks only
    // proved authorization against the row as it existed BEFORE the await.
    // Simulate the row's ownership transferring to a different user (e.g.
    // credential transfer, delete+recreate) during that await, and confirm
    // the fresh re-read is re-authorized rather than committing a mutation
    // that crosses the original authorization boundary.
    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          created_by: OUTSIDER_ID,
          channel_account_id: undefined,
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status, body } = await req('/sessions/main/im-binding', 'PUT', {
        im_jid: imJid,
      });
      expect(status).toBe(403);
      expect(body.error).toMatch(/forbidden/i);
      // The mutation must not have been applied — the row still reflects
      // only the concurrent write, not this request's intended bind.
      const after = db.getRegisteredGroup(imJid);
      expect(after?.target_main_jid).not.toBe(GROUP_JID);
      expect(after?.created_by).toBe(OUTSIDER_ID);
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('native thread containers reject a fixed session target', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Fixed session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `telegram-forum-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Forum bot',
      secret_ref: `channel-account:telegram-forum-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `telegram:forum-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Telegram Forum',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'thread',
    });

    const { status, body } = await req(
      `/sessions/${sessionId}/im-binding`,
      'PUT',
      { im_jid: imJid },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/native thread/i);
    expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
  });

  test('a concurrent none->thread upgrade during the live chat-info fetch is still rejected for a session bind', async () => {
    // The pre-await snapshot has native_context_type: 'none' (ordinary
    // session-bindable chat). Simulate the message router upgrading it to
    // a native thread container (native_context_type: 'thread') WHILE the
    // live chat-info fetch is in flight. threadCapable must be computed
    // against the fresh row, not the stale pre-await one — otherwise this
    // request would incorrectly bind a now-thread-capable container as a
    // fixed single session, breaking that thread's session isolation from
    // its siblings.
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Racing session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `telegram-race-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: `Forum race bot ${suffix}`,
      secret_ref: `channel-account:telegram-race-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `telegram:forum-race-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Telegram Forum (about to upgrade)',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          native_context_type: 'thread',
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status, body } = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        { im_jid: imJid },
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/native thread/i);
      // The bind must not have been applied.
      expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a concurrent none->thread upgrade during the live chat-info fetch routes a workspace bind as thread_map, not single_session', async () => {
    // Same race as above, but for the workspace-bind branch (sessionId
    // 'main'), where threadCapable decides thread_map vs single_session
    // routing mode rather than an outright rejection.
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `telegram-race-ws-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: `Forum race workspace bot ${suffix}`,
      secret_ref: `channel-account:telegram-race-ws-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `telegram:forum-race-ws-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Telegram Forum (about to upgrade, workspace bind)',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          native_context_type: 'thread',
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status } = await req('/sessions/main/im-binding', 'PUT', {
        im_jid: imJid,
      });
      expect(status).toBe(200);
      // A stale (pre-upgrade) computation would have produced
      // 'single_session' here instead.
      expect(db.getRegisteredGroup(imJid)?.binding_mode).toBe('thread_map');
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('deleting a session binding restores the account default workspace', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Temporary session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `whatsapp-default-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'whatsapp',
      name: 'WhatsApp account',
      secret_ref: `channel-account:whatsapp-default-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `whatsapp:user-${suffix}@s.whatsapp.net#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'WhatsApp chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      target_agent_id: sessionId,
      activation_mode: 'when_mentioned',
      owner_im_id: 'owner-im',
      sender_allowlist: ['owner-im'],
      reply_policy: 'mirror',
    });

    const { status, body } = await req(
      `/sessions/${sessionId}/im-binding/${encodeURIComponent(imJid)}`,
      'DELETE',
    );
    expect(status).toBe(200);
    expect(body.target_main_jid).toBe(GROUP_JID);
    expect(db.getRegisteredGroup(imJid)).toMatchObject({
      target_main_jid: GROUP_JID,
      target_agent_id: undefined,
      binding_mode: 'single_context',
      activation_mode: 'when_mentioned',
      owner_im_id: 'owner-im',
      sender_allowlist: ['owner-im'],
      reply_policy: 'source_only',
    });
  });

  test('multiple native-context containers can share one workspace', () => {
    asUser(OWNER_ID);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspaceJid = `web:native-upgrade-${suffix}`;
    const firstJid = `telegram:forum-upgrade-a-${suffix}`;
    const secondJid = `telegram:forum-upgrade-b-${suffix}`;
    db.setRegisteredGroup(workspaceJid, {
      name: 'Native upgrade workspace',
      folder: `native-upgrade-${suffix}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    const base = {
      name: 'Forum',
      folder: `native-upgrade-${suffix}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      target_main_jid: workspaceJid,
      binding_mode: 'single_context' as const,
      native_context_type: 'thread' as const,
    };
    db.setRegisteredGroup(firstJid, base);
    db.setRegisteredGroup(secondJid, base);

    expect(
      mountService.upgradeNativeContextChannelMount(firstJid, base),
    ).toMatchObject({
      status: 'upgraded',
      updated: { binding_mode: 'thread_map' },
    });
    expect(
      mountService.upgradeNativeContextChannelMount(secondJid, base),
    ).toMatchObject({
      status: 'upgraded',
      updated: { binding_mode: 'thread_map' },
    });
    expect(db.getRegisteredGroup(firstJid)?.binding_mode).toBe('thread_map');
    expect(db.getRegisteredGroup(secondJid)?.binding_mode).toBe('thread_map');

    db.deleteRegisteredGroup(firstJid);
    db.deleteRegisteredGroup(secondJid);
    db.deleteRegisteredGroup(workspaceJid);
  });

  test('REST restore detaches native navigation only after the last source leaves', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const defaultWorkspaceJid = `web:native-default-${suffix}`;
    db.setRegisteredGroup(defaultWorkspaceJid, {
      name: 'Native default workspace',
      folder: `native-default-${suffix}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });

    const sourceJids: string[] = [];
    for (const name of ['first', 'second']) {
      const account = db.createChannelAccount({
        id: `native-restore-${name}-${suffix}`,
        owner_user_id: OWNER_ID,
        provider: name === 'first' ? 'feishu' : 'telegram',
        name: `${name} bot`,
        secret_ref: `channel-account:native-restore-${name}-${suffix}`,
        default_workspace_jid: defaultWorkspaceJid,
      });
      const sourceJid = `${account.provider}:native-${name}-${suffix}#account:${account.id}`;
      sourceJids.push(sourceJid);
      db.setRegisteredGroup(sourceJid, {
        name: `${name} native container`,
        folder: GROUP_FOLDER,
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        channel_account_id: account.id,
        native_context_type: 'thread',
      });

      const bound = await req('/sessions/main/im-binding', 'PUT', {
        im_jid: sourceJid,
      });
      expect(bound.status, JSON.stringify(bound.body)).toBe(200);
      expect(db.getRegisteredGroup(sourceJid)).toMatchObject({
        target_main_jid: GROUP_JID,
        binding_mode: 'thread_map',
      });
    }

    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const firstRestored = await req(
      `/im-binding/${encodeURIComponent(sourceJids[0])}`,
      'DELETE',
    );
    expect(firstRestored.status, JSON.stringify(firstRestored.body)).toBe(200);
    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const lastRestored = await req(
      `/im-binding/${encodeURIComponent(sourceJids[1])}`,
      'DELETE',
    );
    expect(lastRestored.status, JSON.stringify(lastRestored.body)).toBe(200);
    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
    expect(db.getRegisteredGroup(defaultWorkspaceJid)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    for (const sourceJid of sourceJids) db.deleteRegisteredGroup(sourceJid);
    db.deleteRegisteredGroup(defaultWorkspaceJid);
  });
});
