import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { OWNER_TOOLS } from '../src/role.ts';
import { dispatchRunDir } from '../src/dispatch-run-dir.ts';
import { executeC2CPlanOutputSchema } from '../src/c2c/controller.ts';
import {
  C2C_PRIVATE_OPERATION,
  C2C_PRIVATE_TRANSPORT,
  C2C_PROTOCOL_VERSION,
} from '../src/c2c/schema.ts';
import { projectRoot, tempDir, spawnEnv } from './helpers.ts';
import { controllerFixture } from './fixtures/c2c-controller-support.ts';
import { waitFor, executionCount } from './fixtures/c2c-generic-support.ts';

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

async function connectPrivate(f: ReturnType<typeof fixture>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      'c2c-client',
      '--contract-version',
      C2C_PROTOCOL_VERSION,
      '--repo',
      f.repo,
      '--db',
      f.store.path,
      '--worker-profiles',
      f.profilesPath,
    ],
    cwd: projectRoot,
    env: { ...spawnEnv(), TEST_CONTROLLER_SECRET: 'DO_NOT_LOG_ENVIRONMENT' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'c2c-private-client-test', version: '0.0.0' });
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

describe('public CLI and production stdio controller', () => {
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

  it('provides a Core-owned private stdio client with exactly one tool', async () => {
    const f = fixture();
    const c = await connectPrivate(f);
    expect((await c.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      C2C_PRIVATE_OPERATION,
    ]);
    await expect(
      c.client.callTool({ name: 'create_task', arguments: {} }),
    ).rejects.toThrow('Tool create_task not found');
    await waitFor(() => c.log().includes('c2c_private_client_enabled'));
    const line = c.log().split(/\r?\n/).find((value) =>
      value.startsWith('{') && value.includes('c2c_private_client_enabled'))!;
    expect(JSON.parse(line)).toEqual({
      event: 'c2c_private_client_enabled',
      pid: expect.any(Number),
      username: expect.any(String),
      role: 'OWNER',
      repo_root: f.repo,
      contract_version: C2C_PROTOCOL_VERSION,
      transport: C2C_PRIVATE_TRANSPORT,
      tool: C2C_PRIVATE_OPERATION,
      tool_count: 1,
    });
    expect(c.log()).not.toContain('DO_NOT_LOG_ENVIRONMENT');
  });

  it.skipIf(process.platform !== 'win32')('runs a real CLI -> server -> controller -> native worker without any production test hook', async () => {
    const f = fixture(); const c = await connect(f, true);
    expect((await c.client.listTools()).tools.map((t) => t.name).sort()).toEqual([...OWNER_TOOLS, 'execute_c2c_plan'].sort());
    await waitFor(() => c.log().includes('c2c_controller_enabled'));
    const line = c.log().split(/\r?\n/).find((v) => v.startsWith('{') && v.includes('c2c_controller_enabled'))!;
    const identity = JSON.parse(line);
    expect(identity).toEqual({ event: 'c2c_controller_enabled', pid: expect.any(Number), username: expect.any(String), role: 'OWNER', repo_root: f.repo, tool: 'execute_c2c_plan' });
    expect(identity.pid).toBeGreaterThan(0);
    expect(c.log()).not.toContain('DO_NOT_LOG_ENVIRONMENT');
    const call = await c.client.callTool({ name: 'execute_c2c_plan', arguments: f.request });
    expect(call.isError).toBeFalsy();
    const result = executeC2CPlanOutputSchema.parse(call.structuredContent);
    expect(result.ok).toBe(true);
    await waitFor(() => f.store.getTask(f.task.id)?.status === 'COMPLETED');
    const receipt = f.store.getC2CDelegationIntentReceipt(f.request.delegation_command_id)!;
    expect(result.delegation?.dispatch_run_id).toBe(receipt.dispatch_run_id);
    expect(executionCount(dispatchRunDir(receipt.dispatch_run_id))).toBe(1);
    expect(f.store.listEvents(f.task.id).filter((e) => e.kind === 'claimed')).toHaveLength(1);
    expect(readFileSync(join(f.repo, 'README.md'), 'utf8')).toBe('native harness edit\n');
    const replay = await c.client.callTool({ name: 'execute_c2c_plan', arguments: f.request });
    expect(replay.structuredContent).toMatchObject({ ok: true, launch: { state: 'TERMINAL', physical_spawn_requested: false } });
    expect(executionCount(dispatchRunDir(receipt.dispatch_run_id))).toBe(1);
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
