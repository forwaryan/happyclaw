import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import {
  filterHappyclawToolsForPolicy,
  getAgentToolPolicyFlagSettings,
  parseAgentMcpPolicyMode,
  parseAgentToolPolicyMode,
  resolveAgentToolPolicy,
} from '../container/agent-runner/src/runtime-tool-policy.js';

function registeredHappyClawTools(): string[] {
  return createMcpTools({
    chatJid: 'web:policy-test',
    groupFolder: 'policy-test',
    isHome: true,
    isAdminHome: true,
    isScheduledTask: false,
    currentTaskId: null,
    workspaceIpc: '/tmp/policy-ipc',
    workspaceGroup: '/tmp/policy-group',
    workspaceGlobal: '/tmp/policy-global',
    workspaceMemory: '/tmp/policy-memory',
  }).map((tool) => tool.name);
}

describe('AgentProfile runtime tool capability matrix', () => {
  test('readonly denies every unclassified HappyClaw tool and opaque extensions', () => {
    const policy = resolveAgentToolPolicy(
      'readonly',
      registeredHappyClawTools(),
    );

    expect(policy.loadUserPlugins).toBe(false);
    expect(policy.includeUserMcpServers).toBe(false);
    expect(policy.strictMcpConfig).toBe(true);
    expect(policy.settingSources).toEqual(['project', 'user']);
    expect(policy.managedSettings).toEqual({
      allowManagedHooksOnly: true,
    });
    expect(policy.disableSkillShellExecution).toBe(true);
    expect(policy.builtinTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Skill',
      'WebSearch',
      'WebFetch',
    ]);
    expect(policy.disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'Task',
        'mcp__happyclaw__schedule_task',
        'mcp__happyclaw__update_task',
        'mcp__happyclaw__cancel_task',
        'mcp__happyclaw__register_group',
        'mcp__happyclaw__install_skill',
        'mcp__happyclaw__uninstall_skill',
        'mcp__happyclaw__memory_append',
      ]),
    );
    expect(policy.disallowedTools).not.toContain(
      'mcp__happyclaw__memory_search',
    );
    expect(policy.disallowedTools).not.toContain('mcp__happyclaw__list_tasks');
    expect(policy.disallowedTools).not.toContain(
      'mcp__happyclaw__send_message',
    );
  });

  test('restricted additionally removes network research tools', () => {
    const policy = resolveAgentToolPolicy(
      'restricted',
      registeredHappyClawTools(),
    );
    expect(policy.disallowedTools).toEqual(
      expect.arrayContaining(['WebSearch', 'WebFetch', 'Bash', 'Write']),
    );
    expect(policy.builtinTools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
  });

  test('filters registered HappyClaw definitions as a default-deny exact set', () => {
    const tools = createMcpTools({
      chatJid: 'web:policy-filter',
      groupFolder: 'policy-filter',
      isHome: true,
      isAdminHome: true,
      isScheduledTask: false,
      currentTaskId: null,
      workspaceIpc: '/tmp/policy-ipc',
      workspaceGroup: '/tmp/policy-group',
      workspaceGlobal: '/tmp/policy-global',
      workspaceMemory: '/tmp/policy-memory',
    });
    const policy = resolveAgentToolPolicy(
      'readonly',
      tools.map((tool) => tool.name),
    );
    const exposed = filterHappyclawToolsForPolicy(policy, tools).map(
      (tool) => tool.name,
    );

    expect(exposed).toEqual(policy.allowedHappyclawTools);
    expect(exposed).toContain('send_message');
    expect(exposed).toContain('memory_search');
    expect(exposed).not.toContain('schedule_task');
    expect(exposed).not.toContain('install_skill');
  });

  test('managed locks neutralize project command hooks without hiding project context', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policy-hooks-'));
    try {
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# project context');
      fs.writeFileSync(
        path.join(cwd, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: 'touch /tmp/should-not-run' },
                ],
              },
            ],
          },
        }),
      );
      const policy = resolveAgentToolPolicy(
        'readonly',
        registeredHappyClawTools(),
      );
      const resolved = await resolveSettings({
        cwd,
        settingSources: policy.settingSources,
        managedSettings: policy.managedSettings,
      });

      expect(policy.settingSources).toContain('project');
      expect(fs.existsSync(path.join(cwd, 'CLAUDE.md'))).toBe(true);
      expect(
        resolved.sources.some((source) => source.source === 'project'),
      ).toBe(true);
      expect(resolved.effective.allowManagedHooksOnly).toBe(true);
      // SDK 0.3.205 drops disableSkillShellExecution from managedSettings'
      // restrictive allowlist, so production injects it through the explicit
      // options.settings flag tier instead (policy contract below).
      expect(resolved.effective.disableSkillShellExecution).toBeUndefined();
      expect(policy.disableSkillShellExecution).toBe(true);
      expect(getAgentToolPolicyFlagSettings(policy)).toEqual({
        disableSkillShellExecution: true,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('inherit preserves the existing extension surface', () => {
    const policy = resolveAgentToolPolicy(
      'inherit',
      registeredHappyClawTools(),
    );
    expect(policy).toEqual({
      mode: 'inherit',
      disallowedTools: [],
      loadUserPlugins: true,
      includeUserMcpServers: true,
      strictMcpConfig: false,
      settingSources: ['project', 'user'],
      disableSkillShellExecution: false,
    });
    expect(parseAgentToolPolicyMode('unknown')).toBe('inherit');
  });

  test('custom managed MCP keeps materialized project/host context but blocks plugin bypass', () => {
    const policy = resolveAgentToolPolicy(
      'inherit',
      registeredHappyClawTools(),
      'custom',
    );
    expect(policy.loadUserPlugins).toBe(false);
    expect(policy.includeUserMcpServers).toBe(true);
    expect(policy.strictMcpConfig).toBe(true);
    expect(policy.settingSources).toEqual(['project', 'user']);
  });

  test('disabled managed MCP keeps materialized project/host context and builtin MCP', () => {
    const tools = registeredHappyClawTools();
    const policy = resolveAgentToolPolicy('inherit', tools, 'disabled');
    expect(policy.loadUserPlugins).toBe(false);
    expect(policy.includeUserMcpServers).toBe(true);
    expect(policy.strictMcpConfig).toBe(true);
    expect(policy.allowedHappyclawTools).toBeUndefined();
    expect(parseAgentMcpPolicyMode('disabled')).toBe('disabled');
    expect(parseAgentMcpPolicyMode('unknown')).toBe('inherit');
  });
});
