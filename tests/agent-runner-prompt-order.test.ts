import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('agent-runner system prompt composition order', () => {
  test('Agent identity prompt piece leads promptPieces, ahead of interaction.md and other workspace/context material', () => {
    // docs/agent-first-architecture-plan.md documents the composition order
    // as "Claude Code preset + Agent identity prompt + workspace/context
    // prompt + message history" — the Agent's persona must lead, not be
    // sandwiched among HappyClaw's own generic interaction/skill/security
    // guidance. This is a static source check (not an execution test)
    // because promptPieces is assembled deep inside a very large function
    // with heavy runtime/IPC dependencies not worth mocking for one
    // ordering assertion — mirrors the pattern used for Feishu's route
    // ordering in tests/feishu-route-safety.test.ts.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf8',
    );

    const identityIdx = source.indexOf(
      '...buildAgentIdentityPromptPiece(containerInput)',
    );
    const interactionIdx = source.indexOf("name: 'interaction.md'");
    const skillRoutingIdx = source.indexOf("name: 'skill-routing.md'");
    const securityRulesIdx = source.indexOf("name: 'security-rules.md'");

    expect(identityIdx).toBeGreaterThan(-1);
    expect(interactionIdx).toBeGreaterThan(-1);
    expect(skillRoutingIdx).toBeGreaterThan(-1);
    expect(securityRulesIdx).toBeGreaterThan(-1);

    expect(identityIdx).toBeLessThan(interactionIdx);
    expect(identityIdx).toBeLessThan(skillRoutingIdx);
    expect(identityIdx).toBeLessThan(securityRulesIdx);
  });
});
