import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-preview-'));
const dataDir = path.join(root, 'data');
const groupsDir = path.join(dataDir, 'groups');
const externalDir = path.join(root, '.claude');

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => externalDir,
}));

const { buildAgentCapabilityPreview } =
  await import('../src/agent-capability-preview.js');

function writeSkill(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'SKILL.md'), `---\nname: ${id}\n---\n`);
}

beforeAll(() => {
  writeSkill(path.join(externalDir, 'skills'), 'shared');
  writeSkill(path.join(dataDir, 'skills', 'owner'), 'shared');
  writeSkill(path.join(dataDir, 'skills', 'owner'), 'managed-only');
  writeSkill(path.join(groupsDir, 'workspace', '.claude', 'skills'), 'shared');
  fs.mkdirSync(path.join(externalDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(externalDir, 'CLAUDE.md'), '# host');
  fs.writeFileSync(path.join(externalDir, 'rules', 'rule.md'), '# rule');
  fs.writeFileSync(
    path.join(externalDir, 'settings.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'host' } } }),
  );
  fs.mkdirSync(path.join(groupsDir, 'workspace', '.claude'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(groupsDir, 'workspace', '.mcp.json'),
    JSON.stringify({ mcpServers: { project: { command: 'project' } } }),
  );
  fs.mkdirSync(path.join(dataDir, 'mcp-servers', 'owner'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'mcp-servers', 'owner', 'servers.json'),
    JSON.stringify({
      servers: {
        shared: { enabled: true, command: 'managed' },
        managed: { enabled: true, command: 'managed' },
      },
    }),
  );
  fs.mkdirSync(path.join(dataDir, 'mcp-servers', 'system'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDir, 'mcp-servers', 'system', 'servers.json'),
    JSON.stringify({
      servers: {
        shared: {
          enabled: true,
          command: 'system-shared',
          memberAccess: 'shared',
        },
        platform: {
          enabled: true,
          command: 'system-platform',
          memberAccess: 'admin_only',
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dataDir, 'mcp-servers', 'system', 'secrets.json'),
    JSON.stringify({
      servers: { platform: { env: { SYSTEM_TOKEN: 'preview-secret' } } },
    }),
  );
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('buildAgentCapabilityPreview', () => {
  test('shows additive layers, overrides, host context and tool-boundary effects', () => {
    const preview = buildAgentCapabilityPreview({
      profile: {
        id: 'profile',
        owner_user_id: 'owner',
        name: 'Agent',
        identity_prompt: '',
        include_claude_preset: true,
        avatar_emoji: null,
        avatar_color: null,
        avatar_url: null,
        identity_hash: 'hash',
        version: 1,
        is_default: false,
        status: 'active',
        created_at: '',
        updated_at: '',
        runtime_policy: {
          context: {
            source: 'host_claude',
            auto_compact_window: 0,
            auto_compact_percentage: 0,
          },
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'inherit', ids: [] },
          tools: { mode: 'readonly' },
        },
      },
      workspace: {
        jid: 'web:workspace',
        group: {
          name: 'Workspace',
          folder: 'workspace',
          added_at: '',
          created_by: 'owner',
        },
      },
    });

    expect(preview.context).toEqual({
      source: 'host_claude',
      claudeMd: true,
      rules: 1,
    });
    expect(preview.skills.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'managed-only', source: 'managed' }),
        expect.objectContaining({
          id: 'shared',
          source: 'workspace',
          overrides: ['host', 'managed'],
        }),
      ]),
    );
    expect(preview.skills.conflicts).toContain('shared');
    expect(preview.mcp.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'shared',
          source: 'user',
          overrides: ['host', 'system'],
          available: false,
        }),
        expect.objectContaining({ id: 'platform', source: 'system' }),
        expect.objectContaining({
          id: 'project',
          source: 'workspace',
          available: false,
        }),
      ]),
    );
    expect(preview.mcp.disabledByToolBoundary).toBe(true);
  });

  test('marks admin-only system MCP unavailable to members and available to admins', () => {
    const profile = {
      id: 'credential-preview-profile',
      owner_user_id: 'owner',
      name: 'Credential Preview Agent',
      identity_prompt: '',
      include_claude_preset: true,
      avatar_emoji: null,
      avatar_color: null,
      avatar_url: null,
      identity_hash: 'hash',
      version: 1,
      is_default: false,
      status: 'active' as const,
      created_at: '',
      updated_at: '',
      runtime_policy: {
        context: {
          source: 'managed' as const,
          auto_compact_window: 0,
          auto_compact_percentage: 0,
        },
        skills: { mode: 'inherit' as const, ids: [] },
        mcp: { mode: 'inherit' as const, ids: [] },
        tools: { mode: 'inherit' as const },
      },
    };

    const memberPreview = buildAgentCapabilityPreview({
      profile,
      ownerRole: 'member',
    });
    expect(memberPreview.mcp.entries).toContainEqual(
      expect.objectContaining({
        id: 'platform',
        source: 'system',
        available: false,
        unavailableReason: 'system_admin_only',
      }),
    );
    expect(memberPreview.notes).toContain(
      '有 1 个系统 MCP 仅限管理员，普通成员 Agent 不会继承。',
    );

    const adminPreview = buildAgentCapabilityPreview({
      profile,
      ownerRole: 'admin',
    });
    expect(adminPreview.mcp.entries).toContainEqual(
      expect.objectContaining({
        id: 'platform',
        source: 'system',
        available: true,
      }),
    );
  });
});
