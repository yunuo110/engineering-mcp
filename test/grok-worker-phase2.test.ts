import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const probe = join(root, 'test', 'fixtures', 'portable-legacy', 'manual-grok-worker-probe-phase2.ps1');
const source = readFileSync(probe, 'utf8');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkTs(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

function filesContainingCall(dir: string, name: string): string[] {
  const call = new RegExp('\\b' + name + '\\s*\\(');
  return walkTs(dir)
    .filter((path) => call.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .sort();
}

describe('Grok Worker Phase-2 fixed metadata probe (no live Grok)', () => {
  it('runs the PowerShell self-test without any Grok invocation, auth action, ACP session, or model call', () => {
    expect(process.platform).toBe('win32');
    expect(source).toContain('TEST FIXTURE - SANITIZED - NOT PRODUCTION EVIDENCE');
    expect(source).toContain("$FixedCwd = 'C:\\FixtureRoot\\repo'");
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const output = execFileSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe, '-SelfTest'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(JSON.parse(output.replace(/^\\uFEFF/, ''))).toEqual({
      status: 'PASS',
      kind: 'GROK_PHASE2_OFFLINE_PROJECTION_AND_FIXED_COMMAND_TEST',
      grok_invocations: 0,
      model_calls: 0,
      auth_actions: 0,
      acp_sessions: 0,
    });
  });

  it('has exactly the Phase-2 fixed Grok argv allowlist and no model/auth/session command', () => {
    const found = [...source.matchAll(/case Diagnostic\.[A-Za-z]+: return "([^"]+)";/g)]
      .map((match) => match[1]);
    expect(found).toEqual([
      '--no-auto-update version',
      '--no-auto-update agent --help',
      '--no-auto-update agent stdio --help',
      '--no-auto-update inspect --help',
      '--no-auto-update inspect --json',
    ]);
    for (const argv of found) {
      expect(argv).not.toMatch(/(^| )-p( |$)|--single|login|logout|authenticate|session\/new|session\/prompt/i);
    }
    expect(source).toContain('si.UseShellExecute=false');
  });

  it('requires the exact Phase-1 artifact identity and never performs PATH discovery or fallback', () => {
    expect(source).toContain('Phase1CanonicalPath');
    expect(source).toContain('Phase1Sha256');
    expect(source).toContain('Test-IdentityMatch $Phase1CanonicalPath $Phase1Sha256');
    expect(source).toContain("throw 'ARTIFACT_CHANGED'");
    expect(source).toContain('Hash(held),expectedHash');
    expect(source).not.toMatch(/where\\.exe|\\bwhich\\b|Get-Command\\s+grok|env:PATH|GROK_BIN_DIR|\\.grok\\\\bin/);
  });

  it('bounds every physical diagnostic and keeps raw help/inspect only in memory', () => {
    expect(source).toContain('watch.ElapsedMilliseconds<15000');
    expect(source).toContain('sink.Length+n>1048576');
    expect(source).toContain('AssignProcessToJobObject');
    expect(source).toContain("$capture.Out=''");
    expect(source).toContain("$capture.Err=''");
    expect(source).not.toMatch(/Set-Content|Out-File|Start-Transcript|Export-Clixml|ConvertTo-Json[^\\r\\n]*\\$capture\\.Out/);
  });

  it('keeps no-auto-update invocation acceptance separate from semantic guarantee', () => {
    expect(source).toContain('supports_no_auto_update_invocation=$VersionAccepted');
    expect(source).toContain("semantic_guarantee='UNPROVEN'");
    expect(source).not.toContain('advertised_flags');
  });

  it('projects inspect metadata by whitelist and never serializes synthetic secret-bearing fields', () => {
    expect(source).toContain('Get-SanitizedInspectProjection');
    expect(source).toContain("coverage='PARTIAL'");
    expect(source).toContain('unknown_secret_root');
    expect(source).toContain('NEVER_EXPORT_PHASE2_SECRET_7719');
    expect(source).toContain('SELFTEST_SECRET_LEAK');
    expect(source).not.toMatch(/\\$projection\\[['"]headers|\\$projection\\[['"]token|\\$projection\\[['"]environment|\\$projection\\[['"]command/);
  });

  it('treats unknown/missing inspect schema as unknown/partial rather than empty isolation', () => {
    expect(source).toContain("coverage='UNKNOWN'");
    expect(source).toContain("(Get-SanitizedInspectProjection 'not-json').coverage -ne 'UNKNOWN'");
    expect(source).toContain("(Get-SanitizedInspectProjection '{}').mcp.count -ne $null");
    expect(source).not.toMatch(/mcp=\\[ordered\\]@\\{ count=0/);
  });
});

describe('production C2C controller call-site reconciliation', () => {
  const productionSrc = join(root, 'src');
  const tests = join(root, 'test');

  it.each([
    ['launchControlledC2CWorker', ['src/c2c/controller.ts', 'src/orchestration/c2c-launch-controller.ts']],
    ['createAcceptedDispatchIntent', ['src/c2c/controller.ts', 'src/commands/delegation-intent.ts']],
    ['acceptEvaluatedPlan', ['src/c2c/controller.ts', 'src/commands/plan-acceptance.ts']],
    ['durableEvaluateC2CMessage', ['src/c2c/controller.ts', 'src/receipts/c2c-evaluation.ts']],
  ] as const)('%s is called only by the explicit production controller beyond its definition', (name, expected) => {
    // The subsequent controller stage intentionally supersedes Phase-2 NOT WIRED.
    // Probe/auth/isolation tests above remain unchanged; wiring is not certification.
    expect(filesContainingCall(productionSrc, name)).toEqual(expected);
    expect(filesContainingCall(tests, name).length).toBeGreaterThan(0);
  });

  it('does not expose individually callable C2C primitives from CLI/server/tool entrypoints', () => {
    for (const relative of ['src/cli.ts', 'src/index.ts', 'src/server.ts', 'src/tools.ts']) {
      const text = readFileSync(join(root, relative), 'utf8');
      expect(text).not.toMatch(
        /launchControlledC2CWorker\s*\(|createAcceptedDispatchIntent\s*\(|acceptEvaluatedPlan\s*\(|durableEvaluateC2CMessage\s*\(/,
      );
    }
  });
});
