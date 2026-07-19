import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaudeContextPlan,
  syncHostClaudeContext,
} from '../src/claude-context-resolver.js';

function writeFile(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeSkill(root: string, name: string): void {
  writeFile(path.join(root, name, 'SKILL.md'), `# ${name}`);
}

function fakeGroup(folder: string, ownerId: string, isHome = false) {
  return {
    name: folder,
    folder,
    added_at: '2026-05-18T00:00:00.000Z',
    created_by: ownerId,
    is_home: isHome,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-context-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeContextResolver', () => {
  test('host sync links admin CLAUDE.md/rules/skills from the effective external dir', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');

    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook');
    writeFile(path.join(external, 'rules', 'browser.md'), '# browser rule');
    makeSkill(path.join(external, 'skills'), 'external-skill');
    makeSkill(path.join(dataDir, 'builtin-skills'), 'builtin-skill');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'project-skill');
    makeSkill(path.join(dataDir, 'skills', 'admin'), 'user-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: true,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(sync.claudeMdStatus).toBe('linked');
    expect(fs.readlinkSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(
      path.join(external, 'CLAUDE.md'),
    );
    expect(fs.readlinkSync(path.join(sessionDir, 'rules', 'browser.md'))).toBe(
      path.join(external, 'rules', 'browser.md'),
    );
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'builtin-skill')),
    ).toBe(path.join(dataDir, 'builtin-skills', 'builtin-skill'));
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'external-skill')),
    ).toBe(path.join(external, 'skills', 'external-skill'));
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'project-skill')),
    ).toBe(path.join(projectRoot, 'container', 'skills', 'project-skill'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'user-skill'))).toBe(
      path.join(dataDir, 'skills', 'admin', 'user-skill'),
    );
  });

  test('host sync preserves a real session CLAUDE.md and reports shadowed', () => {
    const external = path.join(tmp, 'external-claude');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# external');
    writeFile(path.join(sessionDir, 'CLAUDE.md'), '# local');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: true,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(sync.claudeMdStatus).toBe('shadowed');
    expect(sync.warnings).toContain('CLAUDE.md shadowed by session file');
    expect(
      fs.lstatSync(path.join(sessionDir, 'CLAUDE.md')).isSymbolicLink(),
    ).toBe(false);
  });

  test('container plan mounts admin triad but does not expose it to ordinary users', () => {
    const external = path.join(tmp, 'external-claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# admin');
    writeFile(path.join(external, 'rules', 'r.md'), '# rule');
    makeSkill(path.join(external, 'skills'), 'external-skill');

    const adminPlan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
      includeHostClaudeContext: true,
    });
    expect(adminPlan.audit.claudeMd).toMatchObject({
      sourcePath: path.join(external, 'CLAUDE.md'),
      runtimePath: '/workspace/CLAUDE.md',
      status: 'mounted',
    });
    expect(adminPlan.audit.rules).toMatchObject({
      sourcePath: path.join(external, 'rules'),
      runtimePath: '/workspace/.claude/rules',
      status: 'mounted',
      fileCount: 1,
    });
    expect(
      adminPlan.audit.skills.sources.some(
        (source) => source.name === 'external',
      ),
    ).toBe(true);

    const userPlan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('alice-home', 'alice', true) as any,
      ownerHomeFolder: 'alice-home',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'alice-home', '.claude'),
    });
    expect(userPlan.audit.claudeMd.status).toBe('unavailable');
    expect(userPlan.audit.externalClaudeDir).toBeUndefined();
    expect(userPlan.audit.claudeMd.sourcePath).toBeUndefined();
    expect(userPlan.audit.rules.status).toBe('unavailable');
    expect(
      userPlan.audit.skills.sources.some(
        (source) => source.name === 'external',
      ),
    ).toBe(false);
  });

  test('host sync reports skill name conflict across sources', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    const selectedUserSkills = path.join(
      dataDir,
      'agent-profile-runtime',
      'admin',
      'custom-agent',
      'v2',
      'skills',
    );

    writeFile(path.join(external, 'CLAUDE.md'), '# admin');
    // builtin 与 external 都有同名 skill，合并时应记录冲突。
    makeSkill(path.join(dataDir, 'builtin-skills'), 'dup-skill');
    makeSkill(path.join(external, 'skills'), 'dup-skill');
    makeSkill(selectedUserSkills, 'dup-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: true,
      userSkillsDirOverride: selectedUserSkills,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(
      sync.warnings.some((w) => w.includes('skill name conflict: dup-skill')),
    ).toBe(true);
    // Host context is a base layer. The managed user Skill is linked later
    // and therefore remains authoritative for the Agent's selected add-ons.
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'dup-skill'))).toBe(
      path.join(selectedUserSkills, 'dup-skill'),
    );
  });

  test('plan warns when native CLAUDE.md and HappyClaw memory layer are both active', () => {
    const external = path.join(tmp, 'external-claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook');

    const base = {
      executionMode: 'host' as const,
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
      includeHostClaudeContext: true,
    };

    const active = buildClaudeContextPlan({
      ...base,
      happyclawMemoryActive: true,
    });
    expect(active.audit.warnings.some((w) => w.includes('两套全局记忆'))).toBe(
      true,
    );

    const disabled = buildClaudeContextPlan({
      ...base,
      happyclawMemoryActive: false,
    });
    expect(
      disabled.audit.warnings.some((w) => w.includes('两套全局记忆')),
    ).toBe(false);
  });

  test('managed admin Agent does not inherit host context without explicit opt-in', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    writeFile(path.join(external, 'CLAUDE.md'), '# private admin context');
    makeSkill(path.join(external, 'skills'), 'private-host-skill');
    makeSkill(path.join(dataDir, 'builtin-skills'), 'builtin-skill');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'project-skill');
    makeSkill(path.join(dataDir, 'skills', 'admin'), 'user-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
    });

    expect(plan.claudeMdSource).toBeUndefined();
    expect(plan.rulesSourceDir).toBeUndefined();
    expect(plan.externalSkillsDir).toBeUndefined();
    expect(plan.audit.claudeMd.status).toBe('unavailable');
    expect(plan.audit.skills.sources.map((source) => source.name)).toEqual([
      'builtin',
      'project',
      'user',
    ]);
  });

  test('host context opt-in works for an admin whose home folder is not main', () => {
    const external = path.join(tmp, 'external-claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# second admin');
    makeSkill(path.join(external, 'skills'), 'second-admin-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('home-admin-2', 'admin-2', true) as any,
      ownerHomeFolder: 'home-admin-2',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'home-admin-2', '.claude'),
      includeHostClaudeContext: true,
    });

    expect(plan.claudeMdSource).toBe(path.join(external, 'CLAUDE.md'));
    expect(plan.audit.externalClaudeDir).toBe(external);
    expect(
      plan.audit.skills.sources.some((source) => source.name === 'external'),
    ).toBe(true);
  });

  test('switching away from host_claude removes its linked context only', () => {
    const external = path.join(tmp, 'external-claude');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# private admin context');

    const base = {
      executionMode: 'host' as const,
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
    };
    syncHostClaudeContext(
      buildClaudeContextPlan({ ...base, includeHostClaudeContext: true }),
      sessionDir,
    );
    expect(
      fs.lstatSync(path.join(sessionDir, 'CLAUDE.md')).isSymbolicLink(),
    ).toBe(true);

    syncHostClaudeContext(buildClaudeContextPlan(base), sessionDir);
    expect(fs.existsSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(false);

    writeFile(path.join(sessionDir, 'CLAUDE.md'), '# session-authored');
    syncHostClaudeContext(buildClaudeContextPlan(base), sessionDir);
    expect(fs.readFileSync(path.join(sessionDir, 'CLAUDE.md'), 'utf8')).toBe(
      '# session-authored',
    );
  });
});
