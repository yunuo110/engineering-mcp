import { afterEach, describe, expect, it } from 'vitest';
import { ewpResultSchema, ewpResultToWorkerResult } from '../src/adapters/ewp.ts';
import { claimTask, createTask, reportBlocked, reportResult } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import type { AdapterContext, WorkerAdapter, WorkerResult } from '../src/orchestration/types.ts';
import { Store } from '../src/store.ts';
import {
  cleanGit,
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
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe('structured worker evidence', () => {
  it('round-trips structured result and blocker evidence while accepting legacy minimal evidence', () => {
    const opened = openTempStore('C:\\repo');
    stores.push(opened.store);
    dirs.push(opened.dir);
    const completedTask = createTask(opened.store, cleanGit(), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const completedRunning = claimTask(
      opened.store,
      cleanGit(),
      'JUNIOR',
      'evidence-complete',
      completedTask.id,
      completedTask.revision,
    );
    const result = {
      ...implResult,
      implementation_complete: true,
      validation: [
        {
          command: 'npm test',
          status: 'passed' as const,
          summary: '12 passed',
          counts: { passed: 12, failed: 0, total: 12 },
        },
      ],
      git: {
        head: 'aaa111',
        branch: 'master',
        diff_check: { command: 'git diff --check', status: 'passed' as const },
      },
      environment: {
        cwd: 'C:\\repo',
        platform: 'win32',
        runtime: 'node-test',
        head: 'aaa111',
        branch: 'master',
      },
    };
    const completed = reportResult(opened.store, 'JUNIOR', 'evidence-complete', {
      task_id: completedRunning.id,
      revision: completedRunning.revision,
      outcome: 'completed',
      result,
    });
    expect(completed.result).toMatchObject(result);
    expect(completed.result?.evidence?.worker_reported?.git?.head).toBe('aaa111');
    expect(completed.result?.evidence?.server_authoritative).toMatchObject({
      task_id: completed.id,
      producer_revision: completedRunning.revision,
      actor_role: 'JUNIOR',
      repo_root: 'C:\\repo',
    });

    const blockedTask = createTask(opened.store, cleanGit(), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const blockedRunning = claimTask(
      opened.store,
      cleanGit(),
      'JUNIOR',
      'evidence-blocked',
      blockedTask.id,
      blockedTask.revision,
    );
    const blocked = reportBlocked(opened.store, 'JUNIOR', 'evidence-blocked', {
      task_id: blockedRunning.id,
      revision: blockedRunning.revision,
      blocker: {
        reason: 'VALIDATION_ENVIRONMENT',
        summary: 'The full suite could not read an external fixture',
        need_from_owner: 'Run the full suite in the owner environment.',
        evidence_refs: ['worker stderr'],
        implementation_complete: true,
        changed_files: ['src/store.ts'],
        validation: [
          { command: 'npm run focused', status: 'passed', counts: { passed: 12, total: 12 } },
          { command: 'npm test', status: 'failed', summary: 'EACCES for an external path' },
        ],
        git: { diff_check: { command: 'git diff --check', status: 'passed' } },
        environment: { cwd: 'C:\\repo', platform: 'win32' },
      },
    });
    expect(blocked.blocker?.reason).toBe('VALIDATION_ENVIRONMENT');
    expect(blocked.blocker?.validation?.[0]?.counts?.passed).toBe(12);
    expect(blocked.blocker?.evidence?.worker_reported?.blocker_classification).toBe('VALIDATION_ENVIRONMENT');

    const dbPath = opened.store.path;
    opened.store.close();
    stores.splice(stores.indexOf(opened.store), 1);
    const reopened = Store.open(dbPath, { repoRoot: 'C:\\repo' });
    stores.push(reopened);
    expect(reopened.getTask(completed.id)?.result).toEqual(completed.result);
    expect(reopened.getTask(blocked.id)?.blocker).toEqual(blocked.blocker);

    const legacy = createTask(reopened, cleanGit(), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const legacyRunning = claimTask(
      reopened,
      cleanGit(),
      'JUNIOR',
      'legacy-worker',
      legacy.id,
      legacy.revision,
    );
    const legacyResult = reportResult(reopened, 'JUNIOR', 'legacy-worker', {
        task_id: legacy.id,
        revision: legacyRunning.revision,
        outcome: 'completed',
        result: implResult,
      }).result;
    expect(legacyResult).toMatchObject(implResult);
    expect(legacyResult?.evidence?.server_authoritative?.task_id).toBe(legacy.id);
  });

  it('preserves EWP validation summaries, counts, classification, and environment', () => {
    const parsed = ewpResultSchema.parse({
      protocol: 'engineering-worker/1',
      outcome: 'blocked',
      summary: 'Implementation done; full validation was environment-blocked',
      changed_files: ['src/types.ts'],
      validation: [
        {
          command: 'npm test',
          status: 'failed',
          summary: 'Permission denied',
          counts: { passed: 20, failed: 0, total: 20 },
        },
      ],
      known_limitations: [],
      blocked_reason: 'external path denied',
      blocker_classification: 'VALIDATION_ENVIRONMENT',
      implementation_complete: true,
      git: { diff_check: { command: 'git diff --check', status: 'passed' } },
      environment: { cwd: 'C:\\repo', platform: 'win32' },
      exit_code: 1,
    });
    const converted = ewpResultToWorkerResult(parsed);
    expect(converted.validation[0]).toEqual({
      check: 'npm test',
      command: 'npm test',
      status: 'failed',
      summary: 'Permission denied',
      counts: { passed: 20, failed: 0, total: 20 },
    });
    expect(converted.blocker_classification).toBe('VALIDATION_ENVIRONMENT');
    expect(converted.implementation_complete).toBe(true);
    expect(converted.environment?.cwd).toBe('C:\\repo');
  });

  it('does not drop structured evidence returned through a delegation adapter', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const workerResult: WorkerResult = {
      outcome: 'completed',
      summary: 'No source change was required',
      changed_files: [],
      validation: [
        {
          command: 'npm test',
          status: 'passed',
          summary: '8 passed',
          counts: { passed: 8, total: 8 },
        },
      ],
      known_limitations: [],
      implementation_complete: true,
      git: { diff_check: { command: 'git diff --check', status: 'passed' } },
      environment: { cwd: repo, platform: process.platform, runtime: process.version },
      exit_code: 0,
    };
    const adapter: WorkerAdapter = {
      id: 'structured-adapter',
      async probe() {},
      async execute(_context: AdapterContext) {
        return workerResult;
      },
    };
    const run = await delegateTask(opened.store, snapshot(repo), task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'structured-runner',
      adapter,
    });
    expect(run.status).toBe('completed');
    const stored = opened.store.getTask(task.id)?.result as typeof implResult & {
      implementation_complete?: boolean;
      git?: { diff_check?: { status: string }; head?: string };
      evidence?: { runner_observed?: { git?: { head?: string } }; worker_reported?: { git?: { diff_check?: { status?: string } } } };
      environment?: { cwd?: string };
      validation: Array<{ summary?: string; counts?: { passed?: number } }>;
    };
    expect(stored.implementation_complete).toBe(true);
    expect(stored.validation[0]?.summary).toBe('8 passed');
    expect(stored.validation[0]?.counts?.passed).toBe(8);
    expect(stored.git?.diff_check?.status).toBe('passed');
    expect(stored.git?.head).toBeUndefined();
    expect(stored.evidence?.worker_reported?.git?.diff_check?.status).toBe('passed');
    expect(stored.evidence?.runner_observed?.git?.head).toBe(snapshot(repo).head);
    expect(stored.environment?.cwd).toBe(repo);
  });

  it('preserves a delegation adapter validation-environment blocker', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: implPayload,
    });
    const adapter: WorkerAdapter = {
      id: 'blocked-evidence-adapter',
      async probe() {},
      async execute() {
        return {
          outcome: 'blocked',
          summary: 'Implementation complete; full suite lacks external path permission',
          changed_files: [],
          validation: [
            { command: 'npm run focused', status: 'passed', summary: '20 passed' },
            { command: 'npm test', status: 'failed', summary: 'EACCES outside repository' },
          ],
          known_limitations: [],
          blocker_classification: 'VALIDATION_ENVIRONMENT',
          implementation_complete: true,
          git: { diff_check: { command: 'git diff --check', status: 'passed' } },
          environment: { cwd: repo, platform: process.platform },
          blocked_reason: 'External validation path is not readable',
          exit_code: 1,
        } satisfies WorkerResult;
      },
    };
    const run = await delegateTask(opened.store, snapshot(repo), task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'blocked-evidence-runner',
      adapter,
    });
    expect(run.status).toBe('blocked');
    const blocker = opened.store.getTask(task.id)?.blocker;
    expect(blocker?.reason).toBe('VALIDATION_ENVIRONMENT');
    expect(blocker?.implementation_complete).toBe(true);
    expect(blocker?.validation?.map((item) => item.status)).toEqual(['passed', 'failed']);
    expect(blocker?.git?.diff_check?.status).toBe('passed');
    expect(blocker?.git?.working_tree_status).toBeUndefined();
    expect(blocker?.evidence?.runner_observed?.git.working_tree_status.clean).toBe(true);
    expect(blocker?.environment?.cwd).toBe(repo);
  });

  it('keeps code/test and validation-environment blocker classifications distinct', () => {
    expect(
      ewpResultSchema.parse({
        protocol: 'engineering-worker/1',
        outcome: 'blocked',
        summary: 'assertion failed',
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocker_classification: 'TEST_FAILURE',
        exit_code: 1,
      }).blocker_classification,
    ).toBe('TEST_FAILURE');
    expect(
      ewpResultSchema.parse({
        protocol: 'engineering-worker/1',
        outcome: 'blocked',
        summary: 'runner lacks permission',
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocker_classification: 'VALIDATION_ENVIRONMENT',
        exit_code: 1,
      }).blocker_classification,
    ).toBe('VALIDATION_ENVIRONMENT');
  });

  it('lets authoritative Runner scope classification override a conflicting worker classification', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: { ...implPayload, allowed_scope: ['src/store.ts'], forbidden_scope: ['outside.txt'] },
    });
    const adapter: WorkerAdapter = {
      id: 'conflicting-classification',
      async probe() {},
      async execute() {
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        writeFileSync(join(repo, 'outside.txt'), 'scope violation\n');
        return {
          outcome: 'completed',
          summary: 'worker calls this a test failure',
          changed_files: [],
          validation: [],
          known_limitations: [],
          blocker_classification: 'TEST_FAILURE',
          exit_code: 0,
        } satisfies WorkerResult;
      },
    };
    await delegateTask(opened.store, snapshot(repo), task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'scope-authority',
      adapter,
    });
    const blocker = opened.store.getTask(task.id)?.blocker;
    expect(blocker?.reason).toBe('SCOPE_CONFLICT');
    expect(blocker?.evidence?.worker_reported?.blocker_classification).toBe('TEST_FAILURE');
    expect(blocker?.evidence?.runner_observed?.scope).toEqual({ status: 'failed', rejected_files: ['outside.txt'] });
  });

  it('does not let an already-blocked worker hide a Runner-observed scope violation', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const task = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload: { ...implPayload, allowed_scope: ['src/store.ts'], forbidden_scope: ['outside.txt'] },
    });
    const adapter: WorkerAdapter = {
      id: 'blocked-conflicting-classification',
      async probe() {},
      async execute() {
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        writeFileSync(join(repo, 'outside.txt'), 'scope violation\n');
        return {
          outcome: 'blocked',
          summary: 'worker calls this a test failure',
          changed_files: [],
          validation: [],
          known_limitations: [],
          blocker_classification: 'TEST_FAILURE',
          blocked_reason: 'tests failed',
          exit_code: 1,
        } satisfies WorkerResult;
      },
    };
    await delegateTask(opened.store, snapshot(repo), task.id, task.revision, {
      adapterId: adapter.id,
      inProcess: true,
      executionInstanceId: 'blocked-scope-authority',
      adapter,
    });

    const blocker = opened.store.getTask(task.id)?.blocker;
    expect(blocker?.reason).toBe('SCOPE_CONFLICT');
    expect(blocker?.evidence?.worker_reported?.blocker_classification).toBe('TEST_FAILURE');
    expect(blocker?.evidence?.runner_observed?.scope).toEqual({ status: 'failed', rejected_files: ['outside.txt'] });
  });
});
