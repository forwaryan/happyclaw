import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');

describe('task run status contract', () => {
  test('shows queued runs before execution starts', () => {
    const store = read('web/src/stores/tasks.ts');
    const detail = read('web/src/components/tasks/TaskDetail.tsx');

    expect(store).toContain(
      "status: 'queued' | 'running' | 'success' | 'error'",
    );
    expect(detail).toMatch(/queued:\s*\{[\s\S]*label: '已排队'/);
  });
});
