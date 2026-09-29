import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const names = ['execution-keeper', 'execution-bootstrap', 'execution-worker',
  'authority-git', 'execution-security', 'execution-credential'];

describe('native build attestation', () => {
  it('verifies without rebuilding and rejects source or binary drift in an isolated copy', () => {
    const sourceRoot = resolve('.');
    const root = mkdtempSync(join(tmpdir(), 'eng-native-build-attestation-'));
    try {
      for (const part of ['scripts', 'src/native', 'dist/native']) {
        mkdirSync(join(root, part), { recursive: true });
      }
      const script = join(root, 'scripts', 'build-execution-keeper.mjs');
      copyFileSync(join(sourceRoot, 'scripts', 'build-execution-keeper.mjs'), script);
      copyFileSync(join(sourceRoot, 'dist', 'native', 'native-build.json'),
        join(root, 'dist', 'native', 'native-build.json'));
      for (const name of names) {
        copyFileSync(join(sourceRoot, 'src', 'native', `${name}.cs`),
          join(root, 'src', 'native', `${name}.cs`));
        copyFileSync(join(sourceRoot, 'dist', 'native', `${name}.exe`),
          join(root, 'dist', 'native', `${name}.exe`));
      }
      const verify = () => spawnSync(process.execPath, [script, '--verify'],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(verify().status).toBe(0);
      appendFileSync(join(root, 'src', 'native', 'execution-worker.cs'), '\n// drift\n');
      expect(verify().status).not.toBe(0);
      copyFileSync(join(sourceRoot, 'src', 'native', 'execution-worker.cs'),
        join(root, 'src', 'native', 'execution-worker.cs'));
      appendFileSync(join(root, 'dist', 'native', 'execution-worker.exe'), Buffer.from([0]));
      expect(verify().status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
