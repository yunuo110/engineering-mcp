import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../dist/native/execution-security.exe', import.meta.url));
const ownerFixtureSource = fileURLToPath(new URL('./fixtures/execution-security-core-owner.cs', import.meta.url));
const created: string[] = [];
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'eng-security-native-'));
  created.push(path);
  return path;
}
function compileOwnerFixture(parent: string): string {
  const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET',
    'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = join(parent, 'core-owner-fixture.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
    ownerFixtureSource], { windowsHide: true });
  return executable;
}
function run(operation: 'snapshot' | 'witness', request: unknown) {
  return spawnSync(helper, [operation], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
}
function expectSuccess(operation: 'snapshot' | 'witness', request: unknown, fixturePath: string) {
  const result = run(operation, request);
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(JSON.stringify({ operation, fixturePath, status: result.status,
      signal: result.signal, stdout: result.stdout, stderr: result.stderr,
      spawnError: result.error?.message }));
  }
  return result;
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
    const result = expectSuccess('snapshot', [path], path);
    expect(result.stderr).toBe('');
    const value = JSON.parse(result.stdout) as { sid: string; rows: Array<{
      path: string; owner: string; protected: boolean; reparse: boolean;
      sddl: string; aces: Array<{ sid: string; rights: number; inherited: boolean }>;
    }> };
    expect(value.sid).toMatch(/^S-1-/);
    expect(value.rows).toHaveLength(1);
    expect(value.rows[0]).toMatchObject({ path: realpathSync.native(path), reparse: false });
    expect(value.rows[0]?.owner).toMatch(/^S-1-/);
    expect(value.rows[0]?.aces.length).toBeGreaterThan(0);
    expect(value.rows[0]?.sddl).toContain('D:');
    expect(run('snapshot', { path }).status).toBe(86);
  });

  it('seals and reads a Core-owned witness while refusing the wrong Core SID and file owner', () => {
    const parent = fixture();
    const root = join(parent, 'execution-witnesses');
    const dispatch = join(root, '11111111-1111-4111-8111-111111111111');
    const caller = JSON.parse(expectSuccess('snapshot', [parent], parent).stdout) as { sid: string };
    const ownerFixture = compileOwnerFixture(parent);
    const nested = join(parent, 'eng-security-native-nested');
    mkdirSync(nested);
    const forbiddenRoot = join(nested, 'execution-witnesses');
    expect(spawnSync(ownerFixture, ['provision', forbiddenRoot,
      join(forbiddenRoot, '11111111-1111-4111-8111-111111111111'), 'S-1-5-19'],
    { windowsHide: true }).status).not.toBe(0);
    expect(existsSync(forbiddenRoot)).toBe(false);
    execFileSync(ownerFixture, ['provision', root, dispatch, 'S-1-5-19'],
      { windowsHide: true });
    const prepared = JSON.parse(expectSuccess('snapshot', [root, dispatch,
      join(dispatch, 'control'), join(dispatch, 'keeper'),
      join(dispatch, 'control', 'bootstrap.json')], root).stdout) as {
      sid: string; rows: Array<{ owner: string; protected: boolean; sddl: string; aces: Array<{
        sid: string; rights: number; inherited: boolean; type: string; inheritOnly: boolean;
        containerInherit: boolean; objectInherit: boolean;
      }> }>;
    };
    expect(prepared.sid).toBe(caller.sid);
    expect(prepared.rows.map((row) => row.owner)).toEqual(Array(5).fill(caller.sid));
    expect(prepared.rows[0]?.protected).toBe(true);
    const aceShape = (ace: (typeof prepared.rows)[number]['aces'][number]) => ({
      sid: ace.sid, rights: ace.rights, inherited: ace.inherited, type: ace.type,
      inheritOnly: ace.inheritOnly, containerInherit: ace.containerInherit,
      objectInherit: ace.objectInherit,
    });
    const expectedRootAces = [
      { sid: 'S-1-5-18', rights: 2032127, inherited: false, type: 'Allow',
        inheritOnly: false, containerInherit: true, objectInherit: true },
      { sid: 'S-1-5-11', rights: 2032127, inherited: false, type: 'Allow',
        inheritOnly: false, containerInherit: true, objectInherit: true },
      { sid: caller.sid, rights: 1179821, inherited: false, type: 'Allow',
        inheritOnly: false, containerInherit: false, objectInherit: false },
      { sid: caller.sid, rights: 2032127, inherited: false, type: 'Allow',
        inheritOnly: true, containerInherit: true, objectInherit: true },
      { sid: 'S-1-5-19', rights: 1179817, inherited: false, type: 'Allow',
        inheritOnly: false, containerInherit: false, objectInherit: false },
      { sid: 'S-1-3-4', rights: 1179648, inherited: false, type: 'Allow',
        inheritOnly: false, containerInherit: false, objectInherit: false },
    ];
    const sortAce = (a: { sid: string; rights: number; inheritOnly: boolean },
      b: { sid: string; rights: number; inheritOnly: boolean }) =>
      `${a.sid}:${a.rights}:${a.inheritOnly}`.localeCompare(`${b.sid}:${b.rights}:${b.inheritOnly}`);
    expect(prepared.rows[0]?.aces.map(aceShape).sort(sortAce)).toEqual(expectedRootAces.sort(sortAce));
    const request = { operation: 'root', root, dispatch, core: caller.sid,
      keeper: 'S-1-5-19', operator: 'S-1-5-11' };
    expectSuccess('witness', request, root);
    expect(existsSync(root)).toBe(true);
    const rootAcl = JSON.parse(expectSuccess('snapshot', [root], root).stdout) as { rows: Array<{
      protected: boolean; sddl: string; aces: Array<{ sid: string; rights: number }>;
    }> };
    expect(rootAcl.rows[0]?.protected).toBe(true);
    expect(rootAcl.rows[0]?.sddl).toBe(prepared.rows[0]?.sddl);
    expect(rootAcl.rows[0]?.aces.find((ace) => ace.sid === 'S-1-3-4')?.rights).toBe(1179648);
    expectSuccess('witness', { ...request, operation: 'seal' }, dispatch);
    expectSuccess('witness', { ...request, operation: 'read' }, dispatch);
    expect(run('witness', { ...request, operation: 'read', core: 'S-1-5-19' }).status).toBe(86);
    const receipt = join(dispatch, 'keeper', 'drain-receipt.json');
    writeFileSync(receipt, '{}');
    execFileSync(ownerFixture, ['own-file', receipt], { windowsHide: true });
    const receiptSnapshot = JSON.parse(expectSuccess('snapshot', [receipt], receipt).stdout) as {
      rows: Array<{ owner: string }>;
    };
    expect(receiptSnapshot.rows[0]?.owner).toBe(caller.sid);
    expect(receiptSnapshot.rows[0]?.owner).not.toBe(request.keeper);
    expect(readFileSync(receipt, 'utf8')).toBe('{}');
    const wrongOwner = run('witness', { ...request, operation: 'read' });
    expect(wrongOwner.status).toBe(86);
    expect(wrongOwner.stderr).toContain('witness owner/inheritance mismatch');
  });

  it('refuses a Core-owned but unsealed existing witness root', () => {
    const parent = fixture();
    const root = join(parent, 'execution-witnesses');
    const dispatch = join(root, '22222222-2222-4222-8222-222222222222');
    const ownerFixture = compileOwnerFixture(parent);
    mkdirSync(root);
    execFileSync(ownerFixture, ['own-root', root], { windowsHide: true });
    const observed = JSON.parse(expectSuccess('snapshot', [root], root).stdout) as {
      sid: string; rows: Array<{ owner: string; protected: boolean }>;
    };
    expect(observed.rows[0]?.owner).toBe(observed.sid);
    expect(observed.rows[0]?.protected).toBe(false);
    const result = run('witness', { operation: 'root', root, dispatch,
      core: observed.sid, keeper: 'S-1-5-19', operator: 'S-1-5-11' });
    expect(result.status).toBe(86);
    expect(result.stderr).toContain('witness owner/inheritance mismatch');
  });
});
