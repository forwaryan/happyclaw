import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('session sidebar copy', () => {
  test('uses useful empty-state copy without repeating context implementation details', () => {
    const sidebar = read('web/src/components/chat/SessionSidebar.tsx');
    const chatView = read('web/src/components/chat/ChatView.tsx');

    expect(sidebar).not.toContain('使用独立上下文');
    expect(sidebar).toContain("messagePreview(session) || '暂无消息'");
    expect(sidebar).not.toContain("messagePreview(session) || '独立上下文'");
    expect(chatView).toContain("mainMeta={group.lastMessage || '暂无消息'}");
  });
});
