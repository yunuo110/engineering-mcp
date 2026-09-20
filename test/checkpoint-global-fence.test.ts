import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.ts';
import { planGitCheckpoint } from '../src/git.ts';
import {
  cancelTask,
  checkpointTask,
  claimNextTask,
  claimTask,
  closeTask,
  createDiagnosisFromCheckpoint,
  createTask,
  recoverTask,
  reportBlocked,
  reportResult,
  resumeTask,
  type CheckpointFailureStage,
} from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import { Store } from '../src/store.ts';
import { WRITER_PROTOCOL_GENERATION, type CheckpointIntent, type DispatchRun, type TaskContract } from '../src/types.ts';
import { diagnosisPayload, git, implPayload, implResult, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function openFixture() {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  dirs.push(opened.dir);
  stores.push(opened.store);
  return { repo, store: opened.store };
}

function payloadFor(file: string) {
  return { ...implPayload, allowed_scope: [file], forbidden_scope: [], context_files: [] };
}

function createBlocked(store: Store, repo: string, file: string, execution: string): TaskContract {
  const created = createTask(store, snapshot(repo), { type: 'IMPLEMENTATION', payload: payloadFor(file) });
  const running = claimTask(store, snapshot(repo), 'JUNIOR', execution, created.id, created.revision);
  return reportBlocked(store, 'JUNIOR', execution, {
    task_id: running.id,
    revision: running.revision,
    blocker: { reason: 'OTHER', summary: 'blocked', need_from_owner: 'checkpoint', evidence_refs: [] },
  });
}

function createTwoTaskCheckpointFailure(stage: CheckpointFailureStage) {
  const fixture = openFixture();
  const producer = createTask(fixture.store, snapshot(fixture.repo), {
    type: 'IMPLEMENTATION',
    payload: payloadFor('output-a.txt'),
  });
  const other = createTask(fixture.store, snapshot(fixture.repo), {
    type: 'IMPLEMENTATION',
    payload: payloadFor('output-b.txt'),
  });
  const running = claimTask(fixture.store, snapshot(fixture.repo), 'JUNIOR', 'producer', producer.id, producer.revision);
  writeFileSync(join(fixture.repo, 'output-a.txt'), 'valuable output\n');
  const blocked = reportBlocked(fixture.store, 'JUNIOR', 'producer', {
    task_id: running.id,
    revision: running.revision,
    blocker: {
      reason: 'VALIDATION_ENVIRONMENT',
      summary: 'environment blocked',
      need_from_owner: 'checkpoint',
      evidence_refs: [],
      changed_files: ['output-a.txt'],
    },
  });
  const request = { task_id: blocked.id, revision: blocked.revision, purpose: 'RESUME' as const };
  expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), request, {
    onStage(current) { if (current === stage) throw new Error(`stop:${stage}`); },
  })).toThrow(`stop:${stage}`);
  return { ...fixture, producer: blocked, other, request };
}

function syntheticPending(task: TaskContract, state: CheckpointIntent['state'] = 'PREPARED'): CheckpointIntent {
  const suffix = randomUUID();
  return {
    id: `checkpoint-${suffix}`,
    task_id: task.id,
    producer_revision: task.revision,
    purpose: 'RESUME',
    state,
    request_identity: `request-${suffix}`,
    repo_root: task.repo_root,
    prior_base_commit: task.base_commit,
    expected_tree: `tree-${suffix}`,
    scope_identity: `scope-${suffix}`,
    checkpoint_commit: state === 'FINALIZING' ? `commit-${suffix}` : null,
    checkpoint_ref: `refs/engineering-mcp/checkpoints/${task.id}/${suffix}`,
    branch: task.branch,
    changed_files: [],
    created_at: new Date().toISOString(),
    finalized_at: null,
  };
}

