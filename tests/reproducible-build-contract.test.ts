import fs from 'node:fs';
import path from 'node:path';
import { check as prettierCheck, resolveConfig } from 'prettier';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const lockfiles = [
  'package-lock.json',
  'web/package-lock.json',
  'container/agent-runner/package-lock.json',
];

const streamEventFiles = [
  'shared/stream-event.ts',
  'src/stream-event.types.ts',
  'web/src/stream-event.types.ts',
  'container/agent-runner/src/stream-event.types.ts',
];

describe('reproducible build contract', () => {
  test('all npm projects commit lockfiles and install them with npm ci', () => {
    const gitignore = read('.gitignore');
    for (const lockfile of lockfiles) {
      expect(fs.existsSync(path.join(root, lockfile))).toBe(true);
      expect(gitignore).not.toMatch(
        new RegExp(
          `^${lockfile.replaceAll('/', '\\/').replace('.', '\\.')}\$`,
          'm',
        ),
      );

      const lock = JSON.parse(read(lockfile)) as {
        packages: Record<string, { resolved?: string }>;
      };
      for (const dependency of Object.values(lock.packages)) {
        expect(dependency.resolved ?? '').not.toMatch(/^git\+ssh:/);
      }
    }

    const makefile = read('Makefile');
    const installTarget = makefile
      .split(/\n(?=\S)/)
      .find((target) => target.startsWith('install:'));
    expect(installTarget).toContain('$(PKG) ci');
    expect(installTarget).toContain('container/agent-runner && $(PKG) ci');
    expect(installTarget).toContain('web && $(PKG) ci');
    expect(installTarget).not.toMatch(/\$\(PKG\) install(?:\s|$)/);

    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm ci');
    expect(ci).toContain('npm --prefix web ci');
    expect(ci).toContain('npm --prefix container/agent-runner ci');
    expect(ci).not.toMatch(/^\s+npm(?: --prefix \S+)? install\s*$/m);
    expect(ci).toMatch(/uses: actions\/checkout@[a-f0-9]{40}/);
    expect(ci).toMatch(/uses: actions\/setup-node@[a-f0-9]{40}/);
  });

  test('generated StreamEvent copies stay synchronized and formatted', async () => {
    const canonical = read(streamEventFiles[0]);
    for (const file of streamEventFiles) {
      const source = read(file);
      expect(source).toBe(canonical);
      const filepath = path.join(root, file);
      expect(
        await prettierCheck(source, {
          ...(await resolveConfig(filepath)),
          filepath,
        }),
      ).toBe(true);
    }
  });

  test('container downloads use pinned versions and integrity checks', () => {
    const dockerfile = read('container/Dockerfile');
    const buildScript = read('container/build.sh');

    expect(dockerfile).toMatch(
      /^FROM node:\d+\.\d+\.\d+-slim@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toMatch(
      /COPY --from=ghcr\.io\/astral-sh\/uv:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}/,
    );
    expect(dockerfile).toMatch(/ARG FEISHU_CLI_VERSION=v\d+\.\d+\.\d+/);
    expect(dockerfile).toMatch(/ARG OH_MY_ZSH_COMMIT=[a-f0-9]{40}/);
    expect(dockerfile).toContain('headroom-ai[code,mcp]==0.27.0');
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile).not.toContain('releases/latest');
    expect(dockerfile).not.toMatch(/(?:^|[/:])latest(?:\s|$)/m);
    expect(dockerfile).not.toContain('npm install -g');
    expect(buildScript).not.toContain('CACHEBUST');
  });
});
