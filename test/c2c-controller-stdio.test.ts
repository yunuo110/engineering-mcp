import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { OWNER_TOOLS } from '../src/role.ts';
import { dispatchRunDir } from '../src/dispatch-run-dir.ts';
import { C2C_PROTOCOL_VERSION } from '../src/c2c/schema.ts';
import { projectRoot, tempDir, spawnEnv } from './helpers.ts';
import { controllerFixture } from './fixtures/c2c-controller-support.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const fixtures: ReturnType<typeof controllerFixture>[] = [];
const connections: Array<{ client: Client; transport: StdioClientTransport }> = [];
const cli = join(projectRoot, 'src/cli.ts');
const index = join(projectRoot, 'src/index.ts');
function fixture() { const f = controllerFixture(dirs, stores); fixtures.push(f); return f; }

async function connect(f: ReturnType<typeof fixture>, enabled: boolean) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--role', 'owner', '--repo', f.repo, '--db', f.store.path,
      '--worker-profiles', f.profilesPath, ...(enabled ? ['--enable-c2c-controller'] : [])],
    cwd: projectRoot,
    // An environment variable must NOT silently opt a process into controller mode.
    env: { ...spawnEnv(), ENGINEERING_MCP_ENABLE_C2C_CONTROLLER: '1', TEST_CONTROLLER_SECRET: 'DO_NOT_LOG_ENVIRONMENT' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'controller-production-stdio', version: '0.0.0' });
  connections.push({ client, transport });
  await client.connect(transport);
  return { client, log: () => stderr };
}

afterEach(async () => {
  for (const { client, transport } of connections.splice(0)) { await client.close(); await transport.close(); }
  // Live subprocess E2E finishes its terminal transition just before releasing cwd.
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const f of fixtures.splice(0)) for (const run of f.store.listDispatchRunsForTask(f.task.id)) dirs.push(dispatchRunDir(run.id));
  for (const s of stores.splice(0)) s.close();
  for (const d of new Set(dirs.splice(0))) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
});

describe('public CLI and protected source-checkout refusal', () => {
  it.each(['junior', 'principal'])('refuses %s opt-in at both entrypoints before opening a ledger', (role) => {
    const assets = tempDir('eng-mcp-controller-cli-'); dirs.push(assets);
    for (const entry of [cli, index]) {
      const db = join(assets, 'must-not-open.sqlite');
      const result = spawnSync(process.execPath, [entry, '--role', role, '--enable-c2c-controller', '--repo', join(assets, 'absent'), '--db', db], {
        cwd: projectRoot, encoding: 'utf8', input: '', timeout: 10000, windowsHide: true,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/requires.*--role owner/);
      expect(result.stdout).toBe('');
      expect(existsSync(db)).toBe(false);
    }
  });

  it('does not silently ignore opt-in on utility commands, duplicate flags, or flag values', () => {
    for (const args of [
      ['setup', '--enable-c2c-controller'],
      ['doctor', '--enable-c2c-controller'],
      ['--role', 'owner', '--enable-c2c-controller', '--enable-c2c-controller'],
      ['--role', 'owner', '--enable-c2c-controller=false'],
      ['--role', 'junior', '--enable-c2c-controller', '--help'],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: projectRoot, input: '', encoding: 'utf8', timeout: 10000, windowsHide: true });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--enable-c2c-controller');
    }
  });

  it('keeps normal OWNER surface unchanged despite profiles and an opt-in-looking environment variable', async () => {
    const f = fixture(); const c = await connect(f, false);
    expect((await c.client.listTools()).tools.map((t) => t.name).sort()).toEqual([...OWNER_TOOLS].sort());
    expect(c.log()).not.toContain('c2c_controller_enabled');
  });

  it('fails closed on a mismatched private contract before repository or ledger access', () => {
    const assets = tempDir('eng-mcp-private-contract-'); dirs.push(assets);
    const db = join(assets, 'must-not-open.sqlite');
    const result = spawnSync(process.execPath, [
      cli,
      'c2c-client',
      '--contract-version',
      'engineering-c2c/999',
      '--repo',
      join(assets, 'absent'),
      '--db',
      db,
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: '',
      timeout: 10000,
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `--contract-version must be ${C2C_PROTOCOL_VERSION}`,
    );
    expect(result.stdout).toBe('');
    expect(existsSync(db)).toBe(false);
  });

  it.each([
    ['private', ['c2c-client', '--contract-version', C2C_PROTOCOL_VERSION]],
    ['controller', ['--role', 'owner', '--enable-c2c-controller']],
  ] as const)('refuses %s protected entry from an unstaged source checkout before ledger open', (_mode, prefix) => {
    const assets = tempDir('eng-mcp-protected-source-refusal-'); dirs.push(assets);
    const db = join(assets, 'must-not-open.sqlite');
    const result = spawnSync(process.execPath, [cli, ...prefix, '--repo', assets, '--db', db], {
      cwd: projectRoot, encoding: 'utf8', input: '', timeout: 10000, windowsHide: true,
      env: { ...spawnEnv(), TEST_CONTROLLER_SECRET: 'DO_NOT_LOG_ENVIRONMENT' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/TRUSTED_RUNTIME|protected|manifest/i);
    expect(result.stderr).not.toContain('DO_NOT_LOG_ENVIRONMENT');
    expect(result.stdout).toBe('');
    expect(existsSync(db)).toBe(false);
  });

  it('does not add opt-in to existing host snippets or Safe Configure output code', () => {
    const result = spawnSync(process.execPath, [cli, 'setup'], { cwd: projectRoot, encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('--enable-c2c-controller');
    for (const path of ['src/configure.ts', 'examples/hosts/grok/grok-config.example.toml', 'examples/hosts/codex/codex-config.example.toml']) {
      expect(readFileSync(join(projectRoot, path), 'utf8')).not.toContain('--enable-c2c-controller');
    }
  });
});
