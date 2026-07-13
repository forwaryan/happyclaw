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
});
