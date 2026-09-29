import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertProtectedCredentialAcl, type ProtectedPathAcl } from '../src/orchestration/trusted-runtime.ts';

const suite = process.platform === 'win32' ? describe : describe.skip;
const setup = resolve('test/fixtures/configure-credential-acl.ps1');
const security = resolve('dist/native/execution-security.exe');
const coreSid = 'S-1-5-21-1-2-3-1001';
const keeperSid = 'S-1-5-21-1-2-3-1002';
const workerSid = 'S-1-5-21-1-2-3-1003';
const roots: string[] = [];
function fixture(extraSid?: string) {
  const root = mkdtempSync(join(tmpdir(), 'engineering-credential-acl-')); roots.push(root);
  const blob = join(root, 'bundle.blob'); writeFileSync(blob, Buffer.from([1]));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    setup, '-Root', root, '-CoreSid', coreSid];
  if (extraSid) args.push('-ExtraSid', extraSid);
  expect(execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim())
    .toBe('TEST_CREDENTIAL_ACL_CONFIGURED');
  const output = execFileSync(security, ['snapshot'], { input: JSON.stringify([root, blob]),
    encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const parsed = JSON.parse(output) as { sid: string; rows: ProtectedPathAcl[] };
  expect(parsed.rows).toHaveLength(2);
  return { identity: { operatorSid: parsed.sid, coreSid, keeperSid, workerSid }, rows: parsed.rows };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'engineering-credential-acl-')))
      throw new Error('TEST_TEMP_ROOT_GUARD');
    rmSync(root, { recursive: true, force: true });
  }
});

suite('real Windows credential ACL snapshot', () => {
  it('accepts a protected operator-owned directory and blob with only Core read', () => {
    const value = fixture();
    expect(() => assertProtectedCredentialAcl(value.rows[0]!, 'directory', value.identity)).not.toThrow();
    expect(() => assertProtectedCredentialAcl(value.rows[1]!, 'file', value.identity)).not.toThrow();
  });
  it.each([keeperSid, workerSid, 'S-1-5-11'])(
    'refuses an added file read ACE for %s', (sid) => {
      const value = fixture(sid);
      expect(() => assertProtectedCredentialAcl(value.rows[1]!, 'file', value.identity)).toThrow(/credential/);
    });
});
