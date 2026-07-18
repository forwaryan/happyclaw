import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  buildContainerEnvLines,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

function config(patch: Partial<ClaudeProviderConfig>): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: 'https://example.test/anthropic',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'test-model',
    updatedAt: null,
    ...patch,
  };
}

// Always pass an explicit (empty) profileCustomEnv so buildClaudeEnvLines does
// NOT fall through to getActiveProfileCustomEnv() → readStoredStateV4(), which
// reads (and may lazily migrate-write) the real on-disk claude-provider.json.
// Keeping the test hermetic avoids leaking ambient config and disk mutation.
const NO_CUSTOM_ENV: Record<string, string> = {};

describe('buildClaudeEnvLines', () => {
  test('maps plain third-party auth tokens to ANTHROPIC_API_KEY', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'plain-token' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_API_KEY=plain-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=plain-token');
  });

  test('routes explicit Bearer tokens to ANTHROPIC_AUTH_TOKEN without doubling the prefix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'Bearer upstream-token' }),
      NO_CUSTOM_ENV,
    );

    // The SDK emits `Authorization: Bearer <value>` itself, so the stored value
    // must be the bare token — otherwise the header becomes `Bearer Bearer …`.
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=upstream-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=Bearer upstream-token');
    expect(lines).not.toContain('ANTHROPIC_API_KEY=upstream-token');
  });

  test('preserves newlines in ANTHROPIC_CUSTOM_HEADERS', () => {
    const lines = buildClaudeEnvLines(config({}), {
      ANTHROPIC_CUSTOM_HEADERS: 'x-one: 1\nx-two: 2',
    });

    expect(lines).toContain('ANTHROPIC_CUSTOM_HEADERS=x-one: 1\nx-two: 2');
  });

  test('derives managed Claude Code defaults for third-party models', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2[1m]');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    expect(lines).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('CLAUDE_CODE_NO_FLICKER=1');
    expect(lines).toContain('API_TIMEOUT_MS=3000000');
  });

  test('uses defaults but lets provider settings override third-party values', () => {
    const lines = buildClaudeEnvLines(config({ anthropicModel: 'k3' }), {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999999',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CUSTOM_FLAG: 'kept',
    });

    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=999999');
    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
    expect(lines).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('CUSTOM_FLAG=kept');
  });

  test('keeps runtime tuning customizable for official providers', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: 'sonnet' }),
      { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    );

    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
    expect(lines).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
  });

  test('prevents workspace overrides from replacing third-party managed values', () => {
    const lines = buildContainerEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]' }),
      {
        customEnv: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-model',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '42',
          PROJECT_ENV: 'kept',
        },
      },
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    expect(lines).not.toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=stale-model');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=42');
    expect(lines).toContain('PROJECT_ENV=kept');
  });
});
