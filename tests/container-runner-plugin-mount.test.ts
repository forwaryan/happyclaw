/**
 * buildVolumeMounts must always mount the user's runtime/ root at
 * /workspace/plugins for any docker-mode container, so loadUserPlugins(docker)
 * paths shaped like /workspace/plugins/snapshots/<id>/<mp>/<plugin> resolve
 * inside the container. The runtime root is created on demand and re-
 * materialized on every spawn — there is no v1 cache fallback.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Several src modules (runtime-config.ts, etc.) capture DATA_DIR at module
// load via top-level `path.join(DATA_DIR, ...)`. We need a real path *before*
// any of those modules import. Stash one in process.env so the mock factory
// (which is hoisted above this file's body and runs before our `await
// import(...)` lines) can read a stable value.
const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cr-mount-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

let tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  // The captured fs/path bindings inside this factory must use the SAME
  // shared tmp dir. We can't reach `tmpDataDir` here (hoisted above its
  // initializer), so route through env.
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
    MAIN_GROUP_FOLDER: 'main',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const containerRunner = await import('../src/container-runner.js');
const catalog = await import('../src/plugin-catalog.js');
const utils = await import('../src/plugin-utils.js');
const materializer = await import('../src/plugin-materializer.js');

const { buildVolumeMounts, prepareHostPlugins, replaceHostMcpServersEnv } =
  containerRunner;
const { writeCatalogIndex, getCatalogSnapshotDir } = catalog;
const { CONTAINER_PLUGINS_PATH } = utils;
const { getUserRuntimeRoot, getUserPluginRuntimeDir } = materializer;

const USER = 'alice';

function seedCatalogSnapshot(opts: {
  marketplace: string;
  plugin: string;
  snapshot: string;
}): void {
  const dir = getCatalogSnapshotDir(
    opts.marketplace,
    opts.plugin,
    opts.snapshot,
  );
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: opts.plugin, version: '1.0.0' }),
  );

  const idx = catalog.readCatalogIndex();
  const fullId = `${opts.plugin}@${opts.marketplace}`;
  idx.marketplaces[opts.marketplace] ??= {
    name: opts.marketplace,
    sourcePath: '/host/fake',
    lastImportedAt: '2026-04-26T00:00:00.000Z',
  };
  const entry = idx.plugins[fullId] ?? {
    marketplace: opts.marketplace,
    plugin: opts.plugin,
    fullId,
    activeSnapshot: opts.snapshot,
    snapshots: {},
  };
  entry.snapshots[opts.snapshot] = {
    contentHash: opts.snapshot,
    importedAt: '2026-04-26T00:00:00.000Z',
    sourcePath: '/host/fake',
    assetCounts: {
      commands: 0,
      agents: 0,
      skills: 0,
      hooks: 0,
      mcpServers: 0,
    },
  };
  if (!entry.activeSnapshot) entry.activeSnapshot = opts.snapshot;
  idx.plugins[fullId] = entry;
  writeCatalogIndex(idx);
}

function fakeGroup(folder: string, ownerId: string) {
  return {
    name: folder,
    folder,
    added_at: '2026-04-26T00:00:00.000Z',
    created_by: ownerId,
    is_home: false,
  };
}

function writeSystemSettings(partial: Record<string, unknown>): void {
  const dir = path.join(tmpDataDir, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'system-settings.json'),
    JSON.stringify(partial),
  );
}

beforeEach(() => {
  // tmpDataDir is fixed for the file (top-level captures in runtime-config
  // can't be relocated mid-run). Wipe its contents between tests so each
  // test starts from a clean state.
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(tmpDataDir, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  }
});

describe('buildVolumeMounts — Claude Code plugins runtime mount', () => {
  test('v2 user is materialized and mounted at runtime/', () => {
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-aaa',
    });
    utils.writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    const mounts = buildVolumeMounts(
      fakeGroup('grp-x', USER) as any,
      false,
      true,
    );

    const pluginMount = mounts.find(
      (m) => m.containerPath === CONTAINER_PLUGINS_PATH,
    );
    expect(pluginMount).toBeTruthy();
    expect(pluginMount!.hostPath).toBe(getUserRuntimeRoot(USER));
    expect(pluginMount!.readonly).toBe(true);

    const expectedManifest = path.join(
      getUserPluginRuntimeDir(USER, 'sha256-aaa', 'mp1', 'p1'),
      '.claude-plugin',
      'plugin.json',
    );
    expect(fs.existsSync(expectedManifest)).toBe(true);
  });

  test('user with no plugin config still mounts an empty runtime root', () => {
    // The runtime root is created on demand so the bind-mount target exists
    // even for users who haven't enabled anything yet. The mount is a no-op
    // for the CLI (no .claude-plugin/plugin.json under it), but still present.
    const mounts = buildVolumeMounts(
      fakeGroup('grp-x', USER) as any,
      false,
      true,
    );
    const pluginMount = mounts.find(
      (m) => m.containerPath === CONTAINER_PLUGINS_PATH,
    );
    expect(pluginMount).toBeTruthy();
    expect(pluginMount!.hostPath).toBe(getUserRuntimeRoot(USER));
    expect(fs.existsSync(getUserRuntimeRoot(USER))).toBe(true);
  });
});

describe('buildVolumeMounts — Claude triad inheritance', () => {
  test('admin-owned container mounts external CLAUDE.md, rules, and skills', () => {
    const external = path.join(tmpDataDir, 'external-claude');
    fs.mkdirSync(path.join(external, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(external, 'skills', 'admin-skill'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(external, 'CLAUDE.md'), '# admin');
    fs.writeFileSync(path.join(external, 'rules', 'r.md'), '# rule');
    fs.writeFileSync(
      path.join(external, 'skills', 'admin-skill', 'SKILL.md'),
      '# skill',
    );
    writeSystemSettings({ externalClaudeDir: external });

    const mounts = buildVolumeMounts(
      fakeGroup('admin-workspace', 'admin') as any,
      false,
      true,
      undefined,
      'main',
      undefined,
      undefined,
      undefined,
      {
        id: 'host-context-agent',
        name: 'Host Context Agent',
        version: 1,
        identityHash: 'hash',
        identityPrompt: '',
        includeClaudePreset: true,
        runtimePolicy: {
          context: { source: 'host_claude' },
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'inherit', ids: [] },
          tools: { mode: 'inherit' },
        },
      } as any,
    );

    expect(mounts).toContainEqual({
      hostPath: path.join(external, 'CLAUDE.md'),
      containerPath: '/workspace/CLAUDE.md',
      readonly: true,
    });
    expect(mounts).toContainEqual({
      hostPath: path.join(external, 'rules'),
      containerPath: '/workspace/.claude/rules',
      readonly: true,
    });
    expect(mounts).toContainEqual({
      hostPath: path.join(external, 'skills'),
      containerPath: '/workspace/external-skills',
      readonly: true,
    });
  });

  test('ordinary user container does not mount admin external triad', () => {
    const external = path.join(tmpDataDir, 'external-claude');
    fs.mkdirSync(path.join(external, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(external, 'skills', 'admin-skill'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(external, 'CLAUDE.md'), '# admin');
    writeSystemSettings({ externalClaudeDir: external });

    const mounts = buildVolumeMounts(
      fakeGroup('alice-home', 'alice') as any,
      false,
      true,
      undefined,
      'alice-home',
    );

    expect(mounts.some((m) => m.containerPath === '/workspace/CLAUDE.md')).toBe(
      false,
    );
    expect(
      mounts.some((m) => m.containerPath === '/workspace/.claude/rules'),
    ).toBe(false);
    expect(
      mounts.some((m) => m.containerPath === '/workspace/external-skills'),
    ).toBe(false);
  });

  test('admin managed Agent does not mount host triad without context opt-in', () => {
    const external = path.join(tmpDataDir, 'external-claude');
    fs.mkdirSync(path.join(external, 'skills', 'admin-skill'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(external, 'CLAUDE.md'), '# admin');
    writeSystemSettings({ externalClaudeDir: external });

    const mounts = buildVolumeMounts(
      fakeGroup('admin-workspace', 'admin') as any,
      false,
      true,
      undefined,
      'main',
    );

    expect(
      mounts.some((mount) => mount.containerPath === '/workspace/CLAUDE.md'),
    ).toBe(false);
    expect(
      mounts.some(
        (mount) => mount.containerPath === '/workspace/external-skills',
      ),
    ).toBe(false);
    expect(
      mounts.some(
        (mount) => mount.containerPath === '/workspace/project-skills',
      ),
    ).toBe(true);
    expect(
      mounts.some((mount) => mount.containerPath === '/workspace/user-skills'),
    ).toBe(true);
  });
});

describe('buildVolumeMounts — AgentProfile runtime policy', () => {
  test('writes AgentProfile tools policy into the container env file', () => {
    buildVolumeMounts(
      fakeGroup('grp-policy-tools', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        id: 'agent-profile-policy',
        name: 'Policy Agent',
        version: 1,
        identityHash: 'hash',
        identityPrompt: '',
        includeClaudePreset: true,
        runtimePolicy: {
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'inherit', ids: [] },
          tools: { mode: 'readonly' },
        },
      },
    );

    const envFile = path.join(tmpDataDir, 'env', 'grp-policy-tools', 'env');
    const envContent = fs.readFileSync(envFile, 'utf-8');
    expect(envContent).toContain('HAPPYCLAW_AGENT_DISALLOWED_TOOLS=');
    expect(envContent).toContain("HAPPYCLAW_AGENT_TOOL_POLICY='readonly'");
    expect(envContent).toContain('Write');
    expect(envContent).toContain('Bash');
  });

  test('custom skills policy exposes only selected user skills', () => {
    const sourceRoot = path.join(tmpDataDir, 'skills', USER);
    fs.mkdirSync(path.join(sourceRoot, 'review'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'research'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'review', 'SKILL.md'), '# review');
    fs.writeFileSync(
      path.join(sourceRoot, 'research', 'SKILL.md'),
      '# research',
    );

    const mounts = buildVolumeMounts(
      fakeGroup('grp-policy-skills', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        id: 'agent-profile-skills',
        name: 'Skills Agent',
        version: 1,
        identityHash: 'hash',
        identityPrompt: '',
        includeClaudePreset: true,
        runtimePolicy: {
          skills: { mode: 'custom', ids: ['review'] },
          mcp: { mode: 'inherit', ids: [] },
          tools: { mode: 'inherit' },
        },
      },
    );

    const userSkillsMount = mounts.find(
      (mount) => mount.containerPath === '/workspace/user-skills',
    );
    expect(userSkillsMount).toBeTruthy();
    expect(fs.existsSync(path.join(userSkillsMount!.hostPath, 'review'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(userSkillsMount!.hostPath, 'research')),
    ).toBe(false);
  });

  test('custom skill runtimes are immutable and isolated by profile version', () => {
    const sourceRoot = path.join(tmpDataDir, 'skills', USER);
    fs.mkdirSync(path.join(sourceRoot, 'review'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'review', 'SKILL.md'), '# review');

    const profile = (version: number) => ({
      id: 'agent-profile-skills-versioned',
      name: 'Skills Agent',
      version,
      identityHash: `hash-${version}`,
      identityPrompt: '',
      includeClaudePreset: true,
      runtimePolicy: {
        skills: { mode: 'custom' as const, ids: ['review'] },
        mcp: { mode: 'inherit' as const, ids: [] },
        tools: { mode: 'inherit' as const },
      },
    });

    const v1Mounts = buildVolumeMounts(
      fakeGroup('grp-policy-skills-v1', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profile(1),
    );
    const v2Mounts = buildVolumeMounts(
      fakeGroup('grp-policy-skills-v2', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profile(2),
    );
    const v1 = v1Mounts.find(
      (mount) => mount.containerPath === '/workspace/user-skills',
    )!;
    const v2 = v2Mounts.find(
      (mount) => mount.containerPath === '/workspace/user-skills',
    )!;

    expect(v1.hostPath).not.toBe(v2.hostPath);
    expect(v1.hostPath).toContain(`${path.sep}v1${path.sep}`);
    expect(v2.hostPath).toContain(`${path.sep}v2${path.sep}`);
    expect(fs.existsSync(path.join(v1.hostPath, 'review'))).toBe(true);
    expect(fs.existsSync(path.join(v2.hostPath, 'review'))).toBe(true);
  });

  test('custom skill policy fails closed when a selected skill is deleted', () => {
    const sourceRoot = path.join(tmpDataDir, 'skills', USER);
    const skillDir = path.join(sourceRoot, 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# review');
    const profile = {
      id: 'agent-profile-deleted-skill',
      name: 'Skills Agent',
      version: 1,
      identityHash: 'hash',
      identityPrompt: '',
      includeClaudePreset: true,
      runtimePolicy: {
        skills: { mode: 'custom' as const, ids: ['review'] },
        mcp: { mode: 'inherit' as const, ids: [] },
        tools: { mode: 'inherit' as const },
      },
    };

    buildVolumeMounts(
      fakeGroup('grp-policy-skill-before-delete', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profile,
    );
    fs.unlinkSync(path.join(skillDir, 'SKILL.md'));

    expect(() =>
      buildVolumeMounts(
        fakeGroup('grp-policy-skill-after-delete', USER) as any,
        false,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        profile,
      ),
    ).toThrow(
      'AgentProfile agent-profile-deleted-skill requires unavailable skill definition review/SKILL.md',
    );
  });

  test('custom managed MCP is additive to project MCP and excludes unselected managed servers', () => {
    const mcpDir = path.join(tmpDataDir, 'mcp-servers', USER);
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'servers.json'),
      JSON.stringify({
        servers: {
          github: { enabled: true, command: 'github-mcp' },
          slack: { enabled: true, command: 'slack-mcp' },
        },
      }),
    );
    const systemMcpDir = path.join(tmpDataDir, 'mcp-servers', 'system');
    fs.mkdirSync(systemMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(systemMcpDir, 'servers.json'),
      JSON.stringify({
        servers: {
          platform: {
            enabled: true,
            command: 'platform-mcp',
            memberAccess: 'shared',
          },
        },
      }),
    );
    const workspaceDir = path.join(tmpDataDir, 'groups', 'grp-policy-mcp');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { projectDb: { command: 'project-db-mcp' } },
      }),
    );

    buildVolumeMounts(
      fakeGroup('grp-policy-mcp', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        id: 'agent-profile-mcp',
        name: 'MCP Agent',
        version: 1,
        identityHash: 'hash',
        identityPrompt: '',
        includeClaudePreset: true,
        runtimePolicy: {
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'custom', ids: ['github'] },
          tools: { mode: 'inherit' },
        },
      },
    );

    const settingsFile = path.join(
      tmpDataDir,
      'sessions',
      'grp-policy-mcp',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(settings.mcpServers ?? {}).sort()).toEqual([
      'github',
      'projectDb',
    ]);
    expect(settings.mcpServers).not.toHaveProperty('slack');
    const envFile = path.join(tmpDataDir, 'env', 'grp-policy-mcp', 'env');
    expect(fs.readFileSync(envFile, 'utf8')).toContain(
      "HAPPYCLAW_AGENT_MCP_POLICY='custom'",
    );
  });

  test('host_claude always includes every host Skill and MCP while managed custom selection stays additive', () => {
    const external = path.join(tmpDataDir, 'native-claude');
    writeSystemSettings({ externalClaudeDir: external });
    fs.mkdirSync(path.join(external, 'skills', 'native-a'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(external, 'skills', 'native-b'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(external, 'skills', 'native-a', 'SKILL.md'),
      '# native a',
    );
    fs.writeFileSync(
      path.join(external, 'skills', 'native-b', 'SKILL.md'),
      '# native b',
    );
    fs.writeFileSync(
      path.join(external, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          nativeA: { command: 'native-a' },
          nativeB: { command: 'native-b' },
        },
      }),
    );
    const managedSkills = path.join(tmpDataDir, 'skills', USER);
    for (const id of ['managed-a', 'managed-b']) {
      fs.mkdirSync(path.join(managedSkills, id), { recursive: true });
      fs.writeFileSync(path.join(managedSkills, id, 'SKILL.md'), `# ${id}`);
    }
    const mcpDir = path.join(tmpDataDir, 'mcp-servers', USER);
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'servers.json'),
      JSON.stringify({
        servers: {
          managedA: { enabled: true, command: 'managed-a' },
          managedB: { enabled: true, command: 'managed-b' },
        },
      }),
    );
    const systemMcpDir = path.join(tmpDataDir, 'mcp-servers', 'system');
    fs.mkdirSync(systemMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(systemMcpDir, 'servers.json'),
      JSON.stringify({
        servers: {
          platform: {
            enabled: true,
            command: 'platform-mcp',
            memberAccess: 'shared',
          },
        },
      }),
    );

    const group = fakeGroup('grp-host-additive', USER) as any;
    const mounts = buildVolumeMounts(
      group,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        id: 'host-additive-profile',
        name: 'Host additive',
        version: 1,
        identityHash: 'hash',
        identityPrompt: '',
        includeClaudePreset: true,
        runtimePolicy: {
          context: {
            source: 'host_claude',
            auto_compact_window: 0,
            auto_compact_percentage: 0,
          },
          skills: { mode: 'custom', ids: ['managed-a'] },
          mcp: {
            mode: 'custom',
            ids: ['system:platform', 'managedA'],
          },
          tools: { mode: 'inherit' },
        },
      },
    );

    expect(
      mounts.find(
        (mount) => mount.containerPath === '/workspace/external-skills',
      )?.hostPath,
    ).toBe(path.join(external, 'skills'));
    const managedMount = mounts.find(
      (mount) => mount.containerPath === '/workspace/user-skills',
    )!;
    expect(fs.existsSync(path.join(managedMount.hostPath, 'managed-a'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(managedMount.hostPath, 'managed-b'))).toBe(
      false,
    );
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDataDir,
          'sessions',
          group.folder,
          '.claude',
          'settings.json',
        ),
        'utf8',
      ),
    );
    expect(Object.keys(settings.mcpServers).sort()).toEqual([
      'managedA',
      'nativeA',
      'nativeB',
      'platform',
    ]);
  });

  test('host MCP env replaces inherited servers and clears disabled policy', () => {
    const env = {
      HAPPYCLAW_USER_MCP_SERVERS_JSON: JSON.stringify({ stale: {} }),
      KEEP_ME: 'yes',
    };

    replaceHostMcpServersEnv(env, { github: { command: 'github-mcp' } });
    expect(JSON.parse(env.HAPPYCLAW_USER_MCP_SERVERS_JSON)).toEqual({
      github: { command: 'github-mcp' },
    });
    expect(env.KEEP_ME).toBe('yes');

    replaceHostMcpServersEnv(env, {});
    expect(env.HAPPYCLAW_USER_MCP_SERVERS_JSON).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
  });

  test('custom MCP policy fails closed when a selected server is disabled', () => {
    const mcpDir = path.join(tmpDataDir, 'mcp-servers', USER);
    fs.mkdirSync(mcpDir, { recursive: true });
    const serversFile = path.join(mcpDir, 'servers.json');
    fs.writeFileSync(
      serversFile,
      JSON.stringify({
        servers: {
          github: { enabled: true, command: 'github-mcp' },
        },
      }),
    );
    const profile = {
      id: 'agent-profile-disabled-mcp',
      name: 'MCP Agent',
      version: 1,
      identityHash: 'hash',
      identityPrompt: '',
      includeClaudePreset: true,
      runtimePolicy: {
        skills: { mode: 'inherit' as const, ids: [] },
        mcp: { mode: 'custom' as const, ids: ['github'] },
        tools: { mode: 'inherit' as const },
      },
    };
    buildVolumeMounts(
      fakeGroup('grp-policy-mcp-before-disable', USER) as any,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profile,
    );
    fs.writeFileSync(
      serversFile,
      JSON.stringify({
        servers: {
          github: { enabled: false, command: 'github-mcp' },
        },
      }),
    );

    expect(() =>
      buildVolumeMounts(
        fakeGroup('grp-policy-mcp-after-disable', USER) as any,
        false,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        profile,
      ),
    ).toThrow(
      'AgentProfile agent-profile-disabled-mcp requires unavailable MCP server(s): github',
    );
  });
});

describe('prepareHostPlugins — host-mode pre-spawn materialize', () => {
  test('materializes runtime/ on demand when v2 config exists but tree is missing', () => {
    // Reproduces the bug fixed in this task: v2 config is present but
    // runtime/{userId}/snapshots/... has not been built yet (first enable, or
    // after orphan GC). Without pre-spawn materialize, loadUserPlugins(host)
    // would skip every entry (manifest existsSync check fails) and the host
    // agent would silently start with 0 plugins.
    seedCatalogSnapshot({
      marketplace: 'mp1',
      plugin: 'p1',
      snapshot: 'sha256-host-aaa',
    });
    utils.writeUserPluginsV2(USER, {
      schemaVersion: 1,
      enabled: {
        'p1@mp1': {
          enabled: true,
          marketplace: 'mp1',
          plugin: 'p1',
          snapshot: 'sha256-host-aaa',
          enabledAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });

    // Sanity: runtime/ tree is NOT yet built — this is the broken state.
    const expectedManifest = path.join(
      getUserPluginRuntimeDir(USER, 'sha256-host-aaa', 'mp1', 'p1'),
      '.claude-plugin',
      'plugin.json',
    );
    expect(fs.existsSync(expectedManifest)).toBe(false);

    const plugins = prepareHostPlugins(USER);

    // After prepareHostPlugins: runtime/ is materialized AND we got a host
    // SdkPluginConfig pointing at the absolute on-disk path.
    expect(fs.existsSync(expectedManifest)).toBe(true);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].type).toBe('local');
    expect(plugins[0].path).toBe(
      getUserPluginRuntimeDir(USER, 'sha256-host-aaa', 'mp1', 'p1'),
    );
  });

  test('returns empty array for falsy ownerId (admin without created_by)', () => {
    // Defensive: legacy groups without created_by should not throw and should
    // produce no plugins. Mirrors the `group.created_by ? ... : []` ternary
    // the old inline code carried.
    expect(prepareHostPlugins(null)).toEqual([]);
    expect(prepareHostPlugins(undefined)).toEqual([]);
    expect(prepareHostPlugins('')).toEqual([]);
  });

  test('returns empty array when v2 config is absent', () => {
    // No v2 config → nothing to materialize, nothing to load. materialize is
    // a no-op in this case (returns empty report) and loadUserPlugins returns
    // []. The function must not throw.
    expect(prepareHostPlugins(USER)).toEqual([]);
  });
});
