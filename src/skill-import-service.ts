import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import AdmZip from 'adm-zip';
import { validateSkillId } from './skill-utils.js';
import { isPrivateHostname, validateSafeHttpsUrl } from './url-safety.js';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_SCAN_DEPTH = 5;

export interface SkillImportResult {
  installed: string[];
  sourceUrl?: string;
  version?: string;
}

function isSymlinkMode(attributes: number): boolean {
  const unixMode = (attributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function validateArchiveEntryName(entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error('Archive contains an unsafe absolute path');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Archive contains a path traversal entry');
  }
  return normalized;
}

function assertSafeSkillTree(root: string): void {
  let entries = 0;
  let totalBytes = 0;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ENTRIES)
        throw new Error('Skill contains too many files');
      const fullPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Skill packages cannot contain symbolic links');
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_EXPANDED_BYTES) {
          throw new Error('Skill package is too large after extraction');
        }
      }
    }
  };
  visit(root);
}

function findSkillDirectories(
  root: string,
): Array<{ id: string; dir: string }> {
  const found = new Map<string, string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    const skillFile = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
      const id = path.basename(dir);
      if (!validateSkillId(id)) {
        throw new Error(`Invalid skill directory name: ${id}`);
      }
      if (found.has(id)) throw new Error(`Duplicate skill ID: ${id}`);
      found.set(id, dir);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === '.git' ||
        entry.name === 'node_modules'
      )
        continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  if (found.size === 0)
    throw new Error('No directory containing SKILL.md was found');
  return [...found]
    .map(([id, dir]) => ({ id, dir }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function installSkillDirectories(
  candidates: Array<{ id: string; dir: string }>,
  targetRoot: string,
  replace: boolean,
): string[] {
  fs.mkdirSync(targetRoot, { recursive: true });
  const conflicts = candidates.filter(({ id }) =>
    fs.existsSync(path.join(targetRoot, id)),
  );
  if (conflicts.length > 0 && !replace) {
    throw new Error(
      `Skill already exists: ${conflicts.map(({ id }) => id).join(', ')}`,
    );
  }

  const transactionDir = fs.mkdtempSync(path.join(targetRoot, '.import-'));
  const backups: Array<{ destination: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    for (const candidate of candidates) {
      const staged = path.join(transactionDir, candidate.id);
      fs.cpSync(candidate.dir, staged, { recursive: true, dereference: false });
      assertSafeSkillTree(staged);
    }
    for (const candidate of candidates) {
      const destination = path.join(targetRoot, candidate.id);
      if (fs.existsSync(destination)) {
        const backup = path.join(transactionDir, `.backup-${candidate.id}`);
        fs.renameSync(destination, backup);
        backups.push({ destination, backup });
      }
      fs.renameSync(path.join(transactionDir, candidate.id), destination);
      installed.push(candidate.id);
    }
    for (const { backup } of backups)
      fs.rmSync(backup, { recursive: true, force: true });
    return installed;
  } catch (error) {
    for (const id of installed)
      fs.rmSync(path.join(targetRoot, id), { recursive: true, force: true });
    for (const { destination, backup } of backups) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    }
    throw error;
  } finally {
    fs.rmSync(transactionDir, { recursive: true, force: true });
  }
}

export async function importSkillsFromGit(options: {
  url: string;
  ref?: string;
  subdirectory?: string;
  targetRoot: string;
  replace?: boolean;
}): Promise<SkillImportResult> {
  const reason = validateSafeHttpsUrl(options.url);
  if (reason) throw new Error(`Refused Git URL: ${reason}`);
  const parsedUrl = new URL(options.url);
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Git URLs containing credentials are not allowed');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(parsedUrl.hostname, { all: true });
  } catch {
    throw new Error('Git hostname could not be resolved');
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateHostname(address))
  ) {
    throw new Error('Git hostname resolves to a private or link-local address');
  }
  if (options.ref && !/^[\w./-]{1,200}$/.test(options.ref)) {
    throw new Error('Invalid Git ref');
  }
  if (options.subdirectory) {
    const normalized = path.posix.normalize(
      options.subdirectory.replace(/\\/g, '/'),
    );
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error('Invalid Git subdirectory');
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-git-import-'));
  const repoDir = path.join(tempDir, 'repo');
  try {
    const args = [
      '-c',
      'http.followRedirects=false',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'submodule.recurse=false',
      'clone',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
    ];
    if (options.ref) args.push('--branch', options.ref);
    args.push('--', options.url, repoDir);
    await execFileAsync('git', args, {
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
    });
    const scanRoot = options.subdirectory
      ? path.resolve(repoDir, options.subdirectory)
      : repoDir;
    if (scanRoot !== repoDir && !scanRoot.startsWith(`${repoDir}${path.sep}`)) {
      throw new Error('Git subdirectory escapes the repository');
    }
    if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
      throw new Error('Git subdirectory does not exist');
    }
    const candidates = findSkillDirectories(scanRoot);
    for (const candidate of candidates) assertSafeSkillTree(candidate.dir);
    const installed = installSkillDirectories(
      candidates,
      options.targetRoot,
      options.replace === true,
    );
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoDir,
      'rev-parse',
      'HEAD',
    ]);
    return { installed, sourceUrl: options.url, version: stdout.trim() };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function importSkillsFromZip(options: {
  archive: Buffer;
  archiveName: string;
  targetRoot: string;
  replace?: boolean;
}): SkillImportResult {
  if (
    options.archive.byteLength === 0 ||
    options.archive.byteLength > MAX_ARCHIVE_BYTES
  ) {
    throw new Error('ZIP archive must be between 1 byte and 10 MB');
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-zip-import-'));
  try {
    const zip = new AdmZip(options.archive);
    const entries = zip.getEntries();
    if (entries.length === 0 || entries.length > MAX_ENTRIES) {
      throw new Error('ZIP archive has an invalid number of entries');
    }
    let expandedBytes = 0;
    for (const entry of entries) {
      validateArchiveEntryName(entry.entryName);
      if (isSymlinkMode(entry.attr))
        throw new Error('ZIP archives cannot contain symbolic links');
      expandedBytes += entry.header.size;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('ZIP archive is too large after extraction');
      }
    }
    zip.extractAllTo(tempDir, true, false);
    assertSafeSkillTree(tempDir);
    const candidates = findSkillDirectories(tempDir);
    return {
      installed: installSkillDirectories(
        candidates,
        options.targetRoot,
        options.replace === true,
      ),
      sourceUrl: options.archiveName,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
