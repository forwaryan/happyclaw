import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  importSkillsFromGit,
  importSkillsFromZip,
} from '../src/skill-import-service.js';

let tempDir: string;
let targetRoot: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-test-'));
  targetRoot = path.join(tempDir, 'skills');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createSkillArchive(skills: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [id, description] of Object.entries(skills)) {
    zip.addFile(
      `bundle/${id}/SKILL.md`,
      Buffer.from(`---\nname: ${id}\ndescription: ${description}\n---\n`),
    );
    zip.addFile(
      `bundle/${id}/references/example.md`,
      Buffer.from('# reference'),
    );
  }
  return zip.toBuffer();
}

describe('skill import service', () => {
  test('imports multiple skills from a ZIP archive', () => {
    const result = importSkillsFromZip({
      archive: createSkillArchive({
        review: 'Review code',
        research: 'Research',
      }),
      archiveName: 'skills.zip',
      targetRoot,
    });

    expect(result).toEqual({
      installed: ['research', 'review'],
      sourceUrl: 'skills.zip',
    });
    expect(
      fs.readFileSync(path.join(targetRoot, 'review', 'SKILL.md'), 'utf8'),
    ).toContain('Review code');
    expect(
      fs.existsSync(
        path.join(targetRoot, 'research', 'references', 'example.md'),
      ),
    ).toBe(true);
  });

  test('does not overwrite an existing skill unless replace is explicit', () => {
    fs.mkdirSync(path.join(targetRoot, 'review'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'review', 'SKILL.md'), 'existing');

    expect(() =>
      importSkillsFromZip({
        archive: createSkillArchive({ review: 'replacement' }),
        archiveName: 'skills.zip',
        targetRoot,
      }),
    ).toThrow('Skill already exists: review');
    expect(
      fs.readFileSync(path.join(targetRoot, 'review', 'SKILL.md'), 'utf8'),
    ).toBe('existing');

    importSkillsFromZip({
      archive: createSkillArchive({ review: 'replacement' }),
      archiveName: 'skills.zip',
      targetRoot,
      replace: true,
    });
    expect(
      fs.readFileSync(path.join(targetRoot, 'review', 'SKILL.md'), 'utf8'),
    ).toContain('replacement');
  });

  test('rejects path traversal and unsafe Git URLs before writing files', async () => {
    const zip = new AdmZip();
    zip.addFile('safe/SKILL.md', Buffer.from('# unsafe'));
    zip.getEntries()[0].entryName = '../escaped/SKILL.md';
    expect(() =>
      importSkillsFromZip({
        archive: zip.toBuffer(),
        archiveName: 'unsafe.zip',
        targetRoot,
      }),
    ).toThrow(/path traversal|unsafe absolute path/);

    await expect(
      importSkillsFromGit({ url: 'https://127.0.0.1/skills.git', targetRoot }),
    ).rejects.toThrow('Refused Git URL');
    expect(fs.existsSync(targetRoot)).toBe(false);
  });
});