function dispatchFor(task: TaskContract, status: DispatchRun['status'] = 'failed'): DispatchRun {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    task_id: task.id,
    worker_role: 'JUNIOR',
    adapter_id: 'fixture',
    worker_profile_id: null,
    runner_instance_id: null,
    pid: null,
    status,
    started_at: null,
    finished_at: status === 'failed' ? now : null,
    exit_code: null,
    error_code: status === 'failed' ? 'fixture' : null,
    error_detail: null,
    created_at: now,
    updated_at: now,
  };
}

function insertPlannedIntent(store: Store, task: TaskContract, repo: string, file: string): CheckpointIntent {
  const timestamp = new Date().toISOString();
  const plan = planGitCheckpoint(repo, {
    taskId: task.id,
    producerRevision: task.revision,
    purpose: 'RESUME',
    priorBaseCommit: task.base_commit,
    branch: task.branch,
    allowedScope: [file],
    forbiddenScope: [],
    timestamp,
  });
  const intent: CheckpointIntent = {
    id: randomUUID(),
    task_id: task.id,
    producer_revision: task.revision,
    purpose: 'RESUME',
    state: 'PREPARED',
    request_identity: plan.requestIdentity,
    repo_root: plan.repoRoot,
    prior_base_commit: plan.priorBaseCommit,
    expected_tree: plan.expectedTree,
    scope_identity: plan.scopeIdentity,
    checkpoint_commit: null,
    checkpoint_ref: plan.checkpointRef,
    branch: plan.branch,
    changed_files: plan.changedFiles,
    created_at: timestamp,
    finalized_at: null,
  };
  store.transact(() => store.insertCheckpointIntent(intent));
  return intent;
}

function forceRunningAfterPending(store: Store, task: TaskContract, execution: string): TaskContract {
  const raw = new DatabaseSync(store.path);
  raw.exec('DROP TRIGGER trg_tasks_checkpoint_fence_update');
  raw.prepare(
    `UPDATE tasks SET status = 'RUNNING', assignee_role = 'JUNIOR', execution_instance_id = ?,
     writer_generation = writer_generation + ${WRITER_PROTOCOL_GENERATION}, revision = revision + 1, updated_at = ? WHERE id = ?`,
  ).run(execution, new Date().toISOString(), task.id);
  raw.close();
  return store.getTask(task.id)!;
}

function forceActiveDispatchAfterPending(store: Store, task: TaskContract): DispatchRun {
  const raw = new DatabaseSync(store.path);
  raw.exec('DROP TRIGGER trg_dispatch_runs_checkpoint_fence_insert');
  raw.close();
  const dispatch = dispatchFor(task, 'launching');
  store.insertDispatchRun(dispatch);
  return dispatch;
}

function expectCheckpointFence(operation: () => unknown, taskId: string, state: CheckpointIntent['state']): void {
  try {
    operation();
    throw new Error('expected repository checkpoint fence');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('CHECKPOINT_FINALIZATION_REQUIRED');
    expect((error as DomainError).details).toMatchObject({ task_id: taskId, checkpoint_state: state });
  }
}

