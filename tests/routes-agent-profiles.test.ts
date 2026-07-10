import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-agent-profiles-'));
const tmpDataDir = path.join(tmpDir, 'data');
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDataDir,
  ASSISTANT_NAME: 'HappyClaw Test',
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/agent-profile-generator.js', () => ({
  generateAgentProfileDraft: vi.fn(async (description: string) => ({
    name: description.includes('评审') ? '代码评审 Agent' : 'AI Agent',
    identity_prompt: `根据描述生成：${description}`,
  })),
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'routes-agent-user',
      username: 'routes-agent-user',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const webContext = await import('../src/web-context.js');
const agentProfileRuntime = await import('../src/agent-profile-runtime.js');
const routeModule = await import('../src/routes/agent-profiles.js');
const routes = routeModule.default;
let testProviderId = '';

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'routes-agent-user',
    username: 'routes-agent-user',
    password_hash: 'hash',
    display_name: 'Routes Agent User',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  testProviderId = runtimeConfig.createProvider({
    name: 'Routes Test Provider',
    type: 'third_party',
    enabled: true,
    anthropicBaseUrl: 'https://provider.example.test',
    anthropicAuthToken: 'routes-test-token',
    anthropicModel: 'claude-test',
  }).id;
  const skillDir = path.join(
    tmpDataDir,
    'skills',
    'routes-agent-user',
    'research',
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: Research\ndescription: Test research skill\n---\n',
  );
  const mcpDir = path.join(tmpDataDir, 'mcp-servers', 'routes-agent-user');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(
    path.join(mcpDir, 'servers.json'),
    JSON.stringify({
      servers: {
        github: {
          command: 'node',
          args: ['github-mcp.js'],
          enabled: true,
          addedAt: '2026-07-10T00:00:00.000Z',
        },
      },
    }),
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('/api/agent-profiles routes', () => {
  test('GET returns the default AgentProfile', async () => {
    const res = await routes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].is_default).toBe(true);
  });

  test('POST creates and PATCH updates an AgentProfile', async () => {
    const createdRes = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Research',
        identity_prompt: '用研究员方式回答。',
        include_claude_preset: false,
        runtime_policy: {
          provider_id: testProviderId,
          skills: { mode: 'custom', ids: ['research'] },
          mcp: { mode: 'inherit', ids: [] },
          tools: { mode: 'readonly' },
        },
      }),
    });
    expect(createdRes.status).toBe(201);
    const createdBody = await createdRes.json();
    const created = createdBody.profile;
    expect(created.name).toBe('Research');
    expect(created.include_claude_preset).toBe(false);
    expect(created.runtime_policy).toMatchObject({
      provider_id: testProviderId,
      skills: { mode: 'custom', ids: ['research'] },
      tools: { mode: 'readonly' },
    });
    expect(created.version).toBe(1);

    const patchedRes = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Research Lead',
        identity_prompt: '先列证据，再给结论。',
        include_claude_preset: true,
        runtime_policy: {
          provider_id: null,
          skills: { mode: 'disabled', ids: [] },
          mcp: { mode: 'custom', ids: ['github'] },
          tools: { mode: 'restricted' },
        },
      }),
    });
    expect(patchedRes.status).toBe(200);
    const patchedBody = await patchedRes.json();
    expect(patchedBody.profile.name).toBe('Research Lead');
    expect(patchedBody.profile.include_claude_preset).toBe(true);
    expect(patchedBody.profile.runtime_policy).toMatchObject({
      provider_id: null,
      skills: { mode: 'disabled', ids: [] },
      mcp: { mode: 'custom', ids: ['github'] },
      tools: { mode: 'restricted' },
    });
    expect(patchedBody.profile.version).toBe(2);
  });

  test('rejects AgentProfile model policy because models are configured by providers', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'No Model Policy',
        identity_prompt: '不要在 Agent 层设置模型。',
        runtime_policy: {
          provider_id: null,
          model: 'claude-opus-4-1',
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  test('rejects unavailable provider, Skill, and MCP references instead of failing open', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid References',
        runtime_policy: {
          provider_id: 'missing-provider',
          skills: { mode: 'custom', ids: ['missing-skill'] },
          mcp: { mode: 'custom', ids: ['missing-mcp'] },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      invalid_runtime_policy: {
        providers: ['missing-provider'],
        skills: ['missing-skill'],
        mcp: ['missing-mcp'],
      },
    });
  });

  test('PATCH deep-merges nested runtime policy fields', async () => {
    const created = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Merge Policy',
      runtimePolicy: {
        provider_id: testProviderId,
        skills: { mode: 'custom', ids: ['research'] },
        mcp: { mode: 'custom', ids: ['github'] },
        tools: { mode: 'restricted' },
      },
    });

    const res = await routes.request(`/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runtime_policy: { tools: { mode: 'readonly' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.runtime_policy).toEqual({
      provider_id: testProviderId,
      skills: { mode: 'custom', ids: ['research'] },
      mcp: { mode: 'custom', ids: ['github'] },
      tools: { mode: 'readonly' },
    });
  });

  test('rejects blank names after trim', async () => {
    const res = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /generate returns an AI AgentProfile draft', async () => {
    const res = await routes.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '帮我做代码评审，重点看风险。' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual({
      name: '代码评审 Agent',
      identity_prompt: '根据描述生成：帮我做代码评审，重点看风险。',
    });
  });

  test('POST /generate rejects blank descriptions', async () => {
    const res = await routes.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  test('does not delete the default AgentProfile', async () => {
    const [defaultProfile] = db.listAgentProfilesForUser('routes-agent-user');
    const res = await routes.request(`/${defaultProfile.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  test('DELETE succeeds after workspace mapping removal also clears mount ownership', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Mounted Agent',
      identityPrompt: '负责 IM 挂载。',
    });
    db.setRegisteredGroup('web:routes-mounted-workspace', {
      name: 'Mounted Workspace',
      folder: 'routes-mounted-workspace',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile('routes-mounted-workspace', profile.id);
    db.setRegisteredGroup('telegram:routes-mounted-channel', {
      name: 'Mounted Channel',
      folder: 'routes-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
      target_main_jid: 'web:routes-mounted-workspace',
    });
    db.deleteWorkspaceAgentProfile('routes-mounted-workspace');
    expect(
      db.getAgentChannelMount('telegram:routes-mounted-channel'),
    ).toMatchObject({ agent_profile_id: null });

    const res = await routes.request(`/${profile.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  test('GET /:id/workspaces includes session and channel mount governance data', async () => {
    const [defaultProfile] = db.listAgentProfilesForUser('routes-agent-user');
    db.setRegisteredGroup('web:routes-agent-workspace', {
      name: 'Routes Agent Workspace',
      folder: 'routes-agent-workspace',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('routes-agent-workspace', defaultProfile.id);
    db.setSession('routes-agent-workspace', 'claude-routes-session', '', {
      agentProfileId: defaultProfile.id,
      agentProfileVersion: defaultProfile.version,
      identityHash: defaultProfile.identity_hash,
    });
    db.setRegisteredGroup('telegram:routes-agent-mount', {
      name: 'Routes Telegram',
      folder: 'routes-agent-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'routes-agent-user',
      target_main_jid: 'web:routes-agent-workspace',
      reply_policy: 'mirror',
    });

    const res = await routes.request(`/${defaultProfile.id}/workspaces`, {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaces).toContainEqual(
      expect.objectContaining({
        jid: 'web:routes-agent-workspace',
        folder: 'routes-agent-workspace',
        runtime_sessions: [
          expect.objectContaining({
            runtime_agent_id: '',
            sdk_session_id: 'claude-routes-session',
            agent_profile_id: defaultProfile.id,
            agent_profile_version: defaultProfile.version,
          }),
        ],
      }),
    );
    expect(body.channel_mounts).toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:routes-agent-mount',
        workspace_jid: 'web:routes-agent-workspace',
        workspace_folder: 'routes-agent-workspace',
        session_id: null,
        routing_mode: 'single_session',
        reply_policy: 'mirror',
      }),
    );
  });

  test('does not persist identity changes when Runner invalidation partially fails, and identical retry succeeds', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Retryable Identity',
      identityPrompt: 'old identity',
    });
    for (const suffix of ['a', 'b']) {
      db.setRegisteredGroup(`web:retry-invalidation-${suffix}`, {
        name: `Retry ${suffix}`,
        folder: `retry-invalidation-${suffix}`,
        added_at: '2026-07-10T00:00:00.000Z',
        created_by: 'routes-agent-user',
      });
      db.assignWorkspaceAgentProfile(
        `retry-invalidation-${suffix}`,
        profile.id,
      );
    }

    let failOnce = true;
    const stopGroup = vi.fn(async (jid: string) => {
      if (jid === 'web:retry-invalidation-b' && failOnce) {
        failOnce = false;
        throw new Error('injected stop failure');
      }
    });
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['retry-invalidation'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const request = () =>
      routes.request(`/${profile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity_prompt: 'new identity' }),
      });

    const failed = await request();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      persisted: false,
      retryable: true,
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toMatchObject({
      identity_prompt: 'old identity',
      version: profile.version,
    });

    const retried = await request();
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json();
    expect(retriedBody.profile).toMatchObject({
      identity_prompt: 'new identity',
      version: profile.version + 1,
    });
    expect(
      stopGroup.mock.calls.filter(
        ([jid]) => jid === 'web:retry-invalidation-a',
      ),
    ).toHaveLength(3);
    expect(
      stopGroup.mock.calls.filter(
        ([jid]) => jid === 'web:retry-invalidation-b',
      ),
    ).toHaveLength(3);
  });

  test('reports persisted post-stop failure and identical sensitive retry cleans up without another version bump', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Post Commit Retry Identity',
      identityPrompt: 'old post-commit identity',
    });
    db.setRegisteredGroup('web:post-commit-invalidation', {
      name: 'Post Commit Invalidation',
      folder: 'post-commit-invalidation',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile('post-commit-invalidation', profile.id);

    let stopCalls = 0;
    const stopGroup = vi.fn(async () => {
      stopCalls += 1;
      if (stopCalls === 2) {
        throw new Error('injected post-commit cleanup failure');
      }
    });
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['post-commit'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const request = () =>
      routes.request(`/${profile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity_prompt: 'new post-commit identity' }),
      });

    const failedCleanup = await request();
    expect(failedCleanup.status).toBe(503);
    expect(await failedCleanup.json()).toMatchObject({
      persisted: true,
      retryable: true,
      profile: {
        identity_prompt: 'new post-commit identity',
        version: profile.version + 1,
      },
    });
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toMatchObject({
      identity_prompt: 'new post-commit identity',
      version: profile.version + 1,
    });

    const retried = await request();
    expect(retried.status).toBe(200);
    expect((await retried.json()).profile).toMatchObject({
      identity_prompt: 'new post-commit identity',
      version: profile.version + 1,
    });
    expect(stopGroup).toHaveBeenCalledTimes(4);
  });

  test('name-only PATCH bumps identity version/hash, quiesces twice, and leaves the old session hash mismatched', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Old Prompt Name',
      identityPrompt: 'Name is part of the injected identity.',
    });
    const folder = 'name-identity-workspace';
    db.setRegisteredGroup('web:name-identity-workspace', {
      name: 'Name Identity Workspace',
      folder,
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'routes-agent-user',
    });
    db.assignWorkspaceAgentProfile(folder, profile.id);
    db.setSession(folder, 'sdk-name-identity', '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });
    const stopGroup = vi.fn(async () => {});
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const res = await routes.request(`/${profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Prompt Name' }),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()).profile;
    expect(updated).toMatchObject({
      name: 'New Prompt Name',
      version: profile.version + 1,
    });
    expect(updated.identity_hash).not.toBe(profile.identity_hash);
    expect(stopGroup).toHaveBeenCalledTimes(2);
    expect(db.getSessionAgentIdentity(folder)).toMatchObject({
      agent_profile_version: profile.version,
      identity_hash: profile.identity_hash,
    });
    expect(db.getSessionAgentIdentity(folder)?.identity_hash).not.toBe(
      updated.identity_hash,
    );
  });

  test('DELETE waits for membership publication and then refuses to archive the target', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: 'routes-agent-user',
      name: 'Delete Membership Race',
    });
    const folder = 'delete-membership-race';
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publisher = agentProfileRuntime.withAgentProfileLocks(
      [profile.id],
      async () => {
        entered();
        await gate;
        db.setRegisteredGroup('web:delete-membership-race', {
          name: 'Delete Membership Race',
          folder,
          added_at: '2026-07-10T00:00:00.000Z',
          created_by: 'routes-agent-user',
        });
        db.assignWorkspaceAgentProfile(folder, profile.id);
      },
    );
    await enteredPromise;

    const deleteResponsePromise = routes.request(`/${profile.id}`, {
      method: 'DELETE',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.getWorkspaceAgentProfileId(folder)).toBeUndefined();

    release();
    await publisher;
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status).toBe(409);
    expect(
      db.getAgentProfileForUser(profile.id, 'routes-agent-user'),
    ).toBeDefined();
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(profile.id);
  });
});
