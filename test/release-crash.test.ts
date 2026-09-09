import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.ts';
import { cancelTask, createTask, recoverTask, reportResult } from '../src/lifecycle.ts';
import { implPayload, implResult, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe('release campaign: process death at persistence boundaries', () => {
  it.each(['before-commit', 'claim-dispatch-gap', 'after-worker-write', 'terminal-dispatch-gap', 'after-completion'])('%s survives reopening with explicit recovery', (mode) => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    const dbPath = opened.store.path;
    const task = mode === 'before-commit' ? undefined : createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload: implPayload });
    const dispatchId = 'crash-dispatch';
    if (task) {
      const now = new Date().toISOString();
      opened.store.insertDispatchRun({ id: dispatchId, task_id: task.id, worker_role: 'JUNIOR', adapter_id: 'crash-fixture',
        worker_profile_id: null, runner_instance_id: null, pid: null, status: 'launching', started_at: null,
        finished_at: null, exit_code: null, error_code: null, error_detail: null, created_at: now, updated_at: now });
    }
    opened.store.close();
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/release-crash-fixture.ts', import.meta.url)), dbPath, repo, mode, task?.id ?? '', dispatchId], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(mode === 'before-commit' ? 91 : mode === 'after-worker-write' ? 93 : mode === 'after-completion' ? 94 : 92);
    const store = Store.open(dbPath, { repoRoot: repo });
    stores.push(store);
    if (!task) {
      expect(store.listActive()).toEqual([]);
      return;
    }
    const current = store.getTask(task.id)!;
    if (mode === 'claim-dispatch-gap') {
      expect(current.status).toBe('READY');
      expect(store.listEvents(task.id).map((event) => event.kind)).toEqual(['created']);
      cancelTask(store, task.id, current.revision, 'cancel interrupted launch');
      expect(store.getActiveDispatchForTask(task.id)).toBeUndefined();
    } else if (mode === 'after-completion') {
      expect(current.status).toBe('COMPLETED');
      expect(store.getDispatchRun(dispatchId)?.status).toBe('completed');
      expect(() => reportResult(store, 'JUNIOR', 'crash-runner', { task_id: task.id, revision: 2, outcome: 'completed', result: implResult })).toThrow();
      expect(store.listEvents(task.id)).toHaveLength(3);
    } else {
      expect(current.status).toBe('RUNNING');
      expect(store.getDispatchRun(dispatchId)?.status).toBe('running');
      const recovered = recoverTask(store, snapshot(repo), { task_id: task.id, revision: current.revision });
      expect(recovered.status).toBe('BLOCKED');
      expect(store.getActiveDispatchForTask(task.id)).toBeUndefined();
      if (mode === 'after-worker-write') expect(readFileSync(join(repo, 'worker-output.txt'), 'utf8')).toContain('durable worker output');
    }
  });
});
