import { describe, expect, test } from 'vitest';

import { resolveStickyChannelOwner } from '../src/channel-session-owner.js';

const feishu = 'feishu:chat-a#account:bot-a#root:root-a#thread:thread-a';

describe('sticky channel session ownership', () => {
  test('Feishu ownership survives a Web follow-up', () => {
    expect(resolveStickyChannelOwner(feishu, 'web:workspace-a')).toBe(feishu);
  });

  test('Feishu ownership cannot be replaced by a later QQ input', () => {
    expect(resolveStickyChannelOwner(feishu, 'qq:group-b#account:bot-b')).toBe(
      feishu,
    );
  });

  test('a Web-created session adopts its first concrete IM source once', () => {
    expect(resolveStickyChannelOwner(null, 'qq:group-b#account:bot-b')).toBe(
      'qq:group-b#account:bot-b',
    );
  });
});
