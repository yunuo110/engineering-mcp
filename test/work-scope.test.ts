import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPathAllowedByScope } from '../src/scope.ts';
import { checkpointTask, claimTask, createTaskOnce, reportBlocked, reportResult } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import type { WorkerAdapter, WorkerResult } from '../src/orchestration/types.ts';
import type { Store } from '../src/store.ts';
import { implPayload, implResult, initGitRepo, openTempStore, removeDir, snapshot, expectDomain } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function setup(kind: 'FILE' | 'SUBTREE') {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  const task = createTaskOnce(opened.store, snapshot(repo), `work-${kind}`, {
    type: 'IMPLEMENTATION',
    payload: { ...implPayload, allowed_scope: ['src'], forbidden_scope: [] },
  }, 'test-profile', [{ kind, path: 'src' }]);
  return { repo, store: opened.store, task };
}

describe('Work-bound FILE/SUBTREE authority', () => {
  it('preserves ordinary Task prefix scope while making Work FILE exact', () => {
    expect(isPathAllowedByScope('src/child.txt', ['src'], [])).toBe(true);
    expect(isPathAllowedByScope('src', ['src'], [], [{ kind: 'FILE', path: 'src' }])).toBe(true);
    expect(isPathAllowedByScope('src/child.txt', ['src'], [], [{ kind: 'FILE', path: 'src' }])).toBe(false);
    expect(isPathAllowedByScope('src/child.txt', ['src'], [], [{ kind: 'SUBTREE', path: 'src' }])).toBe(true);
    expect(isPathAllowedByScope('src-other/child.txt', ['src'], [], [{ kind: 'SUBTREE', path: 'src' }])).toBe(false);
    expect(isPathAllowedByScope('src/child.txt', ['src'], ['src/child.txt'],
      [{ kind: 'SUBTREE', path: 'src' }])).toBe(false);
    expect(isPathAllowedByScope('src', ['src'], [], [{ kind: 'FILE', path: 'other' }])).toBe(false);
  });

  it('treats an omitted Work rule as FILE without changing ordinary Task semantics', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = createTaskOnce(opened.store, snapshot(repo), 'implicit-file', {
      type: 'IMPLEMENTATION', payload: { ...implPayload, allowed_scope: ['src'] },
    }, 'test-profile');
    const rules = opened.store.getWorkScopeRulesForTask(task.id);
    expect(rules).toEqual([{ kind: 'FILE', path: 'src' }]);
    expect(isPathAllowedByScope('src/child.txt', ['src'], [], rules)).toBe(false);
    expect(isPathAllowedByScope('src/child.txt', ['src'], [])).toBe(true);
  });

  it.each(['FILE', 'SUBTREE'] as const)('applies %s to Runner-observed changes', async (kind) => {
    const { repo, store, task } = setup(kind);
    const adapter: WorkerAdapter = {
      id: `work-scope-${kind}`,
      async probe() {},
      async execute() {
        mkdirSync(join(repo, 'src'));
        writeFileSync(join(repo, 'src', 'child.txt'), 'worker output\n');
        return {
          outcome: 'completed', summary: 'wrote child', changed_files: ['src/child.txt'],
          validation: [], known_limitations: [], exit_code: 0,
        } satisfies WorkerResult;
      },
    };
    await delegateTask(store, snapshot(repo), task.id, task.revision, {
      adapterId: adapter.id, inProcess: true, executionInstanceId: `runner-${kind}`, adapter,
    });
    const after = store.getTask(task.id);
    expect(after?.status).toBe(kind === 'FILE' ? 'BLOCKED' : 'COMPLETED');
    if (kind === 'FILE') {
      expect(after?.blocker?.reason).toBe('SCOPE_CONFLICT');
      expect(after?.blocker?.evidence?.runner_observed?.scope.rejected_files).toEqual(['src/child.txt']);
    } else {
      expect(after?.result && 'changed_files' in after.result && after.result.changed_files)
        .toEqual(['src/child.txt']);
    }
  });

  it('rejects direct FILE result bypass and out-of-scope checkpoint before Git mutation', () => {
    const { repo, store, task } = setup('FILE');
    const running = claimTask(store, snapshot(repo), 'JUNIOR', 'direct-worker', task.id, task.revision);
    expectDomain(() => reportResult(store, 'JUNIOR', 'direct-worker', {
      task_id: task.id, revision: running.revision, outcome: 'completed',
      result: { ...implResult, changed_files: ['src/child.txt'] },
    }), 'CHECKPOINT_SCOPE_CONFLICT');
    expect(store.getTask(task.id)?.status).toBe('RUNNING');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'child.txt'), 'checkpoint output\n');
    const blocked = reportBlocked(store, 'JUNIOR', 'direct-worker', {
      task_id: task.id, revision: running.revision,
      blocker: {
        reason: 'SCOPE_CONFLICT', summary: 'child is outside FILE scope',
        need_from_owner: 'Review scope', evidence_refs: [], changed_files: ['src/child.txt'],
      },
    });
    const head = snapshot(repo).head;
    expectDomain(() => checkpointTask(store, snapshot(repo), {
      task_id: task.id, revision: blocked.revision, purpose: 'RESUME',
    }), 'CHECKPOINT_SCOPE_CONFLICT');
    expect(snapshot(repo).head).toBe(head);
    expect(store.listCheckpoints(task.id)).toEqual([]);
  });

  it('permits a SUBTREE descendant at the checkpoint gate', () => {
    const { repo, store, task } = setup('SUBTREE');
    const running = claimTask(store, snapshot(repo), 'JUNIOR', 'subtree-worker', task.id, task.revision);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'child.txt'), 'checkpoint output\n');
    const blocked = reportBlocked(store, 'JUNIOR', 'subtree-worker', {
      task_id: task.id, revision: running.revision,
      blocker: {
        reason: 'VALIDATION_ENVIRONMENT', summary: 'External validation unavailable',
        need_from_owner: 'Review output', evidence_refs: [], changed_files: ['src/child.txt'],
      },
    });
    const saved = checkpointTask(store, snapshot(repo), {
      task_id: task.id, revision: blocked.revision, purpose: 'RESUME',
    });
    expect(saved.checkpoint.changed_files).toEqual(['src/child.txt']);
    expect(store.listCheckpoints(task.id)).toHaveLength(1);
  });
});
