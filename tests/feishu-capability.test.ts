import type { Client } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';

import { executeFeishuCapability } from '../src/feishu-capability.js';
import type { ChannelTurnContext } from '../src/types.js';

function context(overrides?: Partial<ChannelTurnContext>): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: 'account-a',
    sourceJid:
      'feishu:oc_chat#account:account-a#thread:omt_thread#root:om_root',
    bot: { appId: 'cli_a', openId: 'ou_bot', name: 'Bot A' },
    chat: { id: 'oc_chat', type: 'group', isTopicStyle: true },
    message: {
      id: 'om_incoming',
      rootId: 'om_root',
      threadId: 'omt_thread',
    },
    sender: {
      openId: 'ou_sender',
      userId: 'u_sender',
      unionId: 'on_sender',
      name: 'Sender',
    },
    ...overrides,
  };
}

function mockClient() {
  const client = {
    im: {
      v1: {
        chat: { get: vi.fn() },
        chatMembers: { get: vi.fn() },
        message: {
          get: vi.fn(),
          list: vi.fn(),
          reply: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        messageReaction: { create: vi.fn(), delete: vi.fn() },
      },
    },
    contact: { v3: { user: { get: vi.fn() } } },
    request: vi.fn(),
  };
  return client as unknown as Client & typeof client;
}

describe('Feishu Capability Broker executor', () => {
  it('reads only the current thread and returns sanitized message fields', async () => {
    const client = mockClient();
    client.im.v1.message.list.mockResolvedValue({
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            message_id: 'om_1',
            chat_id: 'oc_chat',
            thread_id: 'omt_thread',
            msg_type: 'text',
            create_time: '123',
            sender: {
              id: 'ou_sender',
              id_type: 'open_id',
              sender_type: 'user',
              sender_name: 'Sender',
              tenant_key: 'tenant-a',
              access_token: 'must-not-leak',
            },
            body: { content: '{"text":"hello"}' },
            authorization: 'must-not-leak',
          },
        ],
      },
    });

    const result = await executeFeishuCapability(client, context(), {
      operation: 'get_history',
      params: { pageSize: 20 },
    });

    expect(client.im.v1.message.list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'thread',
        container_id: 'omt_thread',
        page_size: 20,
        with_sender_name: true,
      }),
    });
    expect(JSON.stringify(result)).toContain('hello');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('falls back to root-scoped filtering when no thread id is available', async () => {
    const client = mockClient();
    client.im.v1.message.list.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: 'om_root', chat_id: 'oc_chat', body: { content: 'r' } },
          {
            message_id: 'om_child',
            root_id: 'om_root',
            chat_id: 'oc_chat',
            body: { content: 'c' },
          },
          {
            message_id: 'om_other',
            chat_id: 'oc_chat',
            body: { content: 'x' },
          },
        ],
      },
    });

    const result = await executeFeishuCapability(
      client,
      context({ message: { id: 'om_incoming', rootId: 'om_root' } }),
      { operation: 'get_history' },
    );

    expect(result.data).toMatchObject({ scope: 'root' });
    expect(JSON.stringify(result)).toContain('om_child');
    expect(JSON.stringify(result)).not.toContain('om_other');
  });

  it('sends a card as a threaded reply to the trusted current root', async () => {
    const client = mockClient();
    client.im.v1.message.reply.mockResolvedValue({
      code: 0,
      data: {
        message_id: 'om_card',
        root_id: 'om_root',
        thread_id: 'omt_thread',
      },
    });
    const card = { schema: '2.0', body: { elements: [] } };

    const result = await executeFeishuCapability(client, context(), {
      operation: 'send_card',
      params: { card },
    });

    expect(client.im.v1.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        reply_in_thread: true,
      },
    });
    expect(result.data).toMatchObject({ messageId: 'om_card' });
  });

  it('queries only the sender bound to the current turn', async () => {
    const client = mockClient();
    client.contact.v3.user.get.mockResolvedValue({
      code: 0,
      data: { user: { open_id: 'ou_sender', name: 'Sender' } },
    });

    await executeFeishuCapability(client, context(), {
      operation: 'get_user',
      params: { userId: 'ou_attacker', userIdType: 'open_id' },
    });

    expect(client.contact.v3.user.get).toHaveBeenCalledWith({
      path: { user_id: 'ou_sender' },
      params: { user_id_type: 'open_id' },
    });
  });

  it('falls back to trusted turn identity when Contact permission is unavailable', async () => {
    const client = mockClient();
    client.contact.v3.user.get.mockRejectedValue({
      response: { data: { code: 99991672 } },
    });

    const result = await executeFeishuCapability(client, context(), {
      operation: 'get_user',
      params: { userId: 'ou_attacker' },
    });

    expect(result.data).toMatchObject({
      openId: 'ou_sender',
      userId: 'u_sender',
      unionId: 'on_sender',
      name: 'Sender',
      source: 'turn_context',
      enrichmentStatus: 'unavailable',
      enrichmentErrorCode: 99991672,
    });
  });

  it('verifies message ownership before edit and recall', async () => {
    const client = mockClient();
    client.im.v1.message.get.mockResolvedValue({
      code: 0,
      data: { items: [{ message_id: 'om_bot', chat_id: 'oc_chat' }] },
    });
    client.im.v1.message.update.mockResolvedValue({
      code: 0,
      data: { message_id: 'om_bot' },
    });
    client.im.v1.message.delete.mockResolvedValue({ code: 0, data: {} });

    await executeFeishuCapability(client, context(), {
      operation: 'edit_message',
      params: { messageId: 'om_bot', text: 'updated' },
    });
    await executeFeishuCapability(client, context(), {
      operation: 'recall_message',
      params: { messageId: 'om_bot' },
    });

    expect(client.im.v1.message.get).toHaveBeenCalledTimes(2);
    expect(client.im.v1.message.update).toHaveBeenCalledWith({
      path: { message_id: 'om_bot' },
      data: { msg_type: 'text', content: '{"text":"updated"}' },
    });
    expect(client.im.v1.message.delete).toHaveBeenCalledWith({
      path: { message_id: 'om_bot' },
    });
  });

  it('rejects mutation of a message from another chat', async () => {
    const client = mockClient();
    client.im.v1.message.get.mockResolvedValue({
      code: 0,
      data: { items: [{ message_id: 'om_other', chat_id: 'oc_other' }] },
    });

    await expect(
      executeFeishuCapability(client, context(), {
        operation: 'recall_message',
        params: { messageId: 'om_other' },
      }),
    ).rejects.toThrow('does not belong');
    expect(client.im.v1.message.delete).not.toHaveBeenCalled();
  });

  it('allowlists generic APIs and strips credentials from responses', async () => {
    const client = mockClient();
    client.request.mockResolvedValue({
      code: 0,
      data: { document_id: 'doc_1', tenant_access_token: 'secret' },
      headers: { authorization: 'Bearer secret' },
    });

    const result = await executeFeishuCapability(client, context(), {
      operation: 'api_request',
      params: {
        method: 'GET',
        path: '/open-apis/docx/v1/documents/doc_1/raw_content',
      },
    });

    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/docx/v1/documents/doc_1/raw_content',
      }),
    );
    expect(JSON.stringify(result)).toContain('doc_1');
    expect(JSON.stringify(result)).not.toContain('secret');

    await expect(
      executeFeishuCapability(client, context(), {
        operation: 'api_request',
        params: {
          method: 'POST',
          path: '/open-apis/auth/v3/tenant_access_token/internal',
        },
      }),
    ).rejects.toThrow('not broker-allowlisted');
  });
});
