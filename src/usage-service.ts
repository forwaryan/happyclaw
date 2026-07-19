import crypto from 'node:crypto';

import {
  getUserById,
  recordUsageEventBatch,
  type UsageModelRecordInput,
} from './db.js';
import {
  deductUsageCost,
  getUserEffectivePlan,
  isBillingEnabled,
} from './billing.js';

export interface UsagePayload {
  eventId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }
  >;
}

export interface RecordUsageEventOptions {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string | null;
  source?: string;
  usage: UsagePayload;
  /** Stable runner turn/event ID. Required for strong replay protection. */
  eventId?: string;
  createdAt?: string;
}

function safe(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value || 0) : 0;
}

/**
 * Compatibility fallback for integrations that have not started sending a
 * runner event ID yet. It is deterministic for the same message + payload,
 * but new callers should always pass eventId explicitly.
 */
export function deriveUsageEventId(options: RecordUsageEventOptions): string {
  const explicit = options.eventId || options.usage.eventId;
  if (explicit?.trim()) return explicit.trim();
  return `usage:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        userId: options.userId,
        groupFolder: options.groupFolder,
        agentId: options.agentId || null,
        messageId: options.messageId || null,
        source: options.source || 'agent',
        usage: options.usage,
      }),
    )
    .digest('hex')}`;
}

/**
 * The sole application entry point for usage accounting.
 *
 * - one logical run = one eventId
 * - all model rows, analytics and quota ledgers are committed atomically
 * - balance deduction is replay-safe on the same eventId
 * - zero-cost events still count every token category toward token quotas
 */
export function recordUsageEvent(options: RecordUsageEventOptions): {
  eventId: string;
  inserted: boolean;
  providerEstimatedCostUSD: number;
  billedCostUSD: number;
} {
  const eventId = deriveUsageEventId(options);
  const usage = options.usage;
  const providerEstimatedCostUSD = safe(usage.costUSD);
  const user = getUserById(options.userId);
  const effective = user ? getUserEffectivePlan(options.userId) : null;
  const shouldCharge =
    Boolean(user) &&
    user?.role !== 'admin' &&
    isBillingEnabled() &&
    Boolean(effective);
  const billedCostUSD = shouldCharge
    ? providerEstimatedCostUSD * (effective?.plan.rate_multiplier ?? 1)
    : 0;

  const modelEntries = Object.entries(usage.modelUsage || {});
  const rawModels = modelEntries.length
    ? modelEntries
    : [
        [
          'unknown',
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            costUSD: usage.costUSD,
          },
        ] as const,
      ];
  const modelEstimatedTotal = rawModels.reduce(
    (sum, [, model]) => sum + safe(model.costUSD),
    0,
  );
  const modelTokenTotal = rawModels.reduce(
    (sum, [, model]) =>
      sum +
      safe(model.inputTokens) +
      safe(model.outputTokens) +
      safe(model.cacheReadInputTokens) +
      safe(model.cacheCreationInputTokens),
    0,
  );
  const models: UsageModelRecordInput[] = rawModels.map(([model, value]) => {
    const rawEstimated = safe(value.costUSD);
    const modelTokens =
      safe(value.inputTokens) +
      safe(value.outputTokens) +
      safe(value.cacheReadInputTokens) +
      safe(value.cacheCreationInputTokens);
    // The root SDK cost is the event authority. Some providers omit per-model
    // costs; distribute the residual deterministically so analytics always
    // reconciles to the amount used by billing.
    const share =
      modelEstimatedTotal > 0
        ? rawEstimated / modelEstimatedTotal
        : modelTokenTotal > 0
          ? modelTokens / modelTokenTotal
          : 1 / rawModels.length;
    const estimated = providerEstimatedCostUSD * share;
    return {
      model,
      inputTokens: safe(value.inputTokens),
      outputTokens: safe(value.outputTokens),
      cacheReadInputTokens: safe(value.cacheReadInputTokens),
      cacheCreationInputTokens: safe(value.cacheCreationInputTokens),
      providerEstimatedCostUSD: estimated,
      billedCostUSD: billedCostUSD * share,
    };
  });

  const result = recordUsageEventBatch({
    eventId,
    userId: options.userId,
    groupFolder: options.groupFolder,
    agentId: options.agentId,
    messageId: options.messageId,
    inputTokens: safe(usage.inputTokens),
    outputTokens: safe(usage.outputTokens),
    cacheReadInputTokens: safe(usage.cacheReadInputTokens),
    cacheCreationInputTokens: safe(usage.cacheCreationInputTokens),
    providerEstimatedCostUSD,
    billedCostUSD,
    durationMs: safe(usage.durationMs),
    numTurns: safe(usage.numTurns),
    source: options.source,
    createdAt: options.createdAt,
    models,
    trackBillingUsage: Boolean(user),
    chargeBalance: shouldCharge,
  });

  // The wallet mutation already committed atomically in recordUsageEventBatch.
  // This compatibility call emits the existing billing audit/access hooks;
  // only run it for a newly inserted event so replays cannot duplicate audits.
  if (result.inserted && shouldCharge && billedCostUSD > 0) {
    deductUsageCost(
      options.userId,
      providerEstimatedCostUSD,
      eventId,
      effective,
    );
  }

  return {
    eventId,
    inserted: result.inserted,
    providerEstimatedCostUSD,
    billedCostUSD,
  };
}
