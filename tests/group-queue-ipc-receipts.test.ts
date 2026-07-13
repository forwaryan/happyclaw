import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-group-queue-ipc-receipts';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: (proc: { kill: () => boolean }) => proc.kill(),
}));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 10,
    maxConcurrentHostProcesses: 10,
  }),
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');
type Receipt = import('../src/group-queue.js').IpcDeliveryReceipt;

const JID = 'web:ipc-receipts';
const FOLDER = 'ipc-receipts';
const tick = () => new Promise((resolve) => setImmediate(resolve));

let queue: InstanceType<typeof GroupQueue>;
let releaseRun: (() => void) | undefined;

function inputDir(): string {
  return path.join(DATA_DIR, 'ipc', FOLDER, 'input');
}

function readPayloads(): Array<{ receipt?: Receipt }> {
  return fs
    .readdirSync(inputDir())
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(inputDir(), name), 'utf8')),
    );
}

async function startRunner(): Promise<void> {
  queue.enqueueMessageCheck(JID);
  await tick();
  queue.registerProcess(
    JID,
    {
      killed: false,
      kill: () => {
        releaseRun?.();
        return true;
      },
    } as never,
    { containerName: null, groupFolder: FOLDER },
  );
}

function cursor(id: string): { timestamp: string; id: string } {
  return { timestamp: '2026-07-10T00:00:00.000Z', id };
}

function inject(id: string, coveredIds: string[] = [id]): Receipt {
  expect(
    queue.sendMessage(JID, id, undefined, undefined, JID, undefined, {
      chatJid: JID,
      coveredCursors: coveredIds.map(cursor),
      cursor: cursor(id),
    }),
  ).toBe('sent');
  return readPayloads().find((payload) => payload.receipt?.cursor.id === id)!
    .receipt!;
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  queue.setIpcDeliveryCommitEligibilityChecker(() => true);
  queue.setProcessMessagesFn(
    () =>
      new Promise<boolean>((resolve) => {
        releaseRun = () => resolve(true);
      }),
  );
});

