import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelTask,
  claimNextTask,
  claimTask,
  closeTask,
  createTask,
  getTask,
  listActiveTasks,
  recoverTask,
  reportBlocked,
  reportResult,
  resumeTask,
} from '../src/lifecycle.ts';
import type { Store } from '../src/store.ts';
import {
  cleanGit,
  cloneRepo,
  diagnosisPayload,
  diagnosisResult,
  expectDomain,
  implPayload,
  implResult,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
} from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

function store(): Store {
  const opened = openTempStore();
  stores.push(opened.store);
  dirs.push(opened.dir);
  return opened.store;
}

const EXECUTION_INSTANCE = 'test-execution-instance';
const OTHER_EXECUTION_INSTANCE = 'other-execution-instance';

describe('lifecycle', () => {
  it('creates a READY task without a CREATED state', () => {
    const db = store();
    const task = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    expect(task.status).toBe('READY');
    expect(task.revision).toBe(1);
    expect(task.assignee_role).toBeNull();
    expect(task.base_commit).toBe('aaa111');
    expect(task.branch).toBe('master');
    expect(db.listEvents(task.id)[0]?.kind).toBe('created');
  });

  it('rejects create_task on a dirty tree', () => {
    const db = store();
    expectDomain(
      () =>
        createTask(db, cleanGit({ clean: false, porcelain: '?? dirty.txt' }), {
          type: 'IMPLEMENTATION',
          payload: implPayload,
        }),
      'DIRTY_WORKTREE',
    );
  });

  it('claims an implementation task for JUNIOR and returns the contract', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    expect(claimed.status).toBe('RUNNING');
    expect(claimed.assignee_role).toBe('JUNIOR');
    expect(claimed.execution_instance_id).toBe(EXECUTION_INSTANCE);
    expect(claimed.payload).toEqual(implPayload);
    expect(claimed.revision).toBe(2);
  });

  it('does not allow JUNIOR to claim DIAGNOSIS or PRINCIPAL to claim IMPLEMENTATION', () => {
    const db = store();
    const impl = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    expectDomain(() => claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, impl.id, impl.revision), 'WRONG_TASK_TYPE');
    expectDomain(() => claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, diag.id, diag.revision), 'WRONG_TASK_TYPE');
  });

  it('serializes RUNNING so diagnosis cannot run beside implementation', () => {
    const db = store();
    const impl = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, impl.id, impl.revision);
    expectDomain(
      () => claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, diag.id, diag.revision),
      'TASK_ALREADY_RUNNING',
    );
  });

  it('rejects claim on HEAD, branch, dirty, or revision mismatch', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    expectDomain(
      () => claimTask(db, cleanGit({ head: 'bbb' }), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision),
      'HEAD_MISMATCH',
    );
    expectDomain(
      () => claimTask(db, cleanGit({ branch: 'other' }), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision),
      'BRANCH_MISMATCH',
    );
    expectDomain(
      () =>
        claimTask(db, cleanGit({ clean: false, porcelain: ' M x' }), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision),
      'DIRTY_WORKTREE',
    );
    expectDomain(() => claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, 99), 'REVISION_MISMATCH');
  });

  it('reports completed implementation results and releases the running slot', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    const done = reportResult(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: implResult,
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.result).toEqual(implResult);
    expect(db.getRunning()).toBeUndefined();
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    const claimedDiag = claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, diag.id, diag.revision);
    expect(claimedDiag.status).toBe('RUNNING');
  });

  it('reports failed and blocked, then resumes to READY with a new baseline', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    const blocked = reportBlocked(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      blocker: {
        reason: 'DECISION_REQUIRED',
        summary: 'Need a schema decision',
        need_from_owner: 'Confirm payload field',
        evidence_refs: ['src/types.ts'],
      },
    });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.assignee_role).toBe('JUNIOR');
    expect(db.getRunning()).toBeUndefined();

    const resumed = resumeTask(db, cleanGit({ head: 'ccc222' }), {
      task_id: blocked.id,
      revision: blocked.revision,
      payload: { ...implPayload, goal: 'Revised goal' },
    });
    expect(resumed.status).toBe('READY');
    expect(resumed.assignee_role).toBeNull();
    expect(resumed.result).toBeNull();
    expect(resumed.blocker).toBeNull();
    expect(resumed.base_commit).toBe('ccc222');
    expect('goal' in resumed.payload && resumed.payload.goal).toBe('Revised goal');
    const event = db.listEvents(resumed.id).at(-1);
    expect(event?.kind).toBe('resumed');
    expect(event?.detail?.previous_status).toBe('BLOCKED');
  });

  it('resumes FAILED and COMPLETED, and refuses CLOSED', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    const claimed = claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, created.id, created.revision);
    const failed = reportResult(db, 'PRINCIPAL', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'failed',
      result: diagnosisResult,
    });
    expect(failed.status).toBe('FAILED');
    const ready = resumeTask(db, cleanGit(), { task_id: failed.id, revision: failed.revision });
    const claimed2 = claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, ready.id, ready.revision);
    const completed = reportResult(db, 'PRINCIPAL', EXECUTION_INSTANCE, {
      task_id: claimed2.id,
      revision: claimed2.revision,
      outcome: 'completed',
      result: diagnosisResult,
    });
    const readyAgain = resumeTask(db, cleanGit({ head: 'ddd' }), {
      task_id: completed.id,
      revision: completed.revision,
    });
    expect(readyAgain.status).toBe('READY');
    const claimed3 = claimTask(db, cleanGit({ head: 'ddd' }), 'PRINCIPAL', EXECUTION_INSTANCE, readyAgain.id, readyAgain.revision);
    const completed2 = reportResult(db, 'PRINCIPAL', EXECUTION_INSTANCE, {
      task_id: claimed3.id,
      revision: claimed3.revision,
      outcome: 'completed',
      result: diagnosisResult,
    });
    const closed = closeTask(db, completed2.id, completed2.revision, 'integrated');
    expect(closed.status).toBe('CLOSED');
    expectDomain(
      () => resumeTask(db, cleanGit({ head: 'ddd' }), { task_id: closed.id, revision: closed.revision }),
      'ILLEGAL_TRANSITION',
    );
  });

  it('hides READY tasks from workers', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    expectDomain(() => getTask(db, 'JUNIOR', created.id), 'NOT_ASSIGNED');
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    expect(getTask(db, 'JUNIOR', claimed.id).status).toBe('RUNNING');
    expect(getTask(db, 'OWNER', created.id).id).toBe(created.id);
  });

  it('lists active tasks and omits CLOSED', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    const completed = reportResult(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: implResult,
    });
    expect(listActiveTasks(db)).toHaveLength(1);
    closeTask(db, completed.id, completed.revision);
    expect(listActiveTasks(db)).toHaveLength(0);
  });

  it('cancels a running task and releases the slot', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    const cancelled = cancelTask(db, claimed.id, claimed.revision, 'owner stopped work');
    expect(cancelled.status).toBe('CANCELLED');
    expect(db.getRunning()).toBeUndefined();
    const closed = closeTask(db, cancelled.id, cancelled.revision);
    expect(closed.status).toBe('CLOSED');
  });

  it('rejects an implementation result on a diagnosis task', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    const claimed = claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, created.id, created.revision);
    expectDomain(
      () =>
        reportResult(db, 'PRINCIPAL', EXECUTION_INSTANCE, {
          task_id: claimed.id,
          revision: claimed.revision,
          outcome: 'completed',
          result: implResult,
        }),
      'INVALID_PAYLOAD',
    );
  });

  it('closes FAILED tasks and rejects stale revisions on mutating tools', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    expectDomain(() => cancelTask(db, created.id, 99), 'REVISION_MISMATCH');
    const cancelledReady = cancelTask(db, created.id, created.revision);
    expect(cancelledReady.status).toBe('CANCELLED');
    const closedCancelled = closeTask(db, cancelledReady.id, cancelledReady.revision);
    expect(closedCancelled.status).toBe('CLOSED');
    expectDomain(
      () => closeTask(db, closedCancelled.id, closedCancelled.revision),
      'ILLEGAL_TRANSITION',
    );

    const created2 = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    const claimed = claimTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE, created2.id, created2.revision);
    expectDomain(
      () =>
        reportResult(db, 'PRINCIPAL', EXECUTION_INSTANCE, {
          task_id: claimed.id,
          revision: 99,
          outcome: 'failed',
          result: diagnosisResult,
        }),
      'REVISION_MISMATCH',
    );
    const failed = reportResult(db, 'PRINCIPAL', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'failed',
      result: diagnosisResult,
    });
    expectDomain(
      () => resumeTask(db, cleanGit(), { task_id: failed.id, revision: 99 }),
      'REVISION_MISMATCH',
    );
    const closedFailed = closeTask(db, failed.id, failed.revision);
    expect(closedFailed.status).toBe('CLOSED');
  });

  it('rejects claim and resume from a different repository with matching branch and HEAD', () => {
    const repoA = initGitRepo();
    const repoB = cloneRepo(repoA);
    dirs.push(repoA, repoB);
    const gitA = snapshot(repoA);
    const gitB = snapshot(repoB);
    expect(gitA.head).toBe(gitB.head);
    expect(gitA.branch).toBe(gitB.branch);
    expect(gitA.repoRoot).not.toBe(gitB.repoRoot);

    const db = store();
    const created = createTask(db, gitA, { type: 'IMPLEMENTATION', payload: implPayload });
    expect(created.repo_root).toBe(gitA.repoRoot);

    expectDomain(
      () => claimTask(db, gitB, 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision),
      'REPOSITORY_MISMATCH',
    );
    const afterFailedClaim = getTask(db, 'OWNER', created.id);
    expect(afterFailedClaim.status).toBe('READY');
    expect(afterFailedClaim.repo_root).toBe(gitA.repoRoot);
    expect(afterFailedClaim.revision).toBe(created.revision);
    expect(db.listEvents(created.id).map((event) => event.kind)).toEqual(['created']);

    const claimed = claimTask(db, gitA, 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    expect(claimed.status).toBe('RUNNING');
    const blocked = reportBlocked(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      blocker: {
        reason: 'DECISION_REQUIRED',
        summary: 'Need owner input',
        need_from_owner: 'Confirm scope',
        evidence_refs: [],
      },
    });
    const eventsBeforeResume = db.listEvents(blocked.id).length;

    expectDomain(
      () => resumeTask(db, gitB, { task_id: blocked.id, revision: blocked.revision }),
      'REPOSITORY_MISMATCH',
    );
    const afterFailedResume = getTask(db, 'OWNER', blocked.id);
    expect(afterFailedResume.status).toBe('BLOCKED');
    expect(afterFailedResume.revision).toBe(blocked.revision);
    expect(afterFailedResume.base_commit).toBe(blocked.base_commit);
    expect(afterFailedResume.result).toEqual(blocked.result);
    expect(afterFailedResume.blocker).toEqual(blocked.blocker);
    expect(afterFailedResume.repo_root).toBe(gitA.repoRoot);
    expect(db.listEvents(blocked.id)).toHaveLength(eventsBeforeResume);
    expect(db.listEvents(blocked.id).at(-1)?.kind).toBe('blocked');

    const resumed = resumeTask(db, gitA, { task_id: blocked.id, revision: blocked.revision });
    expect(resumed.status).toBe('READY');
    expect(resumed.repo_root).toBe(gitA.repoRoot);
  });

  it('claims the next READY task in FIFO order and enforces one RUNNING slot', () => {
    const db = store();
    const first = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const second = createTask(db, cleanGit(), {
      type: 'IMPLEMENTATION',
      payload: { ...implPayload, goal: 'Second goal' },
    });
    expect(listActiveTasks(db, 'IMPLEMENTATION').filter((task) => task.status === 'READY')).toHaveLength(2);
    const claimed = claimNextTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE);
    expect(claimed.id).toBe(first.id);
    expect(claimed.status).toBe('RUNNING');
    expect(claimed.execution_instance_id).toBe(EXECUTION_INSTANCE);
    expect(db.getRunning()?.id).toBe(first.id);
    expectDomain(() => claimNextTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE), 'TASK_ALREADY_RUNNING');
    const listed = listActiveTasks(db, 'IMPLEMENTATION');
    expect(listed.find((task) => task.id === second.id)?.status).toBe('READY');
    expect(listed.find((task) => task.id === first.id)?.status).toBe('RUNNING');
  });

  it('returns NO_PENDING_TASK when no task of the worker type is waiting', () => {
    const db = store();
    expectDomain(() => claimNextTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE), 'NO_PENDING_TASK');
    expectDomain(() => claimNextTask(db, cleanGit(), 'PRINCIPAL', EXECUTION_INSTANCE), 'NO_PENDING_TASK');
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    expectDomain(() => claimNextTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE), 'NO_PENDING_TASK');
    // Cleanup so the leaked DIAGNOSIS task is not left open for later assertions.
    cancelTask(db, diag.id, diag.revision);
  });

  it('does not count terminal tasks as pending READY queue entries', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimNextTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE);
    const completed = reportResult(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: implResult,
    });
    expect(listActiveTasks(db, 'IMPLEMENTATION').filter((task) => task.status === 'READY')).toHaveLength(0);
    expectDomain(() => claimNextTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE), 'NO_PENDING_TASK');
    expect(completed.id).toBe(created.id);
  });

  it('does not claim a queued task when the repository safety baseline is invalid', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const eventsBefore = db.listEvents(created.id).length;
    expectDomain(
      () => claimNextTask(db, cleanGit({ head: 'bbb' }), 'JUNIOR', EXECUTION_INSTANCE),
      'HEAD_MISMATCH',
    );
    expectDomain(
      () => claimNextTask(db, cleanGit({ clean: false, porcelain: ' M x' }), 'JUNIOR', EXECUTION_INSTANCE),
      'DIRTY_WORKTREE',
    );
    const after = getTask(db, 'OWNER', created.id);
    expect(after.status).toBe('READY');
    expect(after.revision).toBe(created.revision);
    expect(db.listEvents(created.id)).toHaveLength(eventsBefore);
  });

  it('explicitly recovers a RUNNING task to BLOCKED with structured metadata', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    expect(db.getRunning()?.id).toBe(created.id);

    const recovered = recoverTask(db, cleanGit(), {
      task_id: claimed.id,
      revision: claimed.revision,
    });
    expect(recovered?.id).toBe(created.id);
    expect(recovered?.status).toBe('BLOCKED');
    expect(recovered?.revision).toBe(claimed.revision + 1);
    expect(recovered?.execution_instance_id).toBeNull();
    expect(recovered?.blocker?.reason).toBe('CONTEXT_STALE');
    expect(recovered?.blocker?.recovery?.previous_status).toBe('RUNNING');
    expect(recovered?.blocker?.recovery?.detected_by_role).toBe('OWNER');
    expect(recovered?.blocker?.recovery?.retry_safe).toBe(false);
    expect(recovered?.blocker?.recovery?.reason).toBe('EXPLICIT_OWNER_RECOVERY');
    expect(recovered?.blocker?.recovery?.prior_execution_instance_id).toBe(EXECUTION_INSTANCE);
    expect(db.getRunning()).toBeUndefined();

    const event = db.listEvents(created.id).at(-1);
    expect(event?.kind).toBe('blocked');
    const recovery = event?.detail?.recovery as Record<string, unknown> | undefined;
    expect(recovery?.reason).toBe('EXPLICIT_OWNER_RECOVERY');
    expect(recovery?.previous_status).toBe('RUNNING');
    expect(recovery?.detected_by_role).toBe('OWNER');
    expect(recovery?.retry_safe).toBe(false);
    expect(event?.detail?.prior_execution_instance_id).toBe(EXECUTION_INSTANCE);
  });

  it('enforces same-role execution ownership for worker mutations', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    expect(claimed.execution_instance_id).toBe(EXECUTION_INSTANCE);

    expectDomain(
      () =>
        reportBlocked(db, 'JUNIOR', OTHER_EXECUTION_INSTANCE, {
          task_id: claimed.id,
          revision: claimed.revision,
          blocker: {
            reason: 'DECISION_REQUIRED',
            summary: 'wrong instance attempt',
            need_from_owner: 'none',
            evidence_refs: [],
          },
        }),
      'EXECUTION_OWNER_MISMATCH',
    );
    expectDomain(
      () =>
        reportResult(db, 'JUNIOR', OTHER_EXECUTION_INSTANCE, {
          task_id: claimed.id,
          revision: claimed.revision,
          outcome: 'completed',
          result: implResult,
        }),
      'EXECUTION_OWNER_MISMATCH',
    );

    const after = getTask(db, 'OWNER', created.id);
    expect(after.status).toBe('RUNNING');
    expect(after.execution_instance_id).toBe(EXECUTION_INSTANCE);
    expect(db.listEvents(created.id)).toHaveLength(2);

    const done = reportResult(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: implResult,
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.execution_instance_id).toBeNull();
  });

  it('requires RUNNING state, current revision, and matching repository for recovery', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    const ready = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const eventsBefore = db.listEvents(created.id).length;

    expectDomain(
      () => recoverTask(db, cleanGit(), { task_id: ready.id, revision: ready.revision }),
      'INVALID_RECOVERY_STATE',
    );
    expectDomain(
      () => recoverTask(db, cleanGit({ head: 'bbb' }), { task_id: claimed.id, revision: claimed.revision + 99 }),
      'REVISION_MISMATCH',
    );
    expectDomain(
      () => recoverTask(db, cleanGit({ repoRoot: 'C:/other' }), { task_id: claimed.id, revision: claimed.revision }),
      'REPOSITORY_MISMATCH',
    );

    const afterFailed = getTask(db, 'OWNER', created.id);
    expect(afterFailed.status).toBe('RUNNING');
    expect(afterFailed.execution_instance_id).toBe(EXECUTION_INSTANCE);
    expect(afterFailed.revision).toBe(claimed.revision);
    expect(db.listEvents(created.id)).toHaveLength(eventsBefore);
  });

  it('clears execution ownership on terminal, blocked, resumed, and explicit recovery paths', () => {
    const db = store();
    const first = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, first.id, first.revision);
    const blocked = reportBlocked(db, 'JUNIOR', EXECUTION_INSTANCE, {
      task_id: claimed.id,
      revision: claimed.revision,
      blocker: {
        reason: 'DECISION_REQUIRED',
        summary: 'Need owner input',
        need_from_owner: 'Confirm scope',
        evidence_refs: [],
      },
    });
    expect(blocked.execution_instance_id).toBeNull();
    const resumed = resumeTask(db, cleanGit({ head: 'bbb222' }), {
      task_id: blocked.id,
      revision: blocked.revision,
    });
    expect(resumed.execution_instance_id).toBeNull();
    expect(resumed.status).toBe('READY');

    const claimedAgain = claimTask(db, cleanGit({ head: 'bbb222' }), 'JUNIOR', EXECUTION_INSTANCE, resumed.id, resumed.revision);
    const recovered = recoverTask(db, cleanGit({ head: 'bbb222' }), {
      task_id: claimedAgain.id,
      revision: claimedAgain.revision,
    });
    expect(recovered.execution_instance_id).toBeNull();
    const resumed2 = resumeTask(db, cleanGit({ head: 'ccc333' }), {
      task_id: recovered.id,
      revision: recovered.revision,
    });
    expect(resumed2.execution_instance_id).toBeNull();
    expect(resumed2.status).toBe('READY');
    expect(first.id).toBe(resumed2.id);
  });

  it('rejects old execution attempts after explicit recovery', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', EXECUTION_INSTANCE, created.id, created.revision);
    const recovered = recoverTask(db, cleanGit(), {
      task_id: claimed.id,
      revision: claimed.revision,
    });
    expect(recovered.status).toBe('BLOCKED');

    expectDomain(
      () =>
        reportResult(db, 'JUNIOR', EXECUTION_INSTANCE, {
          task_id: claimed.id,
          revision: claimed.revision,
          outcome: 'completed',
          result: implResult,
        }),
      'REVISION_MISMATCH',
    );
    const after = getTask(db, 'OWNER', created.id);
    expect(after.status).toBe('BLOCKED');
    expect(after.execution_instance_id).toBeNull();
  });
});