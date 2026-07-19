import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const controls = vi.hoisted(() => ({
  feishuMessageCreate: vi.fn(),
  feishuMessageReply: vi.fn(),
  feishuImageCreate: vi.fn(),
  feishuFileCreate: vi.fn(),
  telegramSendMessage: vi.fn(),
  telegramSendPhoto: vi.fn(),
  telegramSendAnimation: vi.fn(),
  telegramSendDocument: vi.fn(),
  telegramStopPolling: null as (() => void) | null,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  Client: class {
    request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });
    im = {
      v1: {
        message: { create: controls.feishuMessageCreate },
        image: { create: controls.feishuImageCreate },
        file: { create: controls.feishuFileCreate },
      },
      message: { reply: controls.feishuMessageReply },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
    };
  },
  EventDispatcher: class {
    register() {
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn().mockResolvedValue({ id: 1, username: 'strict_ack_bot' }),
      sendMessage: controls.telegramSendMessage,
      sendPhoto: controls.telegramSendPhoto,
      sendAnimation: controls.telegramSendAnimation,
      sendDocument: controls.telegramSendDocument,
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        controls.telegramStopPolling = resolve;
      });
    }
    stop() {
      controls.telegramStopPolling?.();
      controls.telegramStopPolling = null;
    }
  },
  InputFile: class {
    constructor(
      readonly source: unknown,
      readonly filename?: string,
    ) {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createFeishuConnection } = await import('../src/feishu.js');
const { createTelegramConnection } = await import('../src/telegram.js');

let cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  cleanup = [];
  controls.telegramStopPolling = null;
  vi.clearAllMocks();
  controls.feishuMessageCreate.mockResolvedValue({
    code: 0,
    data: { message_id: 'om_1' },
  });
  controls.feishuMessageReply.mockResolvedValue({
    code: 0,
    data: { message_id: 'om_1' },
  });
  controls.feishuImageCreate.mockResolvedValue({
    code: 0,
    data: { image_key: 'img_1' },
  });
  controls.feishuFileCreate.mockResolvedValue({
    code: 0,
    data: { file_key: 'file_1' },
  });
  controls.telegramSendMessage.mockResolvedValue({ message_id: 1 });
  controls.telegramSendPhoto.mockResolvedValue({ message_id: 2 });
  controls.telegramSendAnimation.mockResolvedValue({ message_id: 3 });
  controls.telegramSendDocument.mockResolvedValue({ message_id: 4 });
});

afterEach(async () => {
  await Promise.allSettled(cleanup.map((fn) => fn()));
});

async function connectedTransports() {
  const feishu = createFeishuConnection({ appId: 'app', appSecret: 'secret' });
  expect(await feishu.connect({ onReady: vi.fn() })).toBe(true);
  const telegram = createTelegramConnection({ botToken: 'token' });
  expect(
    await telegram.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    }),
  ).toBe(true);
  cleanup.push(
    () => feishu.stop(),
    () => telegram.disconnect(),
  );
  return { feishu, telegram };
}

describe('IM strict send acknowledgement', () => {
  test('all send methods reject while their transport is uninitialized', async () => {
    const feishu = createFeishuConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    const telegram = createTelegramConnection({ botToken: 'token' });

    await expect(feishu.sendMessage('oc_1', 'hello')).rejects.toThrow(
      'not initialized',
    );
    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('not initialized');
    await expect(feishu.sendFile('oc_1', '/missing', 'a.txt')).rejects.toThrow(
      'not initialized',
    );
    await expect(telegram.sendMessage('1', 'hello')).rejects.toThrow(
      'not initialized',
    );
    await expect(
      telegram.sendImage('1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('not initialized');
    await expect(telegram.sendFile('1', '/missing', 'a.txt')).rejects.toThrow(
      'not initialized',
    );
  });

  test('all send methods reject malformed provider targets', async () => {
    const { feishu, telegram } = await connectedTransports();

    await expect(feishu.sendMessage('', 'hello')).rejects.toThrow(
      'Invalid Feishu route target',
    );
    await expect(
      feishu.sendImage('oc_1#root:', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(
      feishu.sendFile('oc_1#unknown:x', '/missing', 'a.txt'),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(telegram.sendMessage('not-a-chat', 'hello')).rejects.toThrow(
      'Invalid Telegram chat ID',
    );
    await expect(telegram.sendMessage('', 'hello')).rejects.toThrow(
      'Invalid Telegram chat ID',
    );
    await expect(
      telegram.sendImage('1#thread:0', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('Invalid Telegram chat ID');
    await expect(
      telegram.sendFile('1#thread:nope', '/missing', 'a.txt'),
    ).rejects.toThrow('Invalid Telegram chat ID');
  });

  test('final provider API failures reject text, image, and file sends', async () => {
    const { feishu, telegram } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const filePath = path.join(tempDir, 'payload.txt');
    await fs.writeFile(filePath, 'payload');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    controls.feishuMessageCreate.mockResolvedValue({
      code: 230001,
      msg: 'permission denied',
    });
    await expect(feishu.sendMessage('oc_1', 'hello')).rejects.toThrow(
      'code=230001',
    );
    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('code=230001');
    await expect(
      feishu.sendFile('oc_1', filePath, 'payload.txt'),
    ).rejects.toThrow('code=230001');

    controls.telegramSendMessage.mockRejectedValue(new Error('send denied'));
    controls.telegramSendPhoto.mockRejectedValue(new Error('photo denied'));
    controls.telegramSendDocument.mockRejectedValue(
      new Error('document denied'),
    );
    await expect(telegram.sendMessage('1', 'hello')).rejects.toThrow(
      'send denied',
    );
    await expect(
      telegram.sendImage('1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('photo denied');
    await expect(
      telegram.sendFile('1', filePath, 'payload.txt'),
    ).rejects.toThrow('document denied');
  });

  test('sendMessage rejects when a requested image attachment fails', async () => {
    const { feishu, telegram } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const imagePath = path.join(tempDir, 'image.png');
    await fs.writeFile(imagePath, 'image');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    controls.feishuImageCreate.mockRejectedValue(new Error('upload denied'));
    await expect(
      feishu.sendMessage('oc_1', 'hello', [imagePath]),
    ).rejects.toThrow('upload denied');

    controls.telegramSendPhoto.mockRejectedValue(new Error('photo denied'));
    await expect(
      telegram.sendMessage('1', 'hello', [imagePath]),
    ).rejects.toThrow('photo denied');
  });
});