afterEach(async () => {
  releaseRun?.();
  await tick();
  await tick();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('GroupQueue IPC delivery receipts', () => {
  test('commits only a contiguous per-chat prefix under out-of-order stdout', async () => {
    await startRunner();
    const first = inject('m1');
    const second = inject('m2');
    const third = inject('m3');
    const commits: Receipt[][] = [];
    const commit = (receipts: Receipt[]) => commits.push(receipts);

    queue.acknowledgeIpcDeliveries(JID, [second], commit);
    expect(commits).toEqual([]);

    queue.acknowledgeIpcDeliveries(JID, [first], commit);
    expect(commits.flatMap((batch) => batch.map((r) => r.cursor.id))).toEqual([
      'm1',
      'm2',
    ]);

    queue.acknowledgeIpcDeliveries(JID, [third], commit);
    expect(commits.flatMap((batch) => batch.map((r) => r.cursor.id))).toEqual([
      'm1',
      'm2',
      'm3',
    ]);

    // Duplicate/stale receipts are harmless after registry deletion.
    queue.acknowledgeIpcDeliveries(JID, [first, second], commit);
    expect(commits.flat()).toHaveLength(3);
  });

  test('newest registration and ack cannot cross an older DB cursor registered later', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2'];
    queue.setIpcDeliveryCommitEligibilityChecker(
      (receipt) =>
        !orderedIds.some((id) => id > committedId && id < receipt.cursor.id),
    );
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const newest = inject('m2');
    queue.acknowledgeIpcDeliveries(JID, [newest], commit);
    expect(commits).toEqual([]);

    const older = inject('m1');
    queue.acknowledgeIpcDeliveries(JID, [older], commit);
    expect(commits.map((receipt) => receipt.cursor.id)).toEqual(['m1', 'm2']);
    expect(committedId).toBe('m2');
  });

  test('one healthy receipt commits every exact cursor covered by its DB batch', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2'];
    queue.setIpcDeliveryCommitEligibilityChecker((receipt) => {
      const covered = new Set(
        (receipt.coveredCursors ?? [receipt.cursor]).map((item) => item.id),
      );
      return !orderedIds.some(
        (id) => id > committedId && id <= receipt.cursor.id && !covered.has(id),
      );
    });
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const batch = inject('m2', ['m1', 'm2']);
    queue.acknowledgeIpcDeliveries(JID, [batch], commit);

    expect(commits).toEqual([batch]);
    expect(committedId).toBe('m2');
  });

  test('rejects an inconsistent terminal before writing an IPC claim', async () => {
    await startRunner();

    expect(
      queue.sendMessage(JID, 'invalid', undefined, undefined, JID, undefined, {
        chatJid: JID,
        coveredCursors: [cursor('m2')],
        cursor: cursor('m1'),
      }),
    ).toBe('no_active');
    expect(readPayloads()).toEqual([]);
  });

  test('an uncovered gap cannot commit and replays in DB order after runner failure', async () => {
    await startRunner();
    const orderedIds = ['m1', 'm2', 'm3'];
    let committedId = 'm0';
    queue.setIpcDeliveryCommitEligibilityChecker((receipt) => {
      const covered = new Set(
        (receipt.coveredCursors ?? [receipt.cursor]).map((item) => item.id),
      );
      return !orderedIds.some(
        (id) => id > committedId && id <= receipt.cursor.id && !covered.has(id),
      );
    });
    const commits: Receipt[] = [];
    const recovered: Receipt[][] = [];
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) => {
      recovered.push(receipts);
    });

    const gapped = inject('m3', ['m1', 'm3']);
    queue.acknowledgeIpcDeliveries(JID, [gapped], (receipts) => {
      commits.push(...receipts);
    });
    expect(commits).toEqual([]);

    releaseRun?.();
    await tick();
    await tick();

    expect(recovered).toEqual([[gapped]]);
    expect(orderedIds.filter((id) => id > committedId)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  test('newer batch stays blocked until an older batch closes the DB prefix', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2', 'm3', 'm4'];
    queue.setIpcDeliveryCommitEligibilityChecker((receipt) => {
      const covered = new Set(
        (receipt.coveredCursors ?? [receipt.cursor]).map((item) => item.id),
      );
      return !orderedIds.some(
        (id) => id > committedId && id <= receipt.cursor.id && !covered.has(id),
      );
    });
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const newer = inject('m4', ['m3', 'm4']);
    queue.acknowledgeIpcDeliveries(JID, [newer], commit);
    expect(commits).toEqual([]);

    const older = inject('m2', ['m1', 'm2']);
    queue.acknowledgeIpcDeliveries(JID, [older], commit);

    expect(commits.map((receipt) => receipt.cursor.id)).toEqual(['m2', 'm4']);
    expect(committedId).toBe('m4');
  });

  test('cold/direct cursor advance actively flushes an already-acked newer delivery', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2'];
    queue.setIpcDeliveryCommitEligibilityChecker(
      (receipt) =>
        !orderedIds.some((id) => id > committedId && id < receipt.cursor.id),
    );
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const newest = inject('m2');
    queue.acknowledgeIpcDeliveries(JID, [newest], commit);
    expect(commits).toEqual([]);

    committedId = 'm1'; // cold inputTurnCompleted/direct completion chokepoint
    queue.flushAcknowledgedIpcDeliveries(JID, commit);
    expect(commits.map((receipt) => receipt.cursor.id)).toEqual(['m2']);
  });

  test('runner exit removes stale files before requesting DB replay', async () => {
    await startRunner();
    const receipt = inject('crash');
    const recovered: Receipt[][] = [];
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) => {
      expect(readPayloads()).toEqual([]);
      recovered.push(receipts);
    });

    releaseRun?.();
    await tick();
    await tick();

    expect(recovered).toEqual([[receipt]]);
  });

  test('explicit stop abandons instead of replaying accepted deliveries', async () => {
    await startRunner();
    const receipt = inject('cancelled');
    const abandoned: Receipt[][] = [];
    const recovered: Receipt[][] = [];
    queue.setOnAbandonedIpcDeliveries((_jid, receipts) => {
      abandoned.push(receipts);
    });
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) => {
      recovered.push(receipts);
    });

    await queue.stopGroup(JID, { force: true });

    expect(abandoned).toEqual([[receipt]]);
    expect(recovered).toEqual([]);
    expect(readPayloads()).toEqual([]);
  });
});