describe('repository-global unfinished checkpoint fence', () => {
  it('closes the reviewer two-task GIT_APPLIED reproduction and releases only after exact retry', () => {
    const fixture = createTwoTaskCheckpointFailure('after_git_applied_record');
    const pending = fixture.store.getAnyUnfinalizedCheckpoint()!;
    const checkpointHead = snapshot(fixture.repo).head;
    expect(pending.state).toBe('GIT_APPLIED');
    expect(snapshot(fixture.repo).clean).toBe(true);

    expectCheckpointFence(() => createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-c.txt'),
    }), fixture.producer.id, 'GIT_APPLIED');
    expectCheckpointFence(() => claimTask(
      fixture.store, snapshot(fixture.repo), 'JUNIOR', 'other', fixture.other.id, fixture.other.revision,
    ), fixture.producer.id, 'GIT_APPLIED');
    expectCheckpointFence(() => claimNextTask(fixture.store, snapshot(fixture.repo), 'JUNIOR', 'next'), fixture.producer.id, 'GIT_APPLIED');
    expect(snapshot(fixture.repo).head).toBe(checkpointHead);
    expect(fixture.store.getTask(fixture.other.id)).toEqual(fixture.other);

    const finalized = checkpointTask(fixture.store, snapshot(fixture.repo), fixture.request);
    expect(finalized.checkpoint.state).toBe('FINALIZED');
    expect(fixture.store.getAnyUnfinalizedCheckpoint()).toBeUndefined();
    expect(createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-c.txt'),
    }).status).toBe('READY');
  });

  it('blocks report transitions on another RUNNING task', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const otherCreated = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-b.txt'),
    });
    const pending = syntheticPending(producer);
    fixture.store.transact(() => fixture.store.insertCheckpointIntent(pending));
    const other = forceRunningAfterPending(fixture.store, otherCreated, 'other');

    expectCheckpointFence(() => reportBlocked(fixture.store, 'JUNIOR', 'other', {
      task_id: other.id,
      revision: other.revision,
      blocker: { reason: 'OTHER', summary: 'blocked', need_from_owner: 'none', evidence_refs: [] },
    }), producer.id, 'PREPARED');
    expectCheckpointFence(() => reportResult(fixture.store, 'JUNIOR', 'other', {
      task_id: other.id,
      revision: other.revision,
      outcome: 'completed',
      result: implResult,
    }), producer.id, 'PREPARED');
    expect(fixture.store.getTask(other.id)?.status).toBe('RUNNING');
  });

  it('blocks another checkpoint, delegation, and diagnosis handoff', async () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const other = createBlocked(fixture.store, fixture.repo, 'output-b.txt', 'other');
    const ready = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-c.txt'),
    });
    const pending = syntheticPending(producer);
    fixture.store.transact(() => fixture.store.insertCheckpointIntent(pending));
    writeFileSync(join(fixture.repo, 'output-b.txt'), 'other output\n');

    expectCheckpointFence(() => checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: other.id, revision: other.revision, purpose: 'RESUME',
    }), producer.id, 'PREPARED');
    await expect(delegateTask(fixture.store, snapshot(fixture.repo), ready.id, ready.revision, {
      adapterId: 'fixture', wait: false,
    })).rejects.toMatchObject({ code: 'CHECKPOINT_FINALIZATION_REQUIRED' });
    expectCheckpointFence(() => createDiagnosisFromCheckpoint(fixture.store, snapshot(fixture.repo), {
      producer_task_id: other.id,
      producer_revision: other.revision,
      checkpoint_id: 'unreachable-review-checkpoint',
      payload: diagnosisPayload,
    }), producer.id, 'PREPARED');
    expect(fixture.store.listDispatchRunsForTask(ready.id)).toEqual([]);
  });

  it('blocks resume, recover, cancel, and close on every other task', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const blocked = createBlocked(fixture.store, fixture.repo, 'output-b.txt', 'blocked');
    const completedCreated = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-c.txt'),
    });
    const completedRunning = claimTask(
      fixture.store, snapshot(fixture.repo), 'JUNIOR', 'completed', completedCreated.id, completedCreated.revision,
    );
    const completed = reportResult(fixture.store, 'JUNIOR', 'completed', {
      task_id: completedRunning.id,
      revision: completedRunning.revision,
      outcome: 'completed',
      result: { ...implResult, changed_files: [] },
    });
    fixture.store.insertCheckpointIntent(syntheticPending(producer));

    expectCheckpointFence(() => resumeTask(fixture.store, snapshot(fixture.repo), {
      task_id: blocked.id, revision: blocked.revision,
    }), producer.id, 'PREPARED');
    expectCheckpointFence(() => cancelTask(fixture.store, blocked.id, blocked.revision), producer.id, 'PREPARED');
    expectCheckpointFence(() => closeTask(fixture.store, completed.id, completed.revision), producer.id, 'PREPARED');
    const forcedRunning = forceRunningAfterPending(fixture.store, blocked, 'forced-running');
    expectCheckpointFence(() => recoverTask(fixture.store, snapshot(fixture.repo), {
      task_id: forcedRunning.id, revision: forcedRunning.revision,
    }), producer.id, 'PREPARED');
  });

  for (const [stage, state] of [
    ['after_intent', 'PREPARED'],
    ['after_git_applied_record', 'GIT_APPLIED'],
    ['after_finalize_transaction', 'FINALIZING'],
  ] as const) {
    it(`survives restart in ${state}, keeps the global fence, and converges by exact retry`, () => {
      const fixture = createTwoTaskCheckpointFailure(stage);
      const dbPath = fixture.store.path;
      fixture.store.close();
      stores.splice(stores.indexOf(fixture.store), 1);
      const reopened = Store.open(dbPath, { repoRoot: fixture.repo });
      stores.push(reopened);
      expect(reopened.getAnyUnfinalizedCheckpoint()?.state).toBe(state);
      expect(reopened.getTask(fixture.other.id)).toEqual(fixture.other);
      expectCheckpointFence(() => claimTask(
        reopened, snapshot(fixture.repo), 'JUNIOR', 'other', fixture.other.id, fixture.other.revision,
      ), fixture.producer.id, state);
      const recovered = checkpointTask(reopened, snapshot(fixture.repo), fixture.request);
      expect(recovered.checkpoint.state).toBe('FINALIZED');
      expect(reopened.getAnyUnfinalizedCheckpoint()).toBeUndefined();
    });
  }

  it('allows only one unfinished intent across tasks and rejects a competing checkpoint', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const other = createBlocked(fixture.store, fixture.repo, 'output-b.txt', 'other');
    const first = syntheticPending(producer);
    fixture.store.transact(() => fixture.store.insertCheckpointIntent(first));
    expect(() => fixture.store.transact(() => fixture.store.insertCheckpointIntent(syntheticPending(other))))
      .toThrow(new RegExp(`CHECKPOINT_FINALIZATION_REQUIRED task=${producer.id} checkpoint=${first.id} state=PREPARED`));
    const concurrent = Store.open(fixture.store.path, { repoRoot: fixture.repo });
    stores.push(concurrent);
    expectCheckpointFence(() => checkpointTask(concurrent, snapshot(fixture.repo), {
      task_id: other.id, revision: other.revision, purpose: 'RESUME',
    }), producer.id, 'PREPARED');
    expect(fixture.store.getAnyUnfinalizedCheckpoint()?.id).toBe(first.id);
  });

  it('atomically rejects checkpoint intent insertion beside a RUNNING writer or active dispatch', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const otherCreated = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-b.txt'),
    });
    const otherRunning = claimTask(
      fixture.store, snapshot(fixture.repo), 'JUNIOR', 'other', otherCreated.id, otherCreated.revision,
    );
    expect(() => fixture.store.insertCheckpointIntent(syntheticPending(producer)))
      .toThrow(new RegExp(`TASK_ALREADY_RUNNING task=${otherRunning.id}`));
    const otherBlocked = reportBlocked(fixture.store, 'JUNIOR', 'other', {
      task_id: otherRunning.id,
      revision: otherRunning.revision,
      blocker: { reason: 'OTHER', summary: 'done', need_from_owner: 'none', evidence_refs: [] },
    });
    const activeDispatch = dispatchFor(otherBlocked, 'launching');
    fixture.store.insertDispatchRun(activeDispatch);
    expect(() => fixture.store.insertCheckpointIntent(syntheticPending(producer)))
      .toThrow(new RegExp(`CHECKPOINT_ACTIVE_DISPATCH dispatch=${activeDispatch.id} task=${otherBlocked.id}`));
    expect(fixture.store.getAnyUnfinalizedCheckpoint()).toBeUndefined();
  });

  it('database triggers reject raw task and dispatch mutations during the global fence', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const other = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-b.txt'),
    });
    const terminalDispatch = dispatchFor(other);
    fixture.store.insertDispatchRun(terminalDispatch);
    const pending = syntheticPending(producer);
    fixture.store.insertCheckpointIntent(pending);
    const fencePattern = new RegExp(
      `CHECKPOINT_FINALIZATION_REQUIRED task=${producer.id} checkpoint=${pending.id} state=PREPARED`,
    );

    const raw = new DatabaseSync(fixture.store.path);
    raw.exec('PRAGMA foreign_keys = ON');
    expect(() => raw.prepare(
      `INSERT INTO tasks
       SELECT ?, type, status, owner_role, assignee_role, execution_instance_id, writer_generation,
         repo_root, base_commit, branch, source_checkpoint_id, source_task_id, source_task_revision,
         source_checkpoint_commit, source_checkpoint_ref, source_prior_base_commit, payload_json,
         result_json, blocker_json, revision, created_at, updated_at
       FROM tasks WHERE id = ?`,
    ).run(randomUUID(), other.id)).toThrow(fencePattern);
    expect(() => raw.prepare(
      `UPDATE tasks SET status = 'CANCELLED', writer_generation = writer_generation + ${WRITER_PROTOCOL_GENERATION},
       revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), other.id)).toThrow(fencePattern);
    expect(() => raw.prepare(
      `INSERT INTO dispatch_runs (
        id, task_id, worker_role, adapter_id, worker_profile_id, writer_generation, runner_instance_id, pid,
        status, started_at, finished_at, exit_code, error_code, error_detail, created_at, updated_at
      ) VALUES (?, ?, 'JUNIOR', 'raw', NULL, ${WRITER_PROTOCOL_GENERATION}, NULL, NULL, 'launching', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(randomUUID(), other.id, new Date().toISOString(), new Date().toISOString())).toThrow(fencePattern);
    expect(() => raw.prepare(
      `UPDATE dispatch_runs SET status = 'running', writer_generation = writer_generation + ${WRITER_PROTOCOL_GENERATION}, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), terminalDispatch.id)).toThrow(fencePattern);
    raw.close();
    expect(fixture.store.getTask(other.id)).toEqual(other);
    expect(fixture.store.getDispatchRun(terminalDispatch.id)).toEqual(terminalDispatch);
  });

  it('exact retry fails closed when another RUNNING writer exists', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const otherCreated = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-b.txt'),
    });
    writeFileSync(join(fixture.repo, 'output-a.txt'), 'valuable output\n');
    const beforeHead = snapshot(fixture.repo).head;
    const intent = insertPlannedIntent(fixture.store, producer, fixture.repo, 'output-a.txt');
    const other = forceRunningAfterPending(fixture.store, otherCreated, 'other');

    expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: producer.id, revision: producer.revision, purpose: 'RESUME',
    })).toThrow(/RUNNING/);
    expect(fixture.store.getTask(other.id)?.status).toBe('RUNNING');
    expect(fixture.store.getCheckpointById(intent.id)?.state).toBe('PREPARED');
    expect(snapshot(fixture.repo).head).toBe(beforeHead);
    expect(() => git(fixture.repo, ['show-ref', '--verify', intent.checkpoint_ref])).toThrow();
  });

  it('exact retry fails closed when a conflicting dispatch exists', () => {
    const fixture = openFixture();
    const producer = createBlocked(fixture.store, fixture.repo, 'output-a.txt', 'producer');
    const other = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION', payload: payloadFor('output-b.txt'),
    });
    writeFileSync(join(fixture.repo, 'output-a.txt'), 'valuable output\n');
    const intent = insertPlannedIntent(fixture.store, producer, fixture.repo, 'output-a.txt');
    const dispatch = forceActiveDispatchAfterPending(fixture.store, other);

    expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: producer.id, revision: producer.revision, purpose: 'RESUME',
    })).toThrow(/dispatch/i);
    expect(fixture.store.getDispatchRun(dispatch.id)?.status).toBe('launching');
    expect(fixture.store.getCheckpointById(intent.id)?.state).toBe('PREPARED');
  });
});
