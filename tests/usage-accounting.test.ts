import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-usage-v51-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: true }),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { recordUsageEvent } = await import('../src/usage-service.js');

const dbPath = path.join(store, 'messages.db');
let probe: InstanceType<typeof Database>;

beforeAll(() => {
  db.initDatabase();
  probe = new Database(dbPath, { readonly: true });
  const now = new Date().toISOString();
  db.createUser({
    id: 'member-usage',
    username: 'member-usage',
    password_hash: 'x',
    display_name: 'Usage member',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.createUser({
    id: 'zero-cost-user',
    username: 'zero-cost-user',
    password_hash: 'x',
    display_name: 'Zero cost user',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

afterAll(() => {
  probe.close();
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('v51 usage event accounting', () => {
  test('returns an exact N-calendar-day window', () => {
    expect(db.getUsageDateWindow(7, new Date(2026, 6, 16, 12))).toMatchObject({
      from: '2026-07-10',
      to: '2026-07-16',
      days: 7,
    });
    expect(db.getUsageDateWindow(1, new Date(2026, 6, 16, 12))).toMatchObject({
      from: '2026-07-16',
      to: '2026-07-16',
      days: 1,
    });
  });

  test('date-window queries use the indexed materialized usage date', () => {
    const plan = probe
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usage_records r
         WHERE r.user_id = ? AND r.usage_date >= ? AND r.usage_date <= ?`,
      )
      .all('member-usage', '2026-07-10', '2026-07-16') as Array<{
      detail: string;
    }>;
    expect(
      plan.some((row) => row.detail.includes('idx_usage_user_usage_date')),
    ).toBe(true);
  });

  test('commits a multi-model event once and counts one run', () => {
    const input = {
      eventId: 'turn-multi-model',
      userId: 'member-usage',
      groupFolder: 'workspace-a',
      agentId: 'reviewer',
      source: 'custom-agent',
      createdAt: '2026-07-16T03:00:00.000Z',
      inputTokens: 30,
      outputTokens: 5,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 20,
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
      durationMs: 100,
      numTurns: 1,
      trackBillingUsage: true,
      models: [
        {
          model: 'model-a',
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 10,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
        {
          model: 'model-b',
          inputTokens: 20,
          outputTokens: 3,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 10,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
      ],
    } as const;
    expect(db.recordUsageEventBatch(input).inserted).toBe(true);
    expect(db.recordUsageEventBatch(input).inserted).toBe(false);

    const analytics = db.getUsageAnalytics({
      from: '2026-07-16',
      to: '2026-07-16',
      userId: 'member-usage',
    });
    expect(analytics.summary).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      totalTokens: 155,
      runCount: 1,
      modelCallCount: 2,
    });

    // Cost=0 must still count all input/cache categories toward token quota.
    const monthly = probe
      .prepare(
        "SELECT * FROM monthly_usage WHERE user_id = ? AND month = '2026-07'",
      )
      .get('member-usage') as any;
    expect(monthly.total_input_tokens).toBe(150);
    expect(monthly.total_output_tokens).toBe(5);
    expect(monthly.message_count).toBe(1);
  });

  test('the unified service records zero-cost tokens in quota ledgers', () => {
    recordUsageEvent({
      eventId: 'zero-cost-service-event',
      userId: 'zero-cost-user',
      groupFolder: 'zero-cost-workspace',
      source: 'web',
      createdAt: '2026-07-16T03:30:00.000Z',
      usage: {
        eventId: 'zero-cost-service-event',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 5,
        costUSD: 0,
        durationMs: 1,
        numTurns: 1,
      },
    });
    const monthly = probe
      .prepare(
        "SELECT * FROM monthly_usage WHERE user_id = 'zero-cost-user' AND month = '2026-07'",
      )
      .get() as any;
    expect(monthly.total_input_tokens).toBe(45);
    expect(monthly.total_output_tokens).toBe(2);
    expect(monthly.total_cost_usd).toBe(0);
    expect(
      (
        probe
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE idempotency_key = 'usage_event_zero-cost-service-event'",
          )
          .get() as any
      ).count,
    ).toBe(0);
  });

  test('custom Agent uses the same idempotent analytics and balance path', () => {
    const options = {
      eventId: 'custom-agent-paid-turn',
      userId: 'member-usage',
      groupFolder: 'workspace-custom',
      agentId: 'custom-agent-1',
      messageId: 'message-custom-1',
      source: 'custom-agent',
      createdAt: '2026-07-16T04:00:00.000Z',
      usage: {
        eventId: 'custom-agent-paid-turn',
        inputTokens: 40,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 1.25,
        durationMs: 25,
        numTurns: 1,
        modelUsage: {
          'paid-model': {
            inputTokens: 40,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 1.25,
          },
        },
      },
    };
    expect(recordUsageEvent(options).inserted).toBe(true);
    expect(recordUsageEvent(options).inserted).toBe(false);

    expect(
      recordUsageEvent({
        ...options,
        eventId: 'custom-agent-paid-turn-2',
        usage: {
          ...options.usage,
          eventId: 'custom-agent-paid-turn-2',
          costUSD: 0.5,
          modelUsage: {
            'paid-model': {
              ...options.usage.modelUsage['paid-model'],
              costUSD: 0.5,
            },
          },
        },
      }).inserted,
    ).toBe(true);

    const charges = probe
      .prepare(
        "SELECT * FROM balance_transactions WHERE idempotency_key LIKE 'usage_event_custom-agent-paid-turn%' ORDER BY id",
      )
      .all() as any[];
    expect(charges).toHaveLength(2);
    expect(charges[0].reference_type).toBe('usage_event');
    expect(charges[0].amount_usd).toBeCloseTo(-1.25);
    expect(charges[1].amount_usd).toBeCloseTo(-0.5);
    expect(
      (
        probe
          .prepare(
            "SELECT COUNT(*) AS count FROM billing_audit_log WHERE event_type = 'balance_deducted'",
          )
          .get() as any
      ).count,
    ).toBe(2);
    expect(
      db.getUsageAnalytics({
        from: '2026-07-16',
        to: '2026-07-16',
        groupFolder: 'workspace-custom',
      }).summary.runCount,
    ).toBe(2);
  });

  test('reconciles root cost when a provider omits per-model costs', () => {
    recordUsageEvent({
      eventId: 'root-cost-only',
      userId: 'member-usage',
      groupFolder: 'workspace-root-cost',
      source: 'main-agent',
      createdAt: '2026-07-16T05:00:00.000Z',
      usage: {
        eventId: 'root-cost-only',
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 2,
        durationMs: 10,
        numTurns: 1,
        modelUsage: {
          'missing-cost-a': {
            inputTokens: 75,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          },
          'missing-cost-b': {
            inputTokens: 25,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          },
        },
      },
    });
    const analytics = db.getUsageAnalytics({
      from: '2026-07-16',
      to: '2026-07-16',
      userId: 'member-usage',
      groupFolder: 'workspace-root-cost',
    });
    expect(analytics.summary.providerEstimatedCostUSD).toBeCloseTo(2);
    expect(analytics.summary.billedCostUSD).toBeCloseTo(2);
    expect(
      analytics.attributions.models.reduce(
        (sum, item) => sum + item.providerEstimatedCostUSD,
        0,
      ),
    ).toBeCloseTo(2);
  });

  test('rebuilds a message snapshot from all incremental events', () => {
    db.ensureChatExists('web:snapshot');
    db.storeMessageDirect(
      'snapshot-message',
      'web:snapshot',
      'assistant',
      'HappyClaw',
      'done',
      '2026-07-16T06:00:00.000Z',
      true,
    );
    for (const [eventId, inputTokens, cost] of [
      ['snapshot-event-1', 10, 0.25],
      ['snapshot-event-2', 30, 0.75],
    ] as const) {
      db.recordUsageEventBatch({
        eventId,
        userId: 'member-usage',
        groupFolder: 'snapshot-workspace',
        messageId: 'snapshot-message',
        inputTokens,
        outputTokens: 1,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3,
        providerEstimatedCostUSD: cost,
        billedCostUSD: cost,
        models: [
          {
            model: 'snapshot-model',
            inputTokens,
            outputTokens: 1,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 3,
            providerEstimatedCostUSD: cost,
            billedCostUSD: cost,
          },
        ],
      });
    }
    db.rebuildMessageTokenUsageFromLedger(
      'web:snapshot',
      'snapshot-workspace',
      'snapshot-message',
    );
    const row = probe
      .prepare(
        "SELECT token_usage, cost_usd FROM messages WHERE id = 'snapshot-message' AND chat_jid = 'web:snapshot'",
      )
      .get() as any;
    expect(JSON.parse(row.token_usage)).toMatchObject({
      inputTokens: 40,
      outputTokens: 2,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 6,
      costUSD: 1,
      modelUsage: {
        'snapshot-model': {
          inputTokens: 40,
          outputTokens: 2,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 6,
          costUSD: 1,
        },
      },
    });
    expect(row.cost_usd).toBeCloseTo(1);
  });
});
