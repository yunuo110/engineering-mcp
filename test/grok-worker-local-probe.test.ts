import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, WRITER_PROTOCOL_GENERATION } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const probe = join(root, 'test', 'fixtures', 'portable-legacy', 'manual-grok-worker-probe.ps1');
const source = readFileSync(probe, 'utf8');

describe('manual Grok local preflight boundary (no live Grok)', () => {
  it('parses in Windows PowerShell and runs only synthetic projection / compiled fixed-command self-tests', () => {
    expect(process.platform).toBe('win32');
    // Sanitized fixture bytes (LF-normalized), not a historical probe or Grok artifact hash.
    expect(createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex'))
      .toBe('289e6a9eabad6ea2e3261dd2b1c5c0880dd5c9fdcb5296d120d083070e509173');
    expect(source).toContain('TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE');
    expect(source).toContain("$RepoRoot = 'C:\\FixtureRoot\\repo'");
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe, '-SelfTest'], {
      cwd: root, encoding: 'utf8', windowsHide: true, shell: false,
      timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(output.replace(/^\uFEFF/, ''))).toEqual({
      status: 'PASS', kind: 'OFFLINE_PROJECTION_AND_FIXED_COMMAND_TEST',
      grok_invocations: 0, live_auth_tested: false, live_isolation_tested: false,
    });
  });

  it('has exactly six fixed diagnostic argument sets, all disabling updates, and no real task invocation', () => {
    const argumentsFound = [...source.matchAll(/case Diagnostic\.[A-Za-z]+: return "([^"]+)";/g)].map((match) => match[1]);
    expect(argumentsFound).toEqual([
      '--no-auto-update --help', '--no-auto-update version',
      '--no-auto-update agent --help', '--no-auto-update agent stdio --help',
      '--no-auto-update inspect --help', '--no-auto-update inspect --json',
    ]);
    expect(source).toContain('si.UseShellExecute=false');
    expect(source).not.toMatch(/case Diagnostic\.[A-Za-z]+: return "[^"]*(?: -p |always-approve| login| logout| update|session\/prompt)/);
  });

  it('keeps self-test ahead of every live identity/discovery/invocation branch', () => {
    const guard = source.indexOf('if ($SelfTest) {');
    expect(guard).toBeGreaterThan(0);
    expect(source.slice(guard, source.indexOf('$report = [ordered]@{'))).toContain('exit 0');
    expect(source.indexOf('[Security.Principal.WindowsIdentity]::GetCurrent()')).toBeGreaterThan(guard);
    expect(source.indexOf('$capture=[EngineeringGrokLocalProbe.Native]::Run(')).toBeGreaterThan(guard);
  });

  it('requires one canonical candidate, PE checks and path/hash revalidation, without fallback', () => {
    expect(source).toContain('$unique.Count -ne 1');
    expect(source).toContain('GetFinalPathNameByHandle');
    expect(source).toContain('FileShare.Read');
    expect(source).toContain('r.ReadUInt16()!=0x5a4d');
    expect(source).toContain('r.ReadUInt32()!=0x4550');
    expect(source).toContain('Hash(held)!=expectedHash');
    expect(source).toContain('$again.Sha256 -cne $selected.Sha256');
  });

  it('does not promote unknown inspect coverage, a matching SID or a empty server list into isolation', () => {
    expect(source).toContain("owner_tools_reachable='UNPROVEN'");
    expect(source).toContain("environment_equivalence='UNPROVEN'");
    expect(source).toContain("elevation_equivalence='UNPROVEN'");
    expect(source).toContain("schema_coverage = 'UNPROVEN'");
    expect(source).not.toMatch(/owner_tools_reachable\s*=\s*'NO'/);
    expect(source).toContain('GetOwnerSid');
    expect(source).not.toMatch(/-Property[^\r\n]*CommandLine/);
    expect(source).toContain("enablement='HOLD'");
  });

  it('omits credential-bearing fields, unknown labels, raw streams and raw exceptions', () => {
    expect(source).toContain('OMITTED_UNREVIEWED_LABEL');
    expect(source).toContain('$capture.Out=\'\'; $capture.Err=\'\'');
    expect(source).not.toMatch(/Get-Content|ReadAllText|Start-Transcript|Set-ExecutionPolicy|Invoke-Expression|Invoke-WebRequest/);
    expect(source).not.toMatch(/\$env:(?:XAI_API_KEY|GROK_DEPLOYMENT_KEY)|Exception\.Message\s*\}/);
    expect(source).toContain("raw_streams_saved=$false");
    expect(source).toContain("config_or_auth_files_copied=$false");
  });

  it('bounds child execution and records cleanup instead of treating a job as a Windows sandbox proof', () => {
    expect(source).toContain('watch.ElapsedMilliseconds<15000');
    expect(source).toContain('sink.Length+n>1048576');
    expect(source).toContain('AssignProcessToJobObject');
    expect(source).toContain('PIPE_CLEANUP_UNPROVEN');
    expect(source).toContain('Job assignment occurs after process start');
    expect(source).toContain("windows_sandbox='UNPROVEN'");
  });

  it('does not alter the frozen database or writer protocol', () => {
    expect(SCHEMA_VERSION).toBe(12);
    expect(WRITER_PROTOCOL_GENERATION).toBe(4);
    expect(source).not.toMatch(/ledger\.sqlite|new DatabaseSync|claimC2CDispatchTask\(/);
  });
});
