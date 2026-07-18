import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setupSendTool() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-send-ack-'));
  roots.push(root);
  const context: McpContext = {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: false,
    isAdminHome: false,
    currentInputTurnId: 'delivery-turn-1',
    workspaceIpc: root,
    workspaceGroup: root,
    workspaceGlobal: root,
    workspaceMemory: root,
  };
  const sendTool = createMcpTools(context).find(
    (candidate) => candidate.name === 'send_message',
  );
  if (!sendTool) throw new Error('send_message tool missing');
  return { root, sendTool };
}

async function readRequest(root: string): Promise<Record<string, unknown>> {
  const messagesDir = path.join(root, 'messages');
  await vi.waitFor(() => {
    expect(fs.readdirSync(messagesDir)).toHaveLength(1);
  });
  const [file] = fs.readdirSync(messagesDir);
  return JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf8'));
}

function writeResult(
  root: string,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  const resultDir = path.join(root, 'message-results');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultDir, `send_message_result_${requestId}.json`),
    JSON.stringify(payload),
  );
}

describe('send_message host acknowledgement', () => {
  test('does not report success until the host confirms real delivery', async () => {
    const { root, sendTool } = setupSendTool();
    let settled = false;
    const pending = sendTool
      .handler({ text: 'hello' }, {} as never)
      .finally(() => {
        settled = true;
      });
    const request = await readRequest(root);

    expect(request.inputTurnId).toBe('delivery-turn-1');
    expect(typeof request.requestId).toBe('string');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    writeResult(root, request.requestId as string, { success: true });
    await expect(pending).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Message sent.' }],
    });
  });

  test('surfaces a host delivery failure instead of returning a false success', async () => {
    const { root, sendTool } = setupSendTool();
    const pending = sendTool.handler({ text: 'hello' }, {} as never);
    const request = await readRequest(root);

    writeResult(root, request.requestId as string, {
      success: false,
      error: 'connector unavailable',
    });
    await expect(pending).rejects.toThrow('connector unavailable');
  });
});
