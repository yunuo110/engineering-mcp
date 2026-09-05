import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimTask, createTask } from '../src/lifecycle.ts';
import { delegateTask, waitForDispatch } from '../src/orchestration/dispatcher.ts';
import { runWorkerRunner } from '../src/orchestration/worker-runner.ts';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../src/orchestration/types.ts';
import type { Store } from '../src/store.ts';
import {
  implPayload,
  initGitRepo,
  makeDirty,
  openTempStore,
  removeDir,
  snapshot,
  type Connected,
  connectInProcess,
} from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const connections: Connected[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close();
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

class FakeAdapter implements WorkerAdapter {
  readonly id = 'fake-luna';
  calls: AdapterContext[] = [];
  result: WorkerResult;
  shouldThrow = false;

  constructor(result: WorkerResult) {
    this.result = result;
  }

  async probe(): Promise<void> {}

  async execute(context: AdapterContext): Promise<WorkerResult> {
    this.calls.push(context);
    if (this.shouldThrow) throw new Error('adapter exploded');
    return { ...this.result, changed_files: [...this.result.changed_files] };
  }
}

const completedResult: WorkerResult = {
  outcome: 'completed',
  summary: 'done',
  changed_files: [],
  validation: [{ check: 'tests', status: 'passed' }],
  known_limitations: [],
  exit_code: 0,
};

const blockedResult: WorkerResult = {
  outcome: 'blocked',
  summary: 'needs owner input',
  changed_files: [],
  validation: [],
  known_limitations: [],
  blocked_reason: 'DECISION_REQUIRED',
  exit_code: 1,
};

function testStore(repo: string): Store {
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  return opened.store;
}

describe('V1.6 orchestration', () => {
  it('rejects delegation of a non-READY task', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    claimTask(db, git, 'JUNIOR', 'runner-claimer', task.id, task.revision);
    const adapter = new FakeAdapter(completedResult);
    await expect(
      delegateTask(db, git, task.id, task.revision + 1, {
        adapterId: adapter.id,
        inProcess: true,
        executionInstanceId: 'runner-a',
        adapter,
      }),
    ).rejects.toThrow('task is not READY');
  });

  it('rejects delegation when revision is stale', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const adapter = new FakeAdapter(completedResult);
    await expect(
      delegateTask(db, git, task.id, task.revision + 1, {
        adapterId: adapter.id,
        inProcess: true,
        executionInstanceId: 'runner-a',
        adapter,
      }),
    ).rejects.toThrow('revision mismatch');
  });

  it('claims before invoking adapter and completes through dispatch', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const adapter = new FakeAdapter(completedResult);
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'runner-a',
      adapter,
    });
    expect(run.status).toBe('completed');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.task.status).toBe('RUNNING');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
  });

  it('reports BLOCKED when adapter returns blocked', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const adapter = new FakeAdapter(blockedResult);
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'runner-a',
      adapter,
    });
    expect(run.status).toBe('blocked');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('does not invoke adapter when claim fails', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const adapter = new FakeAdapter(completedResult);
    // Occupy the RUNNING slot so claim fails.
    const other = await connectInProcess('junior', repo, db);
    connections.push(other);
    await other.client.callTool({
      name: 'claim_task',
      arguments: { task_id: task.id, revision: task.revision },
    });
    await expect(
      delegateTask(db, git, task.id, task.revision, {
        adapterId: adapter.id,
        inProcess: true,
        executionInstanceId: 'runner-b',
        adapter,
      }),
    ).rejects.toThrow();
    expect(adapter.calls).toHaveLength(0);
  });

  it('rejects delegation on a dirty repository', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    makeDirty(repo);
    const dirtyGit = snapshot(repo);
    const adapter = new FakeAdapter(completedResult);
    await expect(
      delegateTask(db, dirtyGit, task.id, task.revision, {
        adapterId: adapter.id,
        inProcess: true,
        executionInstanceId: 'runner-a',
        adapter,
      }),
    ).rejects.toThrow('Working tree is not clean');
  });

  it('rejects duplicate active dispatch for one task', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const now = new Date().toISOString();
    db.insertDispatchRun({
      id: 'existing-dispatch',
      task_id: task.id,
      worker_role: 'JUNIOR',
      adapter_id: 'fake-luna',
      runner_instance_id: 'existing-runner',
      pid: 123,
      status: 'running',
      started_at: now,
      finished_at: null,
      exit_code: null,
      error_code: null,
      error_detail: null,
      created_at: now,
      updated_at: now,
    });
    const adapter = new FakeAdapter(completedResult);
    await expect(
      delegateTask(db, git, task.id, task.revision, {
        adapterId: adapter.id,
        inProcess: true,
        executionInstanceId: 'runner-a',
        adapter,
      }),
    ).rejects.toThrow('active dispatch already exists');
  });

  it('reports BLOCKED when adapter throws', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const adapter = new FakeAdapter(completedResult);
    adapter.shouldThrow = true;
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'runner-a',
      adapter,
    });
    expect(run.status).toBe('blocked');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('runs a real spawned Worker Runner fixture to COMPLETED', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'completed'],
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('completed');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
  });

  it('marks dispatch failed and leaves task RUNNING when spawned runner crashes after claim', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'crash-after-claim'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('WORKER_PROCESS_FAILED');
    expect(db.getTask(task.id)?.status).toBe('RUNNING');
  });

  it('marks dispatch failed and leaves task READY when runner entry cannot launch', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const missingFixture = join(repo, 'does-not-exist.ts');
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: missingFixture,
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('WORKER_PROCESS_FAILED');
    expect(db.getTask(task.id)?.status).toBe('READY');
  });

  it('OWNER wait timeout does not kill a healthy spawned runner', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const early = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'completed', '--delay', '2000'],
      wait: false,
    });
    const running = await waitForDispatch(db, early.id, 5_000);
    expect(['running', 'completed']).toContain(running.status);
    const shortWait = await waitForDispatch(db, early.id, 50);
    expect(['running', 'completed']).toContain(shortWait.status);
    const terminal = await waitForDispatch(db, early.id, 10_000);
    expect(terminal.status).toBe('completed');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
  });

  it('blocks on out-of-scope mutations and preserves the worktree', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const payload = { ...implPayload, allowed_scope: ['README.md'], forbidden_scope: ['outside.txt'] };
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'out-of-scope'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('SCOPE_VIOLATION');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
    expect(snapshot(repo).head).toBe(git.head);
  });

  it('blocks on unexpected HEAD change and preserves the moved HEAD', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'head-change'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('UNEXPECTED_HEAD_CHANGE');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
    expect(snapshot(repo).head).not.toBe(git.head);
  });

  it('blocks on malformed worker protocol even with a zero exit process', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'protocol-failure'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('WORKER_PROTOCOL_FAILURE');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('blocks with WORKER_PROCESS_FAILED when adapter throws', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'throw'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('WORKER_PROCESS_FAILED');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('blocks when a forbidden path inside allowed scope is changed', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const payload = { ...implPayload, allowed_scope: ['src'], forbidden_scope: ['src/secret.ts'] };
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'forbidden-inside-allowed'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('SCOPE_VIOLATION');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('allows a changed file inside allowed scope when not forbidden', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const payload = { ...implPayload, allowed_scope: ['src'], forbidden_scope: ['src/secret.ts'] };
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'allowed-sibling-only'],
      timeoutMs: 10_000,
    });
    expect(run.status).toBe('completed');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
  });

  it('blocks structurally invalid WorkerResult from adapter', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const adapter = new FakeAdapter({ outcome: 'completed', summary: 'missing fields', changed_files: [], validation: [], known_limitations: [] } as unknown as WorkerResult);
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'strict-runner',
      adapter,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('WORKER_PROTOCOL_FAILURE');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('delegate_task returns explicit still-running state when wait times out', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const fixture = fileURLToPath(new URL('./fixtures/worker-runner-fixture.ts', import.meta.url));
    const early = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'fixture-adapter',
      runnerEntry: fixture,
      runnerArgs: ['--mode', 'completed', '--delay', '2000'],
      wait: true,
      timeoutMs: 50,
    });
    expect(['launching', 'running']).toContain(early.status);
    expect(db.getActiveDispatchForTask(task.id)?.id).toBe(early.id);
    const terminal = await waitForDispatch(db, early.id, 10_000);
    expect(terminal.status).toBe('completed');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
  });
});
