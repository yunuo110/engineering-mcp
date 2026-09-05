import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cancelTask, createTask, recoverTask, reportBlocked, reportResult, resumeTask, claimTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../src/orchestration/types.ts';
import type { Store } from '../src/store.ts';
import { implPayload, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

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

const crashFixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));

function spawnCrashRunner(repo: string, dbPath: string, taskId: string, revision: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      crashFixture,
      '--store',
      dbPath,
      '--repo',
      repo,
      '--task',
      taskId,
      '--revision',
      String(revision),
      '--dispatch',
      'irrelevant',
      '--mode',
      'crash-after-claim',
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), shell: false, windowsHide: true });
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
}

class CompleteAdapter implements WorkerAdapter {
  readonly id = 'complete-test-adapter';
  async probe(): Promise<void> {}
  async execute(context: AdapterContext): Promise<WorkerResult> {
    return { outcome: 'completed', summary: 'ok', changed_files: [], validation: [], known_limitations: [], exit_code: 0 };
  }
}

function testStore(repo: string): Store {
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  return opened.store;
}

function orphanDispatch(taskId: string, id: string, store: Store): void {
  const now = new Date().toISOString();
  store.insertDispatchRun({
    id,
    task_id: taskId,
    worker_role: 'JUNIOR',
    adapter_id: 'orphan-adapter',
    runner_instance_id: 'dead-runner',
    pid: 999,
    status: 'running',
    started_at: now,
    finished_at: null,
    exit_code: null,
    error_code: null,
    error_detail: null,
    created_at: now,
    updated_at: now,
  });
}

describe('dispatch reconciliation on explicit OWNER recovery and cancel', () => {
  it('recover_task terminates orphan active dispatch atomically and allows redelegation', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });

    // Real child claims and exits before report; no parent close handler survives.
    const code = await spawnCrashRunner(repo, db.path, task.id, task.revision);
    expect(code).toBe(9);

    const running = db.getTask(task.id);
    expect(running?.status).toBe('RUNNING');
    orphanDispatch(task.id, 'orphan-dispatch', db);
    const oldActive = db.getActiveDispatchForTask(task.id);
    expect(oldActive?.status).toBe('running');

    const recovered = recoverTask(db, git, { task_id: task.id, revision: running?.revision ?? 0 });
    expect(recovered.status).toBe('BLOCKED');
    const oldDispatch = db.getDispatchRun('orphan-dispatch');
    expect(oldDispatch?.status).toBe('failed');
    expect(oldDispatch?.error_code).toBe('EXPLICIT_OWNER_RECOVERY');
    expect(db.getActiveDispatchForTask(task.id)).toBeUndefined();

    const resumed = resumeTask(db, git, { task_id: recovered.id, revision: recovered.revision });
    expect(resumed.status).toBe('READY');

    const run = await delegateTask(db, git, resumed.id, resumed.revision, {
      adapterId: 'complete-test-adapter',
      inProcess: true,
      executionInstanceId: 'new-runner',
      adapter: new CompleteAdapter(),
    });
    expect(run.status).toBe('completed');
    expect(db.getTask(resumed.id)?.status).toBe('COMPLETED');
    expect(oldDispatch?.status).toBe('failed');
  });

  it('cancel_task terminates orphan active dispatch atomically', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const code = await spawnCrashRunner(repo, db.path, task.id, task.revision);
    expect(code).toBe(9);
    const running = db.getTask(task.id);
    expect(running?.status).toBe('RUNNING');
    orphanDispatch(task.id, 'cancel-dispatch', db);

    const cancelled = cancelTask(db, task.id, running?.revision ?? 0, 'owner cancel');
    expect(cancelled.status).toBe('CANCELLED');
    const dispatch = db.getDispatchRun('cancel-dispatch');
    expect(dispatch?.status).toBe('failed');
    expect(dispatch?.error_code).toBe('OWNER_CANCELLED');
    expect(db.getActiveDispatchForTask(task.id)).toBeUndefined();
  });
});
