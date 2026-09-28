import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('C2C read-attributes sanitized binding fixture', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const script = join(process.cwd(), 'test', 'fixtures', 'portable-legacy', 'prepare-readattrs-fixture.ps1');
  it.skipIf(process.platform !== 'win32')('parses under Windows PowerShell 5.1 and generates only synthetic bindings', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE');
    expect(text).toContain("throw 'TEST_FIXTURE_SELFTEST_ONLY'");

    for (const forbidden of [
      'Start-ScheduledTask',
      'Stop-ScheduledTask',
      'Set-ScheduledTask',
      'Register-ScheduledTask',
      'schtasks.exe',
      'client-binding.mjs',
      'stop.request',
    ]) {
      expect(text).not.toContain(forbidden);
    }

    const escaped = script.replace(/'/g, "''");
    const command =
      "$tokens=$null;$errors=$null;" +
      "[System.Management.Automation.Language.Parser]::ParseFile('" + escaped + "',[ref]$tokens,[ref]$errors)|Out-Null;" +
      "if($errors.Count -ne 0){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}";

    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });

    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script, '-SelfTest'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    const result = JSON.parse(output.replace(/^\uFEFF/, '')) as {
      status: string; kind: string; client_access: string; bridge_allow_ace: string; bindings: string;
    };
    expect(result).toMatchObject({ status: 'PASS', kind: 'SANITIZED_FIXTURE_BINDINGS',
      client_access: '0x00120003', bridge_allow_ace: '0x00120083' });
    for (const value of ['S-1-5-21-111-222-333-1006', 'S-1-5-21-111-222-333-1004',
      'C:\\FixtureRoot\\repo', 'C:\\FixtureRoot\\ledger.sqlite', 'C:\\FixtureRoot\\ingress']) {
      expect(result.bindings).toContain(value);
    }
    expect(result.bindings).not.toContain('@@');

    const encoded = readFileSync(join(process.cwd(), 'test', 'fixtures', 'portable-legacy', 'source-capsule.b64'), 'utf8').replace(/\s/g, '');
    const files = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString('utf8')) as Record<string, string>;
    const edits = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'portable-legacy', 'source-edits.json'), 'utf8')) as {
      edits: Array<{ path: string; old: string; new: string }>;
    };
    expect(files['src/WindowsBoundary.cs']).toContain('ClientAccess=0x00120003');
    const bridgeAce = edits.edits.find((edit) => edit.path === 'src/WindowsBoundary.cs'
      && edit.new.includes('0x00120083;;;'));
    expect(bridgeAce?.old).toContain('0x00120003;;;');
    expect(bridgeAce?.new).toContain('0x00120083;;;');
  });
  it.skipIf(process.platform !== 'win32')('fails closed when the bridge binding point is absent', () => {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script,
      '-SelfTest', '-MalformedTemplate'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BRIDGE_SID_BINDING_POINT');
  });
});
