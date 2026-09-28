import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapper = readFileSync(new URL('../src/orchestration/witness-security.ts', import.meta.url), 'utf8');
const native = readFileSync(new URL('../src/native/execution-security.cs', import.meta.url), 'utf8');
const executable = fileURLToPath(new URL('../dist/native/execution-security.exe', import.meta.url));

describe('fixed native witness ACL boundary (cross-SID acceptance remains separate)', () => {
  it('uses the manifest-bound native helper, not an untrusted PowerShell command', () => {
    expect(wrapper).toContain("execFileSync(binding.securityHelperPath, ['witness']");
    expect(wrapper).toContain('assertProtectedRepositoryBinding(storePath, repoRoot)');
    expect(wrapper).not.toContain('powershell.exe');
    expect(execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }))
      .toBe('engineering-execution-security/1');
  });
  it('protects the owner-rights and reparse boundaries in native code', () => {
    expect(native).toContain('FileSystemRights.ReadPermissions');
    expect(native).toContain('(rights & ~1179648)!=0');
    expect(native).toContain('FileAttributes.ReparsePoint');
    expect(native).toContain('acl.SetAccessRuleProtection(true,false)');
    expect(native).toContain('Core must own witness directory before ACL seal');
  });
});
