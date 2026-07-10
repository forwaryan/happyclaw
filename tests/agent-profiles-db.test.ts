import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-db-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const {
  initDatabase,
  createUser,
  listAgentProfilesForUser,
  createAgentProfile,
  updateAgentProfile,
  archiveAgentProfile,
  assignWorkspaceAgentProfile,
  deleteWorkspaceAgentProfile,
  getAgentProfileForWorkspace,
  getWorkspaceAgentProfileId,
  setRegisteredGroup,
  setSession,
  getSessionAgentIdentity,
  computeAgentProfileIdentityHash,
  normalizeAgentProfileRuntimePolicy,
  getAgentChannelMount,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedUser(id: string): void {
  const now = new Date().toISOString();
  createUser({
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

describe('AgentProfile DB model', () => {
  test('creates one default AgentProfile for every new user', () => {
    seedUser('agent-profile-user-a');

    const profiles = listAgentProfilesForUser('agent-profile-user-a');

    expect(profiles).toHaveLength(1);
    expect(profiles[0].is_default).toBe(true);
    expect(profiles[0].name).toBe('Default Agent');
    expect(profiles[0].identity_prompt).toBe('');
    expect(profiles[0].include_claude_preset).toBe(true);
    expect(profiles[0].runtime_policy).toEqual({
      provider_id: null,
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
      tools: { mode: 'inherit' },
    });
    expect(profiles[0].identity_hash).toBe(
      computeAgentProfileIdentityHash('', true, undefined, 'Default Agent'),
    );
  });

  test('ignores historical AgentProfile model policy when normalizing', () => {
    expect(
      normalizeAgentProfileRuntimePolicy({
        provider_id: 'provider-a',
        model: 'claude-opus-4-1',
        tools: { mode: 'readonly' },
      } as any),
    ).toEqual({
      provider_id: 'provider-a',
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
      tools: { mode: 'readonly' },
    });
  });

  test('maps a workspace to the selected AgentProfile', () => {
    seedUser('agent-profile-user-b');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-b',
      name: 'Research Agent',
      identityPrompt: '以研究员身份回答。',
      includeClaudePreset: false,
    });
    const folder = 'agent-profile-workspace-b';
    setRegisteredGroup('web:agent-profile-workspace-b', {
      name: 'Workspace B',
      folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'agent-profile-user-b',
    });

    assignWorkspaceAgentProfile(folder, profile.id);

    expect(getWorkspaceAgentProfileId(folder)).toBe(profile.id);
    const mapped = getAgentProfileForWorkspace(folder, 'agent-profile-user-b');
    expect(mapped?.id).toBe(profile.id);
    expect(mapped?.include_claude_preset).toBe(false);
    expect(mapped?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '以研究员身份回答。',
        false,
        undefined,
        'Research Agent',
      ),
    );
  });

  test('updates identity hash and version when name, prompt, or preset mode changes', () => {
    seedUser('agent-profile-user-c');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-c',
      name: 'Coder',
      identityPrompt: '写代码前先读上下文。',
    });

    const renamed = updateAgentProfile(profile.id, 'agent-profile-user-c', {
      name: 'Coder Renamed',
    });
    expect(renamed?.version).toBe(profile.version + 1);
    expect(renamed?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '写代码前先读上下文。',
        true,
        undefined,
        'Coder Renamed',
      ),
    );
    const sameName = updateAgentProfile(profile.id, 'agent-profile-user-c', {
      name: 'Coder Renamed',
    });
    expect(sameName?.version).toBe(renamed?.version);
    expect(sameName?.identity_hash).toBe(renamed?.identity_hash);

    const updated = updateAgentProfile(profile.id, 'agent-profile-user-c', {
      identityPrompt: '先读上下文，再给最小可行改动。',
    });
    expect(updated?.version).toBe((renamed?.version ?? 0) + 1);
    expect(updated?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '先读上下文，再给最小可行改动。',
        true,
        undefined,
        'Coder Renamed',
      ),
    );

    const presetToggled = updateAgentProfile(
      profile.id,
      'agent-profile-user-c',
      {
        includeClaudePreset: false,
      },
    );
    expect(presetToggled?.version).toBe((updated?.version ?? 0) + 1);
    expect(presetToggled?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '先读上下文，再给最小可行改动。',
        false,
        undefined,
        'Coder Renamed',
      ),
    );
  });

  test('versions AgentProfile runtime policy changes', () => {
    seedUser('agent-profile-user-policy');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-policy',
      name: 'Policy Agent',
      identityPrompt: '按策略运行。',
      runtimePolicy: {
        provider_id: 'provider-a',
        skills: { mode: 'custom', ids: ['review', 'research', 'review'] },
        mcp: { mode: 'disabled', ids: ['ignored'] },
        tools: { mode: 'readonly' },
      },
    });

    expect(profile.runtime_policy).toEqual({
      provider_id: 'provider-a',
      skills: { mode: 'custom', ids: ['review', 'research'] },
      mcp: { mode: 'disabled', ids: ['ignored'] },
      tools: { mode: 'readonly' },
    });
    expect(profile.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '按策略运行。',
        true,
        profile.runtime_policy,
        'Policy Agent',
      ),
    );

    const samePolicy = updateAgentProfile(
      profile.id,
      'agent-profile-user-policy',
      {
        runtimePolicy: profile.runtime_policy,
      },
    );
    expect(samePolicy?.version).toBe(profile.version);

    const updated = updateAgentProfile(
      profile.id,
      'agent-profile-user-policy',
      {
        runtimePolicy: {
          provider_id: 'provider-b',
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'custom', ids: ['github'] },
          tools: { mode: 'restricted' },
        },
      },
    );
    expect(updated?.version).toBe(profile.version + 1);
    expect(updated?.runtime_policy).toEqual({
      provider_id: 'provider-b',
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'custom', ids: ['github'] },
      tools: { mode: 'restricted' },
    });
    expect(updated?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '按策略运行。',
        true,
        updated?.runtime_policy,
        'Policy Agent',
      ),
    );
  });

  test('deep-merges partial runtime policy patches without reopening siblings', () => {
    seedUser('agent-profile-user-policy-merge');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-policy-merge',
      name: 'Strict Policy Agent',
      runtimePolicy: {
        provider_id: 'provider-fixed',
        skills: { mode: 'disabled', ids: ['kept-for-audit'] },
        mcp: { mode: 'custom', ids: ['github'] },
        tools: { mode: 'restricted' },
      },
    });

    const updated = updateAgentProfile(
      profile.id,
      'agent-profile-user-policy-merge',
      { runtimePolicy: { tools: { mode: 'readonly' } } },
    );

    expect(updated?.runtime_policy).toEqual({
      provider_id: 'provider-fixed',
      skills: { mode: 'disabled', ids: ['kept-for-audit'] },
      mcp: { mode: 'custom', ids: ['github'] },
      tools: { mode: 'readonly' },
    });
  });

  test('stores AgentProfile identity metadata on sessions', () => {
    seedUser('agent-profile-user-d');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-d',
      name: 'Planner',
      identityPrompt: '先拆计划再执行。',
    });

    setSession('agent-profile-workspace-d', 'session-d', undefined, {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });

    expect(getSessionAgentIdentity('agent-profile-workspace-d')).toEqual({
      agent_profile_id: profile.id,
      agent_profile_version: profile.version,
      identity_hash: profile.identity_hash,
    });
  });

  test('does not archive an AgentProfile that still owns workspaces', () => {
    seedUser('agent-profile-user-e');
    const [defaultProfile] = listAgentProfilesForUser('agent-profile-user-e');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-e',
      name: 'Ops',
      identityPrompt: '关注运行风险。',
    });
    const folder = 'agent-profile-workspace-e';
    assignWorkspaceAgentProfile(folder, profile.id);

    expect(archiveAgentProfile(profile.id, 'agent-profile-user-e')).toBe(
      'has_workspaces',
    );

    assignWorkspaceAgentProfile(folder, defaultProfile.id);
    expect(archiveAgentProfile(profile.id, 'agent-profile-user-e')).toBe('ok');
  });

  test('removes stale AgentProfile ownership from channel projections when mapping is deleted', () => {
    seedUser('agent-profile-user-f');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-f',
      name: 'Channels',
      identityPrompt: '负责 IM 渠道。',
    });
    const folder = 'agent-profile-workspace-f';
    setRegisteredGroup('web:agent-profile-workspace-f', {
      name: 'Workspace F',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'agent-profile-user-f',
    });
    assignWorkspaceAgentProfile(folder, profile.id);
    setRegisteredGroup('telegram:agent-profile-channel-f', {
      name: 'Telegram F',
      folder: 'home-f',
      added_at: new Date().toISOString(),
      created_by: 'agent-profile-user-f',
      target_main_jid: 'web:agent-profile-workspace-f',
    });

    deleteWorkspaceAgentProfile(folder);
    expect(
      getAgentChannelMount('telegram:agent-profile-channel-f'),
    ).toMatchObject({ agent_profile_id: null });
    expect(archiveAgentProfile(profile.id, 'agent-profile-user-f')).toBe('ok');
  });
});
