import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ContainerOutput } from './types.js';

export type IpcDeliveryReceipt = NonNullable<
  ContainerOutput['ipcReceipts']
>[number];

export interface IpcInputMessage {
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  taskId?: string;
  sourceJid?: string;
  receipt?: IpcDeliveryReceipt;
}

export function parseIpcReceipt(
  value: unknown,
): IpcDeliveryReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as Record<string, unknown>;
  const cursor = receipt.cursor as Record<string, unknown> | undefined;
  if (
    typeof receipt.deliveryId !== 'string' ||
    typeof receipt.chatJid !== 'string' ||
    !cursor ||
    typeof cursor.timestamp !== 'string' ||
    typeof cursor.id !== 'string'
  ) {
    return undefined;
  }
  let coveredCursors: Array<{ timestamp: string; id: string }> | undefined;
  if (Object.prototype.hasOwnProperty.call(receipt, 'coveredCursors')) {
    if (
      !Array.isArray(receipt.coveredCursors) ||
      receipt.coveredCursors.length === 0
    )
      return undefined;
    coveredCursors = [];
    for (const value of receipt.coveredCursors) {
      if (!value || typeof value !== 'object') return undefined;
      const covered = value as Record<string, unknown>;
      if (
        typeof covered.timestamp !== 'string' ||
        typeof covered.id !== 'string'
      )
        return undefined;
      coveredCursors.push({ timestamp: covered.timestamp, id: covered.id });
    }
    const maximum = [...coveredCursors].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })[coveredCursors.length - 1];
    if (maximum.timestamp !== cursor.timestamp || maximum.id !== cursor.id)
      return undefined;
  }
  return {
    deliveryId: receipt.deliveryId,
    chatJid: receipt.chatJid,
    ...(coveredCursors && coveredCursors.length > 0 ? { coveredCursors } : {}),
    cursor: { timestamp: cursor.timestamp, id: cursor.id },
  };
}

export function isHealthyInputTurnCompletion(
  pendingBackgroundTasks: number,
  suspectTruncated: boolean,
): boolean {
  return pendingBackgroundTasks === 0 && !suspectTruncated;
}

/** Associates each accepted IPC batch with exactly one subsequent healthy SDK
 * result. Errors, interrupts, pending-background results and truncation do not
 * call completeNextTurn, so their messages remain replayable. */
export class IpcTurnDeliveryTracker {
  readonly unacknowledgedMessages: IpcInputMessage[];
  private readonly turns: IpcInputMessage[][];

  constructor(initialMessages: IpcInputMessage[] = []) {
    this.unacknowledgedMessages = [...initialMessages];
    this.turns = [[...initialMessages]];
  }

  acceptTurn(messages: IpcInputMessage[]): void {
    this.unacknowledgedMessages.push(...messages);
    this.turns.push([...messages]);
  }

  completeNextTurn(): IpcDeliveryReceipt[] {
    const completed = this.turns.shift() ?? [];
    for (const message of completed) {
      const index = this.unacknowledgedMessages.indexOf(message);
      if (index >= 0) this.unacknowledgedMessages.splice(index, 1);
    }
    return completed
      .map((message) => message.receipt)
      .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
  }
}

export function serializeIpcInputMessage(message: IpcInputMessage): object {
  return {
    type: 'message',
    text: message.text,
    images: message.images,
    taskId: message.taskId,
    sourceJid: message.sourceJid,
    receipt: message.receipt,
  };
}

/** Put messages consumed by a query that did not complete back into the IPC
 * queue. Filenames preserve the original array order, and each write is
 * atomic so crash recovery never observes a partial receipt payload. */
export function requeueIpcInputMessages(
  inputDir: string,
  messages: IpcInputMessage[],
): string[] {
  if (messages.length === 0) return [];
  fs.mkdirSync(inputDir, { recursive: true });
  const batchId = `${Date.now()}-${randomUUID()}`;
  const written: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const filename = `${batchId}-requeue-${String(index).padStart(6, '0')}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    try {
      fs.writeFileSync(
        tempPath,
        JSON.stringify(serializeIpcInputMessage(messages[index])),
      );
      fs.renameSync(tempPath, filepath);
      written.push(filepath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore missing partial temp file */
      }
      throw err;
    }
  }
  return written;
}
