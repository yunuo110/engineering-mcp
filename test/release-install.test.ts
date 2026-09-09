import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { implPayload, initGitRepo, removeDir, serverEntry, spawnEnv, tempDir } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeDir(dir); });

it('uses one ledger with a new relative --db from a different launch cwd, including restart', async () => {
  const repo = initGitRepo();
  const cwd = tempDir('eng-mcp-relative-db-');
  dirs.push(repo, cwd);
  let taskId = '';
  for (const restart of [false, true]) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [serverEntry, '--role', 'owner', '--repo', repo, '--db', 'relative.sqlite'], cwd,
      env: { ...spawnEnv(), ENGINEERING_MCP_CODEX_STUB: '1' }, stderr: 'pipe' });
    const client = new Client({ name: 'release-relative-db', version: '1' });
    await client.connect(transport);
    try {
      if (!restart) {
        const created = await client.callTool({ name: 'create_task', arguments: { type: 'IMPLEMENTATION', payload: implPayload } });
        const task = (created.structuredContent as { task: { id: string; revision: number } }).task;
        taskId = task.id;
        const delegated = await client.callTool({ name: 'delegate_task', arguments: { task_id: task.id, revision: task.revision } });
        expect(delegated.structuredContent).toMatchObject({ ok: true, task: { status: 'COMPLETED' }, dispatch_run: { status: 'completed' } });
      } else {
        const result = await client.callTool({ name: 'get_task', arguments: { task_id: taskId } });
        expect(result.structuredContent).toMatchObject({ ok: true, task: { status: 'COMPLETED' } });
      }
    } finally {
      await client.close();
      await transport.close();
    }
  }
  expect(existsSync(join(cwd, 'relative.sqlite'))).toBe(true);
  expect(existsSync(join(repo, 'relative.sqlite'))).toBe(false);
}, 30_000);
