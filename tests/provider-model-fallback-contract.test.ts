import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const agentRunner = fs.readFileSync(
  path.join(root, 'container/agent-runner/src/index.ts'),
  'utf8',
);
const hostRunner = fs.readFileSync(
  path.join(root, 'src/container-runner.ts'),
  'utf8',
);

describe('provider fallback source contracts', () => {
  test('cold/warm retry uses the failed turn payload rather than startup input', () => {
    expect(agentRunner).toMatch(
      /return runQueryAttempt\(\s*failed\.prompt,\s*failed\.sessionIdBeforeTurn,[\s\S]*?failed\.resumeAt,[\s\S]*?failed\.images,[\s\S]*?failed\.ipcMessages,/,
    );
    expect(agentRunner).toContain(
      'laterIpcMessages: ipcDeliveryTracker.laterTurnMessages',
    );
    expect(agentRunner).toContain(
      'requeueIpcInputMessages(IPC_INPUT_DIR, failed.laterIpcMessages)',
    );
    expect(agentRunner).toContain('containerInput.turnId = failed.turnId');
  });

  test('SDK teardown after a limit result cannot erase the retry handoff', () => {
    expect(agentRunner).toMatch(
      /catch \(err\) \{[\s\S]*?if \(providerFailureTurn\) \{[\s\S]*?providerFailureTurn,[\s\S]*?\};[\s\S]*?Context overflow/,
    );
  });

  test('first failure reports usage and activates fallback for later warm turns', () => {
    expect(agentRunner).toContain(
      'PROVIDER_FALLBACK_MODELS.activateForResult(textResult)',
    );
    expect(agentRunner).toContain(
      'PROVIDER_FALLBACK_MODELS.activeModelOverride',
    );
    expect(agentRunner).toMatch(
      /providerFailureRetrying: true,[\s\S]*?emitResultUsage\(resultMsg, containerInput\.turnId \|\| generateTurnId\(\)\)/,
    );
  });

  test('host consumes the hidden marker and does not undo provider health', () => {
    expect(
      hostRunner.match(/if \(output\.providerFailureRetrying\)/g),
    ).toHaveLength(2);
    expect(hostRunner).toContain('!providerFailureReported &&');
    expect(hostRunner).toContain('!hostProviderFailureReported &&');
    expect(hostRunner).not.toContain('ownerHomeFolder,\n    fallbackModel');
  });
});
