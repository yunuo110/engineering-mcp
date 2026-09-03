import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelTask,
  claimTask,
  closeTask,
  createTask,
  getTask,
  listActiveTasks,
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
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', created.id, created.revision);
    expect(claimed.status).toBe('RUNNING');
    expect(claimed.assignee_role).toBe('JUNIOR');
    expect(claimed.payload).toEqual(implPayload);
    expect(claimed.revision).toBe(2);
  });

  it('does not allow JUNIOR to claim DIAGNOSIS or PRINCIPAL to claim IMPLEMENTATION', () => {
    const db = store();
    const impl = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    expectDomain(() => claimTask(db, cleanGit(), 'PRINCIPAL', impl.id, impl.revision), 'WRONG_TASK_TYPE');
    expectDomain(() => claimTask(db, cleanGit(), 'JUNIOR', diag.id, diag.revision), 'WRONG_TASK_TYPE');
  });

  it('serializes RUNNING so diagnosis cannot run beside implementation', () => {
    const db = store();
    const impl = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    claimTask(db, cleanGit(), 'JUNIOR', impl.id, impl.revision);
    expectDomain(
      () => claimTask(db, cleanGit(), 'PRINCIPAL', diag.id, diag.revision),
      'TASK_ALREADY_RUNNING',
    );
  });

  it('rejects claim on HEAD, branch, dirty, or revision mismatch', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    expectDomain(
      () => claimTask(db, cleanGit({ head: 'bbb' }), 'JUNIOR', created.id, created.revision),
      'HEAD_MISMATCH',
    );
    expectDomain(
      () => claimTask(db, cleanGit({ branch: 'other' }), 'JUNIOR', created.id, created.revision),
      'BRANCH_MISMATCH',
    );
    expectDomain(
      () =>
        claimTask(db, cleanGit({ clean: false, porcelain: ' M x' }), 'JUNIOR', created.id, created.revision),
      'DIRTY_WORKTREE',
    );
    expectDomain(() => claimTask(db, cleanGit(), 'JUNIOR', created.id, 99), 'REVISION_MISMATCH');
  });

  it('reports completed implementation results and releases the running slot', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', created.id, created.revision);
    const done = reportResult(db, 'JUNIOR', {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: implResult,
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.result).toEqual(implResult);
    expect(db.getRunning()).toBeUndefined();
    const diag = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    const claimedDiag = claimTask(db, cleanGit(), 'PRINCIPAL', diag.id, diag.revision);
    expect(claimedDiag.status).toBe('RUNNING');
  });

  it('reports failed and blocked, then resumes to READY with a new baseline', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', created.id, created.revision);
    const blocked = reportBlocked(db, 'JUNIOR', {
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
    const claimed = claimTask(db, cleanGit(), 'PRINCIPAL', created.id, created.revision);
    const failed = reportResult(db, 'PRINCIPAL', {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'failed',
      result: diagnosisResult,
    });
    expect(failed.status).toBe('FAILED');
    const ready = resumeTask(db, cleanGit(), { task_id: failed.id, revision: failed.revision });
    const claimed2 = claimTask(db, cleanGit(), 'PRINCIPAL', ready.id, ready.revision);
    const completed = reportResult(db, 'PRINCIPAL', {
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
    const claimed3 = claimTask(db, cleanGit({ head: 'ddd' }), 'PRINCIPAL', readyAgain.id, readyAgain.revision);
    const completed2 = reportResult(db, 'PRINCIPAL', {
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
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', created.id, created.revision);
    expect(getTask(db, 'JUNIOR', claimed.id).status).toBe('RUNNING');
    expect(getTask(db, 'OWNER', created.id).id).toBe(created.id);
  });

  it('lists active tasks and omits CLOSED', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', created.id, created.revision);
    const completed = reportResult(db, 'JUNIOR', {
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
    const claimed = claimTask(db, cleanGit(), 'JUNIOR', created.id, created.revision);
    const cancelled = cancelTask(db, claimed.id, claimed.revision, 'owner stopped work');
    expect(cancelled.status).toBe('CANCELLED');
    expect(db.getRunning()).toBeUndefined();
    const closed = closeTask(db, cancelled.id, cancelled.revision);
    expect(closed.status).toBe('CLOSED');
  });

  it('rejects an implementation result on a diagnosis task', () => {
    const db = store();
    const created = createTask(db, cleanGit(), { type: 'DIAGNOSIS', payload: diagnosisPayload });
    const claimed = claimTask(db, cleanGit(), 'PRINCIPAL', created.id, created.revision);
    expectDomain(
      () =>
        reportResult(db, 'PRINCIPAL', {
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
    const claimed = claimTask(db, cleanGit(), 'PRINCIPAL', created2.id, created2.revision);
    expectDomain(
      () =>
        reportResult(db, 'PRINCIPAL', {
          task_id: claimed.id,
          revision: 99,
          outcome: 'failed',
          result: diagnosisResult,
        }),
      'REVISION_MISMATCH',
    );
    const failed = reportResult(db, 'PRINCIPAL', {
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
      () => claimTask(db, gitB, 'JUNIOR', created.id, created.revision),
      'REPOSITORY_MISMATCH',
    );
    const afterFailedClaim = getTask(db, 'OWNER', created.id);
    expect(afterFailedClaim.status).toBe('READY');
    expect(afterFailedClaim.repo_root).toBe(gitA.repoRoot);
    expect(afterFailedClaim.revision).toBe(created.revision);
    expect(db.listEvents(created.id).map((event) => event.kind)).toEqual(['created']);

    const claimed = claimTask(db, gitA, 'JUNIOR', created.id, created.revision);
    expect(claimed.status).toBe('RUNNING');
    const blocked = reportBlocked(db, 'JUNIOR', {
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
});
