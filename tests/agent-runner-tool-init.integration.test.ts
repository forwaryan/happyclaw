import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import {
  filterHappyclawToolsForPolicy,
  resolveAgentToolPolicy,
  type AgentToolPolicyMode,
} from '../container/agent-runner/src/runtime-tool-policy.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-tool-init-'));
const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdkEntry = runnerRequire.resolve('@anthropic-ai/claude-agent-sdk');
const runnerSdk = (await import(
  pathToFileURL(runnerSdkEntry).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

async function captureInitializedTools(
  mode: Exclude<AgentToolPolicyMode, 'inherit'>,
): Promise<{
  actual: string[];
  expectedBuiltins: string[];
  expectedMcp: string[];
}> {
  const allTools = createMcpTools({
    chatJid: 'web:tool-init',
    groupFolder: 'tool-init',
    isHome: true,
    isAdminHome: true,
    isScheduledTask: false,
    currentTaskId: null,
    workspaceIpc: path.join(cwd, 'ipc'),
    workspaceGroup: cwd,
    workspaceGlobal: path.join(cwd, 'global'),
    workspaceMemory: path.join(cwd, 'memory'),
  });
  const policy = resolveAgentToolPolicy(
    mode,
    allTools.map((tool) => tool.name),
  );
  const filtered = filterHappyclawToolsForPolicy(policy, allTools);
  const server = runnerSdk.createSdkMcpServer({
    name: 'happyclaw',
    version: 'test',
    tools: filtered,
  });
  const stream = runnerSdk.query({
    prompt: 'Reply with OK.',
    options: {
      pathToClaudeCodeExecutable: runnerClaudeExecutable,
      cwd,
      model: 'claude-sonnet-4-5-20250929',
      env: {
        ...cleanEnv(),
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        ANTHROPIC_AUTH_TOKEN: 'happyclaw-init-test',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      tools: policy.builtinTools,
      allowedTools: [
        ...(policy.builtinTools ?? []),
        ...filtered.map((tool) => `mcp__happyclaw__${tool.name}`),
      ],
      disallowedTools: policy.disallowedTools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { happyclaw: server },
    },
  });

  let init: { tools: string[] } | undefined;
  for await (const message of stream) {
    if (message.type === 'system' && message.subtype === 'init') {
      init = message;
      break;
    }
  }
  if (!init) throw new Error(`Claude CLI did not emit system/init for ${mode}`);
  return {
    actual: init.tools,
    expectedBuiltins: policy.builtinTools ?? [],
    expectedMcp: filtered.map((tool) => `mcp__happyclaw__${tool.name}`),
  };
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('real Claude CLI tool initialization', () => {
  test('imports the exact SDK version pinned by the reproducible container build', () => {
    const runnerPackage = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const runnerLock = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package-lock.json'), 'utf8'),
    ) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };
    const importedSdkPackage = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(runnerSdkEntry), 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    const pinned = runnerPackage.dependencies['@anthropic-ai/claude-agent-sdk'];
    const pinnedCli = runnerPackage.dependencies['@anthropic-ai/claude-code'];
    const runnerCliPackage = JSON.parse(
      fs.readFileSync(
        path.join(
          runnerRoot,
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'package.json',
        ),
        'utf8',
      ),
    ) as { version: string };

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(runnerSdkEntry.startsWith(`${runnerRoot}${path.sep}`)).toBe(true);
    expect(importedSdkPackage.version).toBe(pinned);
    expect(
      runnerLock.packages['node_modules/@anthropic-ai/claude-agent-sdk']
        .version,
    ).toBe(pinned);
    expect(runnerCliPackage.version).toBe(pinnedCli);
    expect(
      runnerLock.packages['node_modules/@anthropic-ai/claude-code'].version,
    ).toBe(pinnedCli);
    expect(
      execFileSync(runnerClaudeExecutable, ['--version'], {
        encoding: 'utf8',
      }).trim(),
    ).toContain(pinnedCli);
    expect(
      runnerLock.packages[''].dependencies?.['@anthropic-ai/claude-agent-sdk'],
    ).toBe(pinned);

    const dockerfile = fs.readFileSync('container/Dockerfile', 'utf8');
    expect(dockerfile).toContain(
      'COPY agent-runner/package.json agent-runner/package-lock.json ./',
    );
    expect(dockerfile).toContain('RUN npm ci');
  });

  test.each(['readonly', 'restricted'] as const)(
    '%s exposes exactly the classified builtin and HappyClaw MCP sets',
    async (mode) => {
      const { actual, expectedBuiltins, expectedMcp } =
        await captureInitializedTools(mode);
      const builtins = actual.filter((name) => !name.startsWith('mcp__'));
      const mcp = actual.filter((name) => name.startsWith('mcp__'));

      expect(new Set(builtins)).toEqual(new Set(expectedBuiltins));
      expect(new Set(mcp)).toEqual(new Set(expectedMcp));
      expect(actual).not.toContain('Bash');
      expect(actual).not.toContain('mcp__happyclaw__schedule_task');
      expect(actual).not.toContain('mcp__happyclaw__install_skill');
    },
    20_000,
  );
});
