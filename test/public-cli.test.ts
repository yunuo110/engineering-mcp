import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { initGitRepo } from './helpers.ts';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: 10_000,
  });
}

function validManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-test-'));
  tempDirs.push(dir);
  const manifestPath = join(dir, 'manifest.yaml');
  writeFileSync(
    manifestPath,
    `schema: engineering-cli-adapter/1
id: test-harness
name: Test Harness
adapter: generic-cli
command: does-not-exist-for-validate
arguments:
  - "--task-id"
  - "\${task_id}"
working_directory: "\${repo_root}"
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes: [0]
protocol_mode: native
`,
    'utf8',
  );
  return manifestPath;
}

describe('public CLI', () => {
  it('prints help without invoking models', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('safety-first control plane');
    expect(result.stdout).toContain('adapter validate');
    expect(result.stdout).toContain('configure --host codex|grok');
  });

  it('configure previews by default and applies only with --apply', () => {
    const repo = initGitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-configure-'));
    const config = join(dir, 'config.toml');
    tempDirs.push(repo, dir);
    mkdirSync(dir, { recursive: true });

    const preview = runCli(['configure', '--host', 'codex', '--repo', repo, '--config', config], { cwd: repo });
    expect(preview.status).toBe(0);
    const previewReport = JSON.parse(preview.stdout) as {
      mode: string;
      mutated: boolean;
      plan_identity: string;
      trust_model: string;
      plan: { intended_entry: { args: string[] }; verification: { doctor_command: string } };
    };
    expect(previewReport).toMatchObject({ mode: 'PREVIEW', mutated: false });
    expect(previewReport.plan_identity).toMatch(/^ecp2\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(previewReport.trust_model).toContain('not an authorization credential');
    expect(previewReport.plan.intended_entry.args).toEqual(['--role', 'owner', '--repo', repo]);
    expect(previewReport.plan.verification.doctor_command).toContain('engineering-mcp doctor --repo');
    expect(existsSync(config)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);

    const applied = runCli(['configure', '--apply', '--plan', previewReport.plan_identity], { cwd: repo });
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ mode: 'APPLIED', changed: true });
    expect(readFileSync(config, 'utf8')).toContain('[mcp_servers.engineering-mcp]');

    const replay = runCli(['configure', '--apply', '--plan', previewReport.plan_identity], { cwd: repo });
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ mode: 'ALREADY_APPLIED', changed: false });

    const afterReplayEdit = Buffer.from('setting = "after replay"\n', 'utf8');
    writeFileSync(config, afterReplayEdit);
    const invalidReplay = runCli(['configure', '--apply', '--plan', previewReport.plan_identity], { cwd: repo });
    expect(invalidReplay.status).toBe(1);
    expect(JSON.parse(invalidReplay.stderr)).toMatchObject({
      ok: false,
      error: { code: 'CONFIGURE_MANUAL_RECOVERY_REQUIRED' },
    });
    expect(readFileSync(config)).toEqual(afterReplayEdit);
  });

  it('rejects a stale public preview identity after an external edit and preserves that edit', () => {
    const repo = initGitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-plan-stale-'));
    const config = join(dir, 'config.toml');
    tempDirs.push(repo, dir);
    writeFileSync(config, 'setting = "previewed"\n');
    const preview = runCli(['configure', '--host', 'codex', '--repo', repo, '--config', config], { cwd: repo });
    const identity = (JSON.parse(preview.stdout) as { plan_identity: string }).plan_identity;
    const external = Buffer.from('setting = "external"\n', 'utf8');
    writeFileSync(config, external);

    const applied = runCli(['configure', '--apply', '--plan', identity], { cwd: repo });
    expect(applied.status).toBe(1);
    expect(JSON.parse(applied.stderr)).toMatchObject({
      ok: false,
      error: { code: 'CONFIGURE_PLAN_INVALIDATED' },
    });
    expect(readFileSync(config)).toEqual(external);
  });

  it('rejects plan assertions for the wrong host, repository, or target', () => {
    const repo = initGitRepo();
    const otherRepo = initGitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-plan-context-'));
    const config = join(dir, 'config.toml');
    const otherConfig = join(dir, 'other.toml');
    tempDirs.push(repo, otherRepo, dir);
    const preview = runCli(['configure', '--host', 'codex', '--repo', repo, '--config', config], { cwd: repo });
    const identity = (JSON.parse(preview.stdout) as { plan_identity: string }).plan_identity;

    for (const assertion of [
      ['--host', 'grok'],
      ['--repo', otherRepo],
      ['--config', otherConfig],
      ['--command', 'other-command'],
    ]) {
      const result = runCli(['configure', '--apply', '--plan', identity, ...assertion], { cwd: repo });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code: 'CONFIGURE_PLAN_INVALIDATED' },
      });
      expect(existsSync(config)).toBe(false);
    }
  });

  it('requires a preview plan identity for public apply', () => {
    const result = runCli(['configure', '--apply', '--host', 'codex']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'CONFIGURE_PLAN_REQUIRED' },
    });
  });

  it('rejects a forged public plan identity', () => {
    const repo = initGitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-plan-forged-'));
    const config = join(dir, 'config.toml');
    tempDirs.push(repo, dir);
    const preview = runCli(['configure', '--host', 'codex', '--repo', repo, '--config', config], { cwd: repo });
    const identity = (JSON.parse(preview.stdout) as { plan_identity: string }).plan_identity;
    const forged = `${identity.slice(0, -1)}${identity.endsWith('0') ? '1' : '0'}`;

    const result = runCli(['configure', '--apply', '--plan', forged], { cwd: repo });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'CONFIGURE_PLAN_INVALID' },
    });
    expect(existsSync(config)).toBe(false);
  });

  it('configure reports malformed configuration as a structured fail-closed error', () => {
    const repo = initGitRepo();
    const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-configure-invalid-'));
    const config = join(dir, 'config.toml');
    tempDirs.push(repo, dir);
    writeFileSync(config, '[broken\n');

    const result = runCli(['configure', '--host', 'grok', '--repo', repo, '--config', config], { cwd: repo });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'CONFIGURE_MALFORMED' },
    });
    expect(readFileSync(config, 'utf8')).toBe('[broken\n');
  });

  it('routes configure options before generic server role detection', () => {
    const result = runCli(['configure', '--host', 'codex', '--role', 'unsupported']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'CONFIGURE_USAGE', message: 'Unknown configure option: --role' },
    });
  });

  it('setup previews snippets and writes no files', () => {
    const result = runCli(['setup']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No configuration files were written');
    expect(result.stdout).toContain('engineering-mcp --role owner');
    expect(result.stdout).toContain('[mcp_servers.engineering-mcp]');
  });

  it('doctor reports local environment without dumping environment secrets', () => {
    const result = runCli(['doctor']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"node"');
    expect(result.stdout).toContain('"repository"');
    expect(result.stdout).not.toContain('process.env');
    expect(result.stdout.toLowerCase()).not.toContain('api_key');
    expect(result.stdout.toLowerCase()).not.toContain('bearer ');
  });

  it('adapter validate accepts a valid manifest', () => {
    const manifestPath = validManifest();
    const result = runCli(['adapter', 'validate', manifestPath]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('adapter validate rejects an invalid manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eng-mcp-cli-invalid-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'invalid.yaml');
    writeFileSync(
      manifestPath,
      `schema: engineering-cli-adapter/1
id: bad
name: Bad
adapter: generic-cli
command: my-harness
arguments: ["\${task_body}"]
working_directory: "\${repo_root}"
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes: [0]
`,
      'utf8',
    );
    const result = runCli(['adapter', 'validate', manifestPath]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join('\n')).toContain('unsafe variable');
  });
});
