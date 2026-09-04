import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  connectStdio,
  implPayload,
  implResult,
  initGitRepo,
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

async function createOwner(repo: string, dbPath: string) {
  const owner = await connectStdio('owner', repo, dbPath);
  closers.push(owner.close);
  return owner;
}

async function createJunior(repo: string, dbPath: string) {
  const junior = await connectStdio('junior', repo, dbPath);
  closers.push(junior.close);
  return junior;
}

type TaskLike = {
  id: string;
  revision: number;
  status: string;
  execution_instance_id: string | null;
};

async function ownerCreate(
  repo: string,
  dbPath: string,
  owner: Awaited<ReturnType<typeof createOwner>>,
) {
  const created = await owner.client.callTool({
    name: 'create_task',
    arguments: { type: 'IMPLEMENTATION', payload: implPayload },
  });
  return structured(created).task as TaskLike;
}

async function ownerCreateMany(
  repo: string,
  dbPath: string,
  owner: Awaited<ReturnType<typeof createOwner>>,
  count: number,
) {
  const tasks: TaskLike[] = [];
  for (let i = 0; i < count; i++) {
    tasks.push(await ownerCreate(repo, dbPath, owner));
  }
  return tasks;
}

describe('V1.5.1 multi-process execution ownership', () => {
  it('does not let a second same-role process recover or mutate a live RUNNING task', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v151-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const owner = await createOwner(repo, dbPath);
    const created = await ownerCreate(repo, dbPath, owner);

    const juniorA = await createJunior(repo, dbPath);
    const claimedA = await juniorA.client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, revision: created.revision },
    });
    const runningA = structured(claimedA).task as TaskLike;
    expect(runningA.status).toBe('RUNNING');
    expect(runningA.execution_instance_id).toBeTruthy();

    const juniorB = await createJunior(repo, dbPath);
    const readByB = await juniorB.client.callTool({
      name: 'get_task',
      arguments: { task_id: runningA.id },
    });
    const taskSeenByB = structured(readByB).task as TaskLike;
    expect(taskSeenByB.status).toBe('RUNNING');
    expect(taskSeenByB.execution_instance_id).toBe(runningA.execution_instance_id);
    expect(taskSeenByB.revision).toBe(runningA.revision);

    const blockedAttempt = await juniorB.client.callTool({
      name: 'report_blocked',
      arguments: {
        task_id: runningA.id,
        revision: runningA.revision,
        blocker: {
          reason: 'DECISION_REQUIRED',
          summary: 'B should not be able to block A task',
          need_from_owner: 'none',
          evidence_refs: [],
        },
      },
    });
    expect(blockedAttempt.isError).toBe(true);
    expect((structured(blockedAttempt).error as { code: string }).code).toBe('EXECUTION_OWNER_MISMATCH');

    const resultAttempt = await juniorB.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: runningA.id,
        revision: runningA.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(resultAttempt.isError).toBe(true);
    expect((structured(resultAttempt).error as { code: string }).code).toBe('EXECUTION_OWNER_MISMATCH');

    const stillRunning = await juniorA.client.callTool({
      name: 'get_task',
      arguments: { task_id: runningA.id },
    });
    expect((structured(stillRunning).task as TaskLike).status).toBe('RUNNING');

    const completedByA = await juniorA.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: runningA.id,
        revision: runningA.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(completedByA.isError).toBeFalsy();
    expect((structured(completedByA).task as TaskLike).status).toBe('COMPLETED');
  });

  it('supports explicit OWNER recovery and rejects old execution after recovery', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v151-rec-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const owner = await createOwner(repo, dbPath);
    const created = await ownerCreate(repo, dbPath, owner);
    const juniorA = await createJunior(repo, dbPath);
    const claimed = await juniorA.client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, revision: created.revision },
    });
    const running = structured(claimed).task as TaskLike;

    const recovered = await owner.client.callTool({
      name: 'recover_task',
      arguments: { task_id: running.id, revision: running.revision },
    });
    const recoveredTask = structured(recovered).task as TaskLike & {
      blocker: {
        reason: string;
        recovery?: {
          reason: string;
          retry_safe: boolean;
          prior_execution_instance_id?: string;
        };
      };
    };
    expect(recoveredTask.status).toBe('BLOCKED');
    expect(recoveredTask.execution_instance_id).toBeNull();
    expect(recoveredTask.blocker.reason).toBe('CONTEXT_STALE');
    expect(recoveredTask.blocker.recovery?.reason).toBe('EXPLICIT_OWNER_RECOVERY');
    expect(recoveredTask.blocker.recovery?.retry_safe).toBe(false);
    expect(recoveredTask.blocker.recovery?.prior_execution_instance_id).toBe(running.execution_instance_id);

    const lateAttempt = await juniorA.client.callTool({
      name: 'report_result',
      arguments: {
        task_id: running.id,
        revision: running.revision,
        outcome: 'completed',
        result: implResult,
      },
    });
    expect(lateAttempt.isError).toBe(true);
    expect((structured(lateAttempt).error as { code: string }).code).toBe('REVISION_MISMATCH');
  });

  it('rejects an OWNER recovery when the revision is stale', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v151-rev-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const owner = await createOwner(repo, dbPath);
    const created = await ownerCreate(repo, dbPath, owner);
    const juniorA = await createJunior(repo, dbPath);
    const claimed = await juniorA.client.callTool({
      name: 'claim_task',
      arguments: { task_id: created.id, revision: created.revision },
    });
    const running = structured(claimed).task as TaskLike;

    const blockedByA = await juniorA.client.callTool({
      name: 'report_blocked',
      arguments: {
        task_id: running.id,
        revision: running.revision,
        blocker: {
          reason: 'DECISION_REQUIRED',
          summary: 'A blocked after owner read revision',
          need_from_owner: 'review',
          evidence_refs: [],
        },
      },
    });
    const blocked = structured(blockedByA).task as TaskLike;

    const staleRecovery = await owner.client.callTool({
      name: 'recover_task',
      arguments: { task_id: running.id, revision: running.revision },
    });
    expect(staleRecovery.isError).toBe(true);
    expect((structured(staleRecovery).error as { code: string }).code).toBe('REVISION_MISMATCH');

    const taskAfter = await owner.client.callTool({
      name: 'get_task',
      arguments: { task_id: running.id },
    });
    const after = structured(taskAfter).task as TaskLike;
    expect(after.status).toBe('BLOCKED');
    expect(after.revision).toBe(blocked.revision);
  });

  it('keeps one RUNNING task across two worker processes', async () => {
    const repo = initGitRepo();
    const dbDir = tempDir('eng-mcp-v151-one-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repo, dbDir);

    const owner = await createOwner(repo, dbPath);
    const tasks = await ownerCreateMany(repo, dbPath, owner, 2);
    const juniorA = await createJunior(repo, dbPath);
    const juniorB = await createJunior(repo, dbPath);

    const firstClaim = await juniorA.client.callTool({
      name: 'claim_next_task',
      arguments: {},
    });
    expect(firstClaim.isError).toBeFalsy();
    const first = structured(firstClaim).task as TaskLike;
    expect(first.status).toBe('RUNNING');

    const secondClaim = await juniorB.client.callTool({
      name: 'claim_next_task',
      arguments: {},
    });
    expect(secondClaim.isError).toBe(true);
    expect((structured(secondClaim).error as { code: string }).code).toBe('TASK_ALREADY_RUNNING');
    expect(tasks.length).toBe(2);
  });

  it('fails closed when repo B attempts to open a ledger bound to repo A', async () => {
    const repoA = initGitRepo();
    const repoB = initGitRepo();
    const dbDir = tempDir('eng-mcp-v151-cross-');
    const dbPath = join(dbDir, 'ledger.sqlite');
    dirs.push(repoA, repoB, dbDir);

    const owner = await createOwner(repoA, dbPath);
    await ownerCreate(repoA, dbPath, owner);

    try {
      const bad = await connectStdio('junior', repoB, dbPath);
      await bad.close();
      expect.fail('expected cross-repository ledger open to fail');
    } catch {
      // The stdio server process exits at startup and the client connection closes.
    }
  });
});
