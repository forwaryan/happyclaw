import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  IpcTurnDeliveryTracker,
  isHealthyInputTurnCompletion,
  latestIpcDeliveryId,
  latestIpcInputMessage,
  parseIpcReceipt,
  requeueIpcInputMessages,
  serializeIpcInputMessage,
  type IpcDeliveryReceipt,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function message(id: string): IpcInputMessage {
  return {
    text: id,
    receipt: {
      deliveryId: `delivery-${id}`,
      chatJid: 'web:main',
      cursor: { timestamp: `2026-07-10T00:00:0${id}.000Z`, id },
    },
  };
}

describe('agent-runner IPC delivery turn tracker', () => {
  test('selects the greatest receipt cursor regardless of filesystem order', () => {
    const older = message('1');
    const newerSameTimestamp: IpcInputMessage = {
      text: 'newer',
      receipt: {
        deliveryId: 'delivery-newer',
        chatJid: 'web:main',
        cursor: {
          timestamp: older.receipt!.cursor.timestamp,
          id: 'z-newer',
        },
      },
    };

    expect(latestIpcDeliveryId([newerSameTimestamp, older])).toBe(
      'delivery-newer',
    );
    expect(latestIpcDeliveryId([older, newerSameTimestamp])).toBe(
      'delivery-newer',
    );
    expect(latestIpcInputMessage([newerSameTimestamp, older])).toBe(
      newerSameTimestamp,
    );
  });

  test('startup and idle-drained batches acknowledge only their exact completed turn', () => {
    const startup = [message('1'), message('2')];
    const tracker = new IpcTurnDeliveryTracker(startup);
    const idle = [message('3'), message('4')];
    tracker.acceptTurn(idle);

    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual([
      '1',
      '2',
    ]);
    expect(tracker.unacknowledgedMessages.map((m) => m.text)).toEqual([
      '3',
      '4',
    ]);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual([
      '3',
      '4',
    ]);
    expect(tracker.unacknowledgedMessages).toEqual([]);
  });

  test('mid-query turns are FIFO and later receipts cannot attach to an earlier result', () => {
    const tracker = new IpcTurnDeliveryTracker([]);
    tracker.acceptTurn([message('1')]);
    tracker.acceptTurn([message('2')]);

    expect(tracker.completeNextTurn()).toEqual([]); // initial non-IPC prompt
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual(['1']);
    expect(tracker.unacknowledgedMessages.map((m) => m.text)).toEqual(['2']);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual(['2']);
  });

  test('pending background, truncation, error and interrupt are not completions', () => {
    expect(isHealthyInputTurnCompletion(1, false)).toBe(false);
    expect(isHealthyInputTurnCompletion(0, true)).toBe(false);
    expect(isHealthyInputTurnCompletion(0, false)).toBe(true);

    const pending = message('1');
    const tracker = new IpcTurnDeliveryTracker([pending]);
    // Error/interrupt paths never invoke completeNextTurn.
    expect(tracker.unacknowledgedMessages).toEqual([pending]);
  });

  test('interrupt requeue serialization preserves the exact receipt', () => {
    const original = message('1');
    const serialized = serializeIpcInputMessage(original) as {
      receipt: IpcDeliveryReceipt;
    };
    expect(parseIpcReceipt(serialized.receipt)).toEqual(original.receipt);
    expect(serialized).toMatchObject({
      type: 'message',
      text: '1',
      receipt: original.receipt,
    });
  });

  test('failed/interrupt carry requeues messages in order with exact receipts', () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-requeue-'));
    tempDirs.push(inputDir);
    const pending = [message('1'), message('2'), message('3')];

    const written = requeueIpcInputMessages(inputDir, pending);
    expect(written).toHaveLength(3);
    const replayed = fs
      .readdirSync(inputDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(inputDir, name), 'utf8')),
      ) as Array<{ text: string; receipt: IpcDeliveryReceipt }>;

    expect(replayed.map((item) => item.text)).toEqual(['1', '2', '3']);
    expect(replayed.map((item) => item.receipt)).toEqual(
      pending.map((item) => item.receipt),
    );
  });

  test('parses and preserves the exact covered cursor set for a batch', () => {
    const parsed = parseIpcReceipt({
      deliveryId: 'delivery-batch',
      chatJid: 'web:main',
      coveredCursors: [
        { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
        { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      ],
      cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
    });

    expect(parsed?.coveredCursors?.map((cursor) => cursor.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  test('malformed or stale receipt payloads are rejected at the runner boundary', () => {
    expect(parseIpcReceipt(null)).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        cursor: { timestamp: 123, id: 'm' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [
          { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
          { timestamp: 123, id: 'm2' },
        ],
        cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [],
        cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [{ timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' }],
        cursor: { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
      }),
    ).toBeUndefined();
  });
});
