import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], options: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
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
