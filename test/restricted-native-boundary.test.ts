import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('native restricted launch failure ownership', () => {
  it('zeros incomplete reads, rejects role aliases and terminates/waits exact suspended test children', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eng-native-boundary-'));
    try {
      const executable = join(directory, 'native-boundary.exe');
      execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', [
        '/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll',
        '/main:RestrictedNativeBoundaryTests', `/out:${executable}`,
        resolve('src/native/execution-bootstrap.cs'), resolve('src/native/execution-worker.cs'),
        resolve('test/fixtures/restricted-native-boundary.cs'),
      ], { windowsHide: true, timeout: 30000 });
      const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ partial_secret_clear: 2,
        exact_suspended_child_cleanup: 2, role_rejections: 5, role_acceptance_unit: 1,
        administrator_attribute_rejections: { worker: 4, keeper: 4 },
        non_administrator_group_unit: { worker: 1, keeper: 1 },
        owned_stdin_closed: 2, blocked_pipe_cancelled: 2,
        logon_command_boundaries: 4, explicit_environment_blocks: 2,
        real_alternate_identity: 'NOT_RUN' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
