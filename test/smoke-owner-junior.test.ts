import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  connectStdio,
  extraCommit,
  implPayload,
  implResult,
  initGitRepo,
  makeDirty,
  removeDir,
  tempDir,
} from './helpers.ts';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

describe('stdio OWNER → JUNIOR', () => {
  it('creates, claims, reports, and closes an implementation task', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-smoke-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const owner = await connectStdio('owner', repo, dbPath);
    closers.push(owner.close);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    const createdTask = structured(created).task as { id: string; revision: number; status: string };
    expect(createdTask.status).toBe('READY');

    const junior = await connectStdio('junior', repo, dbPath);
    closers.push(junior.close);
    const claimed = await junior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: createdTask.id, revision: createdTask.revision },
    });
    const claimedTask = structured(claimed).task as { id: string; revision: number; status: string };
    expect(claimedTask.status).toBe('RUNNING');

    const blocked = await junior.client.callTool({
      name: 'report_blocked',
      arguments: {
        task_id: claimedTask.id,
        revision: claimedTask.revision,
        blocker: {
          reason: 'DECISION_REQUIRED',
          summary: 'Need owner input',
          need_from_owner: 'Confirm scope',
          evidence_refs: ['src/store.ts'],
        },
      },
    });
    const blockedTask = structured(blocked).task as { status: string; revision: number; id: string };
    expect(blockedTask.status).toBe('BLOCKED');

    extraCommit(repo, 'owner-fix.txt');
    const resumed = await owner.client.callTool({
      name: 'resume_task',
      arguments: { task_id: blockedTask.id, revision: blockedTask.revision },
    });
    const resumedTask = structured(resumed).task as {
      status: string;
      revision: number;
      id: string;
      assignee_role: string | null;
    };
    expect(resumedTask.status).toBe('READY');
    expect(resumedTask.assignee_role).toBeNull();

    const claimed2 = await junior.client.callTool({
      name: 'claim_task',
      arguments: { task_id: resumedTask.id, revision: resumedTask.revision },
    });
    const running = structured(claimed2).task as { revision: number; id: string };
    const completed = await junior.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: running.id,
        revision: running.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    const done = structured(completed).task as { status: string; revision: number; id: string };
    expect(done.status).toBe('COMPLETED');

    const closed = await owner.client.callTool({
      name: 'close_task',
      arguments: { task_id: done.id, revision: done.revision, decision: 'integrated' },
    });
    expect(structured(closed).ok).toBe(true);
    expect((structured(closed).task as { status: string }).status).toBe('CLOSED');
  });

  it('refuses a dirty create_task over stdio', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-smoke-dirty-');
    dirs.push(repo, dbDir);
    makeDirty(repo);
    const owner = await connectStdio('owner', repo, join(dbDir, 'ledger.sqlite'));
    closers.push(owner.close);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: { type: 'IMPLEMENTATION', payload: implPayload },
    });
    expect(created.isError).toBe(true);
    expect((structured(created).error as { code: string }).code).toBe('DIRTY_WORKTREE');
  });
});
