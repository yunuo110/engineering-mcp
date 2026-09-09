import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelTask, claimTask, createTask, recoverTask, resumeTask } from '../src/lifecycle.ts';
import { delegateTask, waitForDispatch } from '../src/orchestration/dispatcher.ts';
import { Store } from '../src/store.ts';
import { implPayload, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(childProcess.spawn).mockReset();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});
function setup() {
  const repo = initGitRepo();
  const opened = openTempStore(repo);
  dirs.push(repo, opened.dir);
  stores.push(opened.store);
  const git = snapshot(repo);
  const task = createTask(opened.store, git, { type: 'IMPLEMENTATION', payload: implPayload });
  return { repo, store: opened.store, git, task };
}
function controlledSpawn() {
  const children: EventEmitter[] = [];
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    children.push(child);
    return child as childProcess.ChildProcess;
  });
  return children;
}

describe('late spawn errors respect durable dispatch authority', () => {
  it('A: a real initial spawn error still reports WORKER_PROCESS_FAILED', async () => {
    const { repo, store, git, task } = setup();
    const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(childProcess.spawn).mockImplementationOnce((_command, args, options) =>
      spawn(join(repo, 'absent-executable'), args, options));
    const run = await delegateTask(store, git, task.id, task.revision, { adapterId: 'fixture', wait: false });
    const terminal = await waitForDispatch(store, run.id, 5000);
    expect(terminal.status).toBe('failed');
    expect(terminal.error_code).toBe('WORKER_PROCESS_FAILED');
    expect(terminal.error_detail).toContain('Failed to spawn worker runner');
    expect(store.getTask(task.id)?.status).toBe('READY');
  });

  it.each(['launching', 'running'] as const)('B: %s cancellation survives delayed error', async (status) => {
    const { store, git, task } = setup();
    const children = controlledSpawn();
    const run = await delegateTask(store, git, task.id, task.revision, { adapterId: 'fixture', wait: false });
    let revision = task.revision;
    if (status === 'running') {
      revision = claimTask(store, git, 'JUNIOR', 'test-runner', task.id, revision, { ...run, status, runner_instance_id: 'test-runner' }).revision;
    }
    cancelTask(store, task.id, revision);
    const cancelled = store.getDispatchRun(run.id);
    children[0]!.emit('error', new Error('delayed spawn failure'));
    expect(store.getDispatchRun(run.id)).toEqual(cancelled);
    expect(store.getDispatchRun(run.id)?.error_code).toBe('OWNER_CANCELLED');
  });

  it('C: cancel then replace leaves both the cancelled record and replacement untouched', async () => {
    const { store, git, task } = setup();
    const children = controlledSpawn();
    const run = await delegateTask(store, git, task.id, task.revision, { adapterId: 'fixture', wait: false });
    cancelTask(store, task.id, task.revision);
    const replacementTask = createTask(store, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const replacement = await delegateTask(store, git, replacementTask.id, replacementTask.revision, { adapterId: 'fixture', wait: false });
    const cancelled = store.getDispatchRun(run.id);
    children[0]!.emit('error', new Error('old launch failed'));
    expect(store.getDispatchRun(run.id)).toEqual(cancelled);
    expect(store.getDispatchRun(replacement.id)).toEqual(replacement);
  });

  it('D: recovery through a reopened connection and same-task replacement fences the old event', async () => {
    const { store, git, task } = setup();
    const children = controlledSpawn();
    const run = await delegateTask(store, git, task.id, task.revision, { adapterId: 'fixture', wait: false });
    const running = claimTask(store, git, 'JUNIOR', 'old-runner', task.id, task.revision, { ...run, status: 'running', runner_instance_id: 'old-runner' });
    const restartedOwner = Store.open(store.path, { repoRoot: git.repoRoot });
    stores.push(restartedOwner);
    const recovered = recoverTask(restartedOwner, git, { task_id: task.id, revision: running.revision });
    const resumed = resumeTask(restartedOwner, git, { task_id: task.id, revision: recovered.revision });
    const replacement = await delegateTask(restartedOwner, git, resumed.id, resumed.revision, { adapterId: 'fixture', wait: false });
    const old = restartedOwner.getDispatchRun(run.id);
    children[0]!.emit('error', new Error('stale process error'));
    expect(restartedOwner.getDispatchRun(run.id)).toEqual(old);
    expect(restartedOwner.getDispatchRun(run.id)?.error_code).toBe('EXPLICIT_OWNER_RECOVERY');
    expect(restartedOwner.getDispatchRun(replacement.id)).toEqual(replacement);
    store.close();
    children[0]!.emit('error', new Error('error after old connection closed'));
    expect(restartedOwner.getDispatchRun(run.id)).toEqual(old);
  });
});
