import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  implPayload,
  implResult,
  initGitRepo,
  removeDir,
  projectRoot,
  spawnEnv,
  tempDir,
} from './helpers.ts';
import { Store } from '../src/store.ts';
import { DomainError } from '../src/errors.ts';
import type { ProcessRole } from '../src/types.ts';

const LEGACY_COMMIT = '6b38cf4';
const dirs: string[] = [];
const legacyDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const dir of legacyDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

function materializeLegacyV1(): string {
  const dir = mkdtempSync(join(projectRoot, '.legacy-v1-'));
  legacyDirs.push(dir);
  const tarPath = join(dir, 'legacy.tar');
  const tar = execFileSync('git', ['archive', '--format=tar', LEGACY_COMMIT, 'src'], {
    encoding: 'buffer',
  });
  writeFileSync(tarPath, tar);
  execFileSync('tar', ['--force-local', '-x', '-C', dir, '-f', tarPath]);
  return dir;
}

async function connectLegacyStdio(
  processRole: ProcessRole,
  repoPath: string,
  dbPath: string,
  legacySrcDir: string,
): Promise<{ client: Client; transport: StdioClientTransport; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(legacySrcDir, 'src', 'index.ts'), '--role', processRole, '--repo', repoPath, '--db', dbPath],
    cwd: projectRoot,
    env: spawnEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'legacy-v1-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

function taskText(result: CallToolResult): string {
  const body = structured(result);
  if (body.ok === false) {
    const error = body.error as { code: string; message: string };
    return `${error.code}: ${error.message}`;
  }
  return JSON.stringify(body.task);
}

describe('V1.5.2 mixed-version legacy writer fencing', () => {
  it('fences legacy claim after migration when a legacy process remains alive', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v152-legacy-claim-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };
    expect(createdTask.id).toBeTruthy();

    const legacyJunior = await connectLegacyStdio('junior', repo, dbPath, legacySrc);
    closers.push(legacyJunior.close);

    const migrated = Store.open(dbPath, { repoRoot: repo });
    migrated.close();

    const claimAttempt = await legacyJunior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimAttempt.isError).toBe(true);
    expect(taskText(claimAttempt)).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

    const current = Store.open(dbPath, { repoRoot: repo });
    const after = current.getTask(createdTask.id);
    expect(after?.status).toBe('READY');
    expect(after?.execution_instance_id).toBeNull();
    current.close();
  });

  it('fences legacy report_result and report_blocked against a V2-owned task', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v152-legacy-report-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const legacyJunior = await connectLegacyStdio('junior', repo, dbPath, legacySrc);
    closers.push(legacyJunior.close);

    const current = Store.open(dbPath, { repoRoot: repo });
    const ready = current.getTask(createdTask.id);
    expect(ready?.status).toBe('READY');
    const running = current.transact(() => {
      const task = current.getTask(createdTask.id);
      if (!task) throw new Error('missing task');
      const next = {
        ...task,
        status: 'RUNNING' as const,
        assignee_role: 'JUNIOR' as const,
        execution_instance_id: 'v152-owner',
        revision: task.revision + 1,
      };
      current.updateTask(next);
      return next;
    });
    expect(running.status).toBe('RUNNING');

    const reportResultAttempt = await legacyJunior.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: createdTask.id,
        revision: running.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(reportResultAttempt.isError).toBe(true);
    expect(taskText(reportResultAttempt)).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

    const reportBlockedAttempt = await legacyJunior.client.callTool({
      name: 'report_blocked',
      arguments: {
        task_id: createdTask.id,
        revision: running.revision,
        blocker: {
          reason: 'DECISION_REQUIRED',
          summary: 'legacy blocked attempt',
          need_from_owner: 'none',
          evidence_refs: [],
        },
      },
    });
    expect(reportBlockedAttempt.isError).toBe(true);
    expect(taskText(reportBlockedAttempt)).toContain('EXECUTION_STATE_INVARIANT_VIOLATION');

    const after = current.getTask(createdTask.id);
    expect(after?.status).toBe('RUNNING');
    expect(after?.execution_instance_id).toBe('v152-owner');

    const completed = current.transact(() => {
      const task = current.getTask(createdTask.id);
      if (!task) throw new Error('missing task');
      const next = {
        ...task,
        status: 'COMPLETED' as const,
        execution_instance_id: null,
        result: implResult,
        revision: task.revision + 1,
      };
      current.updateTask(next);
      return next;
    });
    expect(completed.status).toBe('COMPLETED');
    current.close();
  });

  it('refuses migration while a legacy RUNNING task exists', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v152-legacy-running-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);
    const legacySrc = materializeLegacyV1();

    const legacyOwner = await connectLegacyStdio('owner', repo, dbPath, legacySrc);
    closers.push(legacyOwner.close);
    const created = await legacyOwner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number };

    const legacyJunior = await connectLegacyStdio('junior', repo, dbPath, legacySrc);
    closers.push(legacyJunior.close);
    const claimed = await legacyJunior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    expect(claimed.isError).toBeFalsy();

    try {
      Store.open(dbPath, { repoRoot: repo });
      expect.fail('expected legacy running migration refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('LEGACY_RUNNING_TASK_PREVENTS_MIGRATION');
    }
  });
});
