import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-workspaces-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'routes-workspace-owner',
      username: process.env.HAPPYCLAW_TEST_USER_ID ?? 'routes-workspace-owner',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const routeModule = await import('../src/routes/workspaces.js');
const routes = routeModule.default;

const OWNER_ID = 'routes-workspace-owner';
const MEMBER_ID = 'routes-workspace-member';
const STRANGER_ID = 'routes-workspace-stranger';
const OTHER_OWNER_ID = 'routes-workspace-other-owner';

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function createUser(id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

beforeAll(() => {
  db.initDatabase();
  for (const id of [OWNER_ID, MEMBER_ID, STRANGER_ID, OTHER_OWNER_ID]) {
    createUser(id);
  }
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('/api/workspaces canonical read routes', () => {
  test('owner can list workspace summaries and inspect sessions plus mounts', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Canonical Agent',
      identityPrompt: 'Operate from canonical workspace state.',
    });
    db.setRegisteredGroup('web:canonical-owned', {
      name: 'Canonical Owned',
      folder: 'canonical-owned',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('canonical-owned', profile.id);
    db.setSession('canonical-owned', 'claude-canonical-main', '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });
    db.setRegisteredGroup('telegram:canonical-owned-chat', {
      name: 'Canonical Telegram',
      folder: 'owner-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      target_main_jid: 'web:canonical-owned',
      reply_policy: 'mirror',
    });

    asUser(OWNER_ID);
    const listRes = await routes.request('/', { method: 'GET' });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.workspaces).toContainEqual(
      expect.objectContaining({
        jid: 'web:canonical-owned',
        folder: 'canonical-owned',
        owner_user_id: OWNER_ID,
        runtime_session_count: 1,
        channel_mount_count: 1,
        agent_profile: expect.objectContaining({
          id: profile.id,
          version: profile.version,
        }),
      }),
    );

    const detailRes = await routes.request('/web:canonical-owned', {
      method: 'GET',
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.runtime_sessions).toEqual([
      expect.objectContaining({
        runtime_agent_id: '',
        sdk_session_id: 'claude-canonical-main',
        agent_profile_id: profile.id,
        agent_profile_version: profile.version,
      }),
    ]);
    expect(detailBody.channel_mounts).toEqual([
      expect.objectContaining({
        channel_jid: 'telegram:canonical-owned-chat',
        workspace_jid: 'web:canonical-owned',
        workspace_folder: 'canonical-owned',
        session_id: null,
        routing_mode: 'single_session',
        reply_policy: 'mirror',
        agent_profile_id: profile.id,
      }),
    ]);
  });

  test('shared members can read shared canonical workspaces but strangers cannot', async () => {
    const sharedProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Shared Owner Agent',
      runtimePolicy: {
        provider_id: 'owner-private-provider',
        skills: { mode: 'disabled', ids: [] },
        mcp: { mode: 'disabled', ids: [] },
        tools: { mode: 'restricted' },
      },
    });
    db.setRegisteredGroup('web:canonical-shared', {
      name: 'Canonical Shared',
      folder: 'canonical-shared',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('canonical-shared', sharedProfile.id);
    db.setSessionProviderId('canonical-shared', '', 'owner-private-provider');
    db.setSession('canonical-shared', 'owner-private-sdk-session', '', {
      agentProfileId: sharedProfile.id,
      agentProfileVersion: sharedProfile.version,
      identityHash: sharedProfile.identity_hash,
    });
    db.setRegisteredGroup('telegram:canonical-shared-private-channel', {
      name: 'Owner Private Telegram',
      folder: 'owner-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      target_main_jid: 'web:canonical-shared',
      owner_im_id: 'owner-private-im-id',
    });
    db.addGroupMember('canonical-shared', MEMBER_ID, 'member', OWNER_ID);

    asUser(MEMBER_ID);
    const memberListRes = await routes.request('/', { method: 'GET' });
    expect(memberListRes.status).toBe(200);
    const memberListBody = await memberListRes.json();
    const sharedSummary = memberListBody.workspaces.find(
      (workspace: { jid: string }) => workspace.jid === 'web:canonical-shared',
    );
    expect(sharedSummary).toMatchObject({
      jid: 'web:canonical-shared',
      can_modify: false,
      can_manage_members: false,
      agent_profile: {
        id: sharedProfile.id,
        name: sharedProfile.name,
        version: sharedProfile.version,
      },
    });
    expect(sharedSummary).not.toHaveProperty('owner_user_id');
    expect(sharedSummary).not.toHaveProperty('execution_mode');
    expect(sharedSummary).not.toHaveProperty('runtime_session_count');
    expect(sharedSummary).not.toHaveProperty('channel_mount_count');
    expect(sharedSummary.agent_profile).not.toHaveProperty('runtime_policy');
    expect(sharedSummary.agent_profile).not.toHaveProperty('identity_hash');

    const memberDetailRes = await routes.request('/web:canonical-shared', {
      method: 'GET',
    });
    expect(memberDetailRes.status).toBe(200);
    const memberDetail = await memberDetailRes.json();
    expect(memberDetail).not.toHaveProperty('runtime_sessions');
    expect(memberDetail).not.toHaveProperty('channel_mounts');

    const runtimeSessionsRes = await routes.request(
      '/web:canonical-shared/runtime-sessions',
      { method: 'GET' },
    );
    expect(runtimeSessionsRes.status).toBe(403);
    const channelMountsRes = await routes.request(
      '/web:canonical-shared/channel-mounts',
      { method: 'GET' },
    );
    expect(channelMountsRes.status).toBe(403);
    const allMountsRes = await routes.request('/mounts', { method: 'GET' });
    const allMountsBody = await allMountsRes.json();
    expect(allMountsBody.channel_mounts).not.toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:canonical-shared-private-channel',
      }),
    );

    asUser(STRANGER_ID);
    const strangerListRes = await routes.request('/', { method: 'GET' });
    const strangerListBody = await strangerListRes.json();
    expect(strangerListBody.workspaces).not.toContainEqual(
      expect.objectContaining({ jid: 'web:canonical-shared' }),
    );
    const strangerDetailRes = await routes.request('/web:canonical-shared', {
      method: 'GET',
    });
    expect(strangerDetailRes.status).toBe(404);
  });

  test('mount listing is filtered by visible workspaces', async () => {
    db.setRegisteredGroup('web:canonical-other', {
      name: 'Other Owner Workspace',
      folder: 'canonical-other',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OTHER_OWNER_ID,
      is_home: false,
    });
    db.setRegisteredGroup('telegram:canonical-other-chat', {
      name: 'Other Telegram',
      folder: 'other-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OTHER_OWNER_ID,
      target_main_jid: 'web:canonical-other',
    });

    asUser(OWNER_ID);
    const res = await routes.request('/mounts', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel_mounts).toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:canonical-owned-chat',
        workspace_jid: 'web:canonical-owned',
      }),
    );
    expect(body.channel_mounts).not.toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:canonical-other-chat',
      }),
    );
  });
});
