import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkQuery = vi.fn();
vi.mock('../src/sdk-query.js', () => ({ sdkQuery }));
vi.mock('../src/runtime-config.js', () => ({
  getClaudeProviderConfig: () => ({ anthropicApiKey: 'configured' }),
}));

const { generateAgentProfileDraft, refineAgentProfilePrompt } =
  await import('../src/agent-profile-generator.js');

beforeEach(() => sdkQuery.mockReset());

describe('AgentProfile AI generation', () => {
  test('generates all four prompt sections', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Review Agent',
        identity_prompt: 'Reviewer',
        soul_prompt: 'Evidence first',
        agents_prompt: 'Review diffs',
        tools_prompt: 'Read before write',
        prompt_mode: 'append',
      }),
    );

    await expect(generateAgentProfileDraft('review code')).resolves.toEqual({
      name: 'Review Agent',
      identity_prompt: 'Reviewer',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Read before write',
      prompt_mode: 'append',
    });
  });

  test('refinement returns a complete candidate and preserves omitted sections', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        reply: 'Updated tools',
        tools_prompt: 'Ask before destructive writes',
      }),
    );
    const currentPrompts = {
      identity_prompt: '\nReviewer\n',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Read before write',
      prompt_mode: 'append' as const,
    };

    await expect(
      refineAgentProfilePrompt({
        agentName: 'Review Agent',
        currentPrompts,
        section: 'tools',
        message: 'ask before dangerous changes',
        history: [],
      }),
    ).resolves.toEqual({
      reply: 'Updated tools',
      identity_prompt: '\nReviewer\n',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Ask before destructive writes',
    });
  });
});
