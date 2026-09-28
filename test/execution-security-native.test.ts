import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../dist/native/execution-security.exe', import.meta.url));
const created: string[] = [];
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'eng-security-native-'));
  created.push(path);
  return path;
}
function run(operation: 'snapshot' | 'witness', request: unknown) {
  return spawnSync(helper, [operation], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
}
afterEach(() => {
  for (const path of created.splice(0)) {
    const root = resolve(tmpdir());
    const target = resolve(path);
    if (!isAbsolute(target) || !target.startsWith(root + sep) || !target.includes('eng-security-native-')) {
      throw new Error('isolated test cleanup path escaped');
    }
    rmSync(target, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('fixed native execution security boundary', () => {
  it('returns a bounded ACL snapshot without PowerShell', () => {
    const path = fixture();
    const result = run('snapshot', [path]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const value = JSON.parse(result.stdout) as { sid: string; rows: Array<{
      path: string; owner: string; protected: boolean; reparse: boolean;
      sddl: string; aces: Array<{ sid: string; rights: number; inherited: boolean }>;
    }> };
    expect(value.sid).toMatch(/^S-1-/);
    expect(value.rows).toHaveLength(1);
    expect(value.rows[0]).toMatchObject({ path, reparse: false });
    expect(value.rows[0]?.owner).toBe(value.sid);
    expect(value.rows[0]?.aces.length).toBeGreaterThan(0);
    expect(value.rows[0]?.sddl).toContain('D:');
    expect(run('snapshot', { path }).status).toBe(86);
  });

  it('seals and reads a Core-owned witness while refusing the wrong Core SID and file owner', () => {
    const parent = fixture();
    const root = join(parent, 'execution-witnesses');
    const dispatch = join(root, '11111111-1111-4111-8111-111111111111');
    const caller = JSON.parse(run('snapshot', [parent]).stdout) as { sid: string };
    const request = { operation: 'root', root, dispatch, core: caller.sid,
      keeper: 'S-1-5-19', operator: 'S-1-5-11' };
    expect(run('witness', request).status).toBe(0);
    expect(existsSync(root)).toBe(true);
    const rootAcl = JSON.parse(run('snapshot', [root]).stdout) as { rows: Array<{
      protected: boolean; aces: Array<{ sid: string; rights: number }>;
    }> };
    expect(rootAcl.rows[0]?.protected).toBe(true);
    expect(rootAcl.rows[0]?.aces.find((ace) => ace.sid === 'S-1-3-4')?.rights).toBe(1179648);
    mkdirSync(join(dispatch, 'control'), { recursive: true });
    mkdirSync(join(dispatch, 'keeper'), { recursive: true });
    writeFileSync(join(dispatch, 'control', 'bootstrap.json'), '{}');
    expect(run('witness', { ...request, operation: 'seal' }).status).toBe(0);
    expect(run('witness', { ...request, operation: 'read' }).status).toBe(0);
    expect(run('witness', { ...request, operation: 'read', core: 'S-1-5-19' }).status).toBe(86);
    writeFileSync(join(dispatch, 'keeper', 'drain-receipt.json'), '{}');
    expect(readFileSync(join(dispatch, 'keeper', 'drain-receipt.json'), 'utf8')).toBe('{}');
    expect(run('witness', { ...request, operation: 'read' }).status).toBe(86);
  });
});
