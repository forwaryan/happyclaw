import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { resolveTurnOutcome } from '../src/turn-outcome.js';

describe('resolveTurnOutcome', () => {
  test('retries an in-flight close with no reply or healthy completion', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
      }),
    ).toEqual({
      kind: 'retryable',
      cursor: 'keep',
      reason: 'runner_closed_in_flight',
    });
  });

  test('commits a silent close after a healthy input completion', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: true,
        cursorCommitted: false,
        replyDelivered: false,
      }),
    ).toEqual({
      kind: 'completed',
      cursor: 'commit',
      reason: 'healthy_input_completed',
    });
  });

  test('preserves the existing delivered-reply no-replay path', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: true,
        replyDelivered: true,
      }),
    ).toEqual({
      kind: 'completed',
      cursor: 'already_committed',
      reason: 'reply_delivered',
    });
  });

  test('commits a delivered reply when completion bookkeeping arrived late', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: true,
      }),
    ).toEqual({
      kind: 'completed',
      cursor: 'commit',
      reason: 'reply_delivered',
    });
  });

  test('classifies a user stop separately and commits the discarded input', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
        stopRequested: true,
      }),
    ).toEqual({
      kind: 'stopped',
      cursor: 'commit',
      reason: 'user_stop',
    });
  });

  test('classifies deterministic failures as commit-without-retry', () => {
    expect(
      resolveTurnOutcome({
        status: 'error',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
        deterministicFailure: true,
      }),
    ).toEqual({
      kind: 'deterministic_failure',
      cursor: 'commit',
      reason: 'configuration_or_input',
    });
  });

  test('wires prompt and startup-budget validation errors to deterministic completion', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const branch = main.slice(
      main.indexOf("errorDetail.startsWith('context_budget_exceeded:')"),
      main.indexOf('// 上下文溢出错误'),
    );

    expect(branch).toContain("errorDetail.startsWith('prompt_plan_invalid:')");
    expect(branch).toContain('deterministicFailure: true');
    expect(branch).toContain("turnOutcome.cursor === 'commit'");
    expect(branch).toContain('return true;');
  });

  test('does not treat a DB-only interrupted partial as a delivered close reply', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const closedBranch = main.slice(
      main.indexOf("if (output.status === 'closed')"),
      main.indexOf('// Query 出错时'),
    );

    expect(closedBranch).toContain(
      'genuineReplyDelivered || ipcReplyTurnTracker.delivered',
    );
    expect(closedBranch).not.toContain('replyDelivered: sentReply');
  });

  test('commits an already-delivered reply when the runner throws before returning output', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const missingOutputBranch = main.slice(
      main.indexOf('if (!output) {'),
      main.indexOf('const stopDisposition ='),
    );

    expect(missingOutputBranch).toContain(
      'genuineReplyDelivered || ipcReplyTurnTracker.delivered',
    );
    expect(missingOutputBranch).toContain('commitCursor();');
    expect(missingOutputBranch).not.toContain('sentReply');
  });
});
