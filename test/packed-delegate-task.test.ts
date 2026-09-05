import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function initGitRepo(): string {
  const repo = tempDir('eng-mcp-packed-repo-');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'packed-test@example.com']);
  git(repo, ['config', 'user.name', 'Packed Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), 'packed test\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 180_000, shell = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function npmRun(args: string[], cwd: string, timeoutMs = 240_000) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], cwd, timeoutMs);
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npmCommand, args, cwd, timeoutMs, process.platform === 'win32');
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  if (result.structuredContent === undefined || typeof result.structuredContent !== 'object') {
    throw new Error('expected structuredContent object');
  }
  return result.structuredContent as Record<string, unknown>;
}

describe('packed public artifact delegation regression', () => {
  it('packs, installs, initializes MCP, creates task, delegates to packaged Worker Runner, and completes', async () => {
    const packDir = tempDir('eng-mcp-pack-');
    const pack = npmRun(['pack', '--json', '--pack-destination', packDir], projectRoot);
    const packOutput = JSON.parse(pack.stdout.trim()) as Array<{ filename: string }>;
    const tarballName = packOutput[0]?.filename;
    expect(tarballName).toBeTruthy();
    const tarballPath = join(packDir, tarballName!);

    const installDir = tempDir('eng-mcp-install-');
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'packed-consumer', private: true }));
    npmRun(['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', tarballPath], installDir);
    const installedCli = join(installDir, 'node_modules', 'engineering-mcp-cli', 'dist', 'cli.js');

    const repo = initGitRepo();

    const packedHelp = run(process.execPath, [installedCli, '--help'], installDir);
    expect(packedHelp.stdout).toContain('safety-first control plane');

    const packedDoctor = run(process.execPath, [installedCli, 'doctor'], repo);
    expect(packedDoctor.stdout).toContain('"node"');
    expect(packedDoctor.stdout).toContain('"repository"');

    const dbDir = tempDir('eng-mcp-packed-db-');
    const dbPath = join(dbDir, 'ledger.sqlite');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [installedCli, '--role', 'owner', '--repo', repo, '--db', dbPath],
      cwd: repo,
      env: {
        ...(process.env as Record<string, string>),
        ENGINEERING_MCP_CODEX_STUB: '1',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'packed-delegate-test', version: '0.0.0' });
    await client.connect(transport);

    try {
      // MCP initialize handshake.
      expect(client.getServerVersion()).toBeTruthy();

      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toContain('create_task');
      expect(toolNames).toContain('delegate_task');

      const created = await client.callTool({
        name: 'create_task',
        arguments: {
          type: 'IMPLEMENTATION',
          payload: {
            goal: 'Create no files; stub Codex adapter completes deterministically',
            parent_intent: 'packed public artifact regression',
            allowed_scope: ['README.md'],
            forbidden_scope: [],
            acceptance_criteria: [],
            validation_requirements: [],
            context_files: ['README.md'],
            knowledge_refs: [],
            parent_risk: 'L1',
          },
        },
      });
      expect(created.isError).toBeFalsy();
      const createdBody = structured(created);
      expect(createdBody.ok).toBe(true);
      const createdTask = createdBody.task as { id: string; revision: number; status: string };
      expect(createdTask.status).toBe('READY');

      const delegated = await client.callTool({
        name: 'delegate_task',
        arguments: { task_id: createdTask.id, revision: createdTask.revision },
      });
      expect(delegated.isError).toBeFalsy();
      const delegatedBody = structured(delegated);
      expect(delegatedBody.ok).toBe(true);
      const dispatchRun = delegatedBody.dispatch_run as { status: string; adapter_id: string; pid: number | null };
      const terminalTask = delegatedBody.task as { status: string; id: string };
      expect(dispatchRun.status).toBe('completed');
      expect(dispatchRun.adapter_id).toBe('codex-exec-luna');
      expect(terminalTask.status).toBe('COMPLETED');
      expect(delegatedBody.still_running).toBeUndefined();

      const text = delegated.content?.[0] && 'text' in delegated.content[0] ? delegated.content[0].text : '';
      expect(text).toContain('Dispatch Status: completed');
      expect(text).toContain('Task Status: COMPLETED');
    } finally {
      await client.close();
      await transport.close();
    }
  }, 300_000);
});
