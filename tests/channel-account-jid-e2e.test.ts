import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-jid-e2e-'));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const address = await import('../src/channel-address.js');
import type { IMChannel, IMChannelConnectOpts } from '../src/im-channel.js';

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'jid-owner',
    username: 'jid-owner',
    password_hash: 'test',
    display_name: 'JID owner',
    role: 'member',
    status: 'active',
    permissions: [],
    created_at: now,
    updated_at: now,
  });
  for (const id of ['bot-a', 'bot-b']) {
    db.createChannelAccount({
      id,
      owner_user_id: 'jid-owner',
      provider: 'telegram',
      name: id,
      secret_ref: `channel-account:${id}`,
      enabled: true,
      auth_status: 'authorized',
    });
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeChannel() {
  let opts: IMChannelConnectOpts | null = null;
  let connected = false;
  const sendMessage = vi.fn(async () => undefined);
  const channel: IMChannel = {
    channelType: 'telegram',
    async connect(value) {
      opts = value;
      connected = true;
      return true;
    },
    async disconnect() {
      connected = false;
    },
    sendMessage,
    async setTyping() {},
    isConnected: () => connected,
  };
  return { channel, sendMessage, getOpts: () => opts! };
}

function register(jid: string, accountId: string) {
  db.setRegisteredGroup(jid, {
    name: 'Same external chat',
    folder: `folder-${accountId}`,
    added_at: new Date().toISOString(),
    created_by: 'jid-owner',
    channel_account_id: accountId,
    target_main_jid: `web:folder-${accountId}`,
  });
}

describe('canonical channel-account JID end to end', () => {
  test('two bots seeing the same external chat never share canonical identity or outbound socket', async () => {
    const manager = new IMConnectionManager();
    const first = fakeChannel();
    const second = fakeChannel();
    const firstInbound = vi.fn();
    const secondInbound = vi.fn();
    await manager.connectChannel(
      'jid-owner',
      'telegram',
      first.channel,
      { onReady: vi.fn(), onNewChat: firstInbound },
      'bot-a',
    );
    await manager.connectChannel(
      'jid-owner',
      'telegram',
      second.channel,
      { onReady: vi.fn(), onNewChat: secondInbound },
      'bot-b',
    );

    first.getOpts().onNewChat('telegram:shared-chat', 'Shared');
    second.getOpts().onNewChat('telegram:shared-chat', 'Shared');
    const firstJid = 'telegram:shared-chat#account:bot-a';
    const secondJid = 'telegram:shared-chat#account:bot-b';
    expect(firstInbound).toHaveBeenCalledWith(firstJid, 'Shared');
    expect(secondInbound).toHaveBeenCalledWith(secondJid, 'Shared');
    expect(address.channelConversationJid(firstJid)).not.toBe(
      address.channelConversationJid(secondJid),
    );

    register(firstJid, 'bot-a');
    register(secondJid, 'bot-b');
    await manager.sendMessage(firstJid, 'from first');
    expect(first.sendMessage).toHaveBeenCalledWith(
      'shared-chat',
      'from first',
      undefined,
    );
    expect(second.sendMessage).not.toHaveBeenCalled();

    await manager.sendMessage(secondJid, 'from second');
    expect(second.sendMessage).toHaveBeenCalledWith(
      'shared-chat',
      'from second',
      undefined,
    );
    expect(first.sendMessage).toHaveBeenCalledTimes(1);
    await manager.disconnectAll();
  });

  test('account scoping preserves provider-native thread and root fragments', () => {
    const scoped = address.scopeChannelJid(
      'feishu:chat-1#thread:thread-1#root:root-1',
      'feishu-bot-a',
    );
    expect(scoped).toBe(
      'feishu:chat-1#account:feishu-bot-a#thread:thread-1#root:root-1',
    );
    expect(address.toProviderJid(scoped)).toBe(
      'feishu:chat-1#thread:thread-1#root:root-1',
    );
    expect(address.channelConversationJid(scoped)).toBe(
      'feishu:chat-1#account:feishu-bot-a',
    );
  });
});
