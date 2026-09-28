import { afterEach, describe, expect, it } from 'vitest';
import { ewpResultSchema } from '../src/adapters/ewp.ts';
import { claimTask, createTask, reportResult } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import { workerResultSchema, type WorkerResult } from '../src/orchestration/types.ts';
import type { Store } from '../src/store.ts';
import { cleanGit, expectDomain, implPayload, implResult, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});
const completed: WorkerResult = {
  outcome: 'completed', summary: 'reported done', implementation_complete: true,
  changed_files: [], validation: [{ command: 'fixture-check', status: 'passed' }],
  known_limitations: [], exit_code: 0,
};
const contradictions = [
  { implementation_complete: false },
  { validation: [{ command: 'fixture-check', status: 'failed' as const }] },
];

describe('explicit completion contradictions', () => {
  it.each(contradictions)('rejects contradictory EWP and normalized WorkerResult: %j', (contradiction) => {
    const result = { ...completed, ...contradiction };
    expect(ewpResultSchema.safeParse({ protocol: 'engineering-worker/1', ...result }).success).toBe(false);
    expect(workerResultSchema.safeParse(result).success).toBe(false);
    expect(ewpResultSchema.safeParse({ protocol: 'engineering-worker/1', ...result, outcome: 'blocked' }).success).toBe(true);
  });

  it.each(contradictions)('Core rejects the contradiction without an authoritative transition: %j', (contradiction) => {
    const opened = openTempStore(cleanGit().repoRoot);
    stores.push(opened.store); dirs.push(opened.dir);
    const task = createTask(opened.store, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const running = claimTask(opened.store, cleanGit(), 'JUNIOR', 'worker', task.id, task.revision);
    const events = opened.store.listEvents(task.id);
    expectDomain(() => reportResult(opened.store, 'JUNIOR', 'worker', {
      task_id: task.id, revision: running.revision, outcome: 'completed',
      result: { ...implResult, ...contradiction },
    }), 'INVALID_PAYLOAD');
    expect(opened.store.getTask(task.id)).toEqual(running);
    expect(opened.store.listEvents(task.id)).toEqual(events);
  });

  it.each(contradictions)('Runner converts contradictory adapter output to protocol BLOCKED: %j', async (contradiction) => {
    const repo = initGitRepo(); dirs.push(repo);
    const opened = openTempStore(repo); stores.push(opened.store); dirs.push(opened.dir);
    const git = snapshot(repo);
    const task = createTask(opened.store, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const run = await delegateTask(opened.store, git, task.id, task.revision, {
      adapterId: 'contradictory-fixture', inProcess: true, executionInstanceId: 'fixture-runner',
      adapter: { id: 'contradictory-fixture', async probe() {},
        async execute() { return { ...completed, ...contradiction }; } },
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('WORKER_PROTOCOL_FAILURE');
    expect(opened.store.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('does not treat missing or not-run validation as a contradictory verified claim', () => {
    for (const validation of [[], [{ command: 'fixture-check', status: 'not_run' }]]) {
      expect(ewpResultSchema.safeParse({ protocol: 'engineering-worker/1', ...completed, validation }).success).toBe(true);
      expect(workerResultSchema.safeParse({ ...completed, validation }).success).toBe(true);
    }
  });

  it('also rejects contradictory worker_reported evidence without trusting it as verification', () => {
    const opened = openTempStore(cleanGit().repoRoot); stores.push(opened.store); dirs.push(opened.dir);
    const task = createTask(opened.store, cleanGit(), { type: 'IMPLEMENTATION', payload: implPayload });
    const running = claimTask(opened.store, cleanGit(), 'JUNIOR', 'worker', task.id, task.revision);
    expectDomain(() => reportResult(opened.store, 'JUNIOR', 'worker', {
      task_id: task.id, revision: running.revision, outcome: 'completed',
      result: { ...implResult, implementation_complete: true,
        evidence: { worker_reported: { implementation_complete: false } } },
    }), 'INVALID_PAYLOAD');
    expect(opened.store.getTask(task.id)?.status).toBe('RUNNING');
  });
});
