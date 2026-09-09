import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cancelTask, createTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import { GenericCliAdapter } from '../src/adapters/generic-cli-adapter.ts';
import { cliAdapterManifestSchema } from '../src/adapters/manifest.ts';
import type { Store } from '../src/store.ts';
import { git, implPayload, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function setup() {
  const repo = initGitRepo();
  dirs.push(repo);
  const { store, dir } = openTempStore(repo);
  stores.push(store);
  dirs.push(dir);
  return { repo, store };
}

const completed = {
  outcome: 'completed' as const, summary: 'done', changed_files: [],
  validation: [], known_limitations: [], exit_code: 0,
};

describe('release campaign: independent Git scope verification', () => {
  it.each(['README.md', 'space name.txt', '中文.txt'])('accepts tracked modification of allowed %s and records observed files', async (file) => {
    const { repo, store } = setup();
    writeFileSync(join(repo, file), 'before\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'baseline']);
    const gitBefore = snapshot(repo);
    const task = createTask(store, gitBefore, { type: 'IMPLEMENTATION', payload: { ...implPayload, allowed_scope: [file], forbidden_scope: [] } });
    const run = await delegateTask(store, gitBefore, task.id, task.revision, {
      adapterId: 'scope-reproduction', inProcess: true, executionInstanceId: 'scope-runner',
      adapter: { id: 'scope-reproduction', async probe() {}, async execute() {
        writeFileSync(join(repo, file), 'after\n');
        return { ...completed };
      } },
    });
    expect(run.status).toBe('completed');
    expect(store.getTask(task.id)?.result).toMatchObject({ changed_files: [file] });
  });

  it('does not strip a forbidden tracked filename into an allowed filename', async () => {
    const { repo, store } = setup();
    const gitBefore = snapshot(repo);
    const task = createTask(store, gitBefore, { type: 'IMPLEMENTATION', payload: { ...implPayload, allowed_scope: ['EADME.md'], forbidden_scope: ['README.md'] } });
    const run = await delegateTask(store, gitBefore, task.id, task.revision, {
      adapterId: 'scope-reproduction', inProcess: true, executionInstanceId: 'scope-runner',
      adapter: { id: 'scope-reproduction', async probe() {}, async execute() {
        writeFileSync(join(repo, 'README.md'), 'forbidden mutation\n');
        return { ...completed };
      } },
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('SCOPE_VIOLATION');
  });

  it('checks both paths of a staged rename', async () => {
    const { repo, store } = setup();
    mkdirSync(join(repo, 'allowed'));
    const gitBefore = snapshot(repo);
    const task = createTask(store, gitBefore, { type: 'IMPLEMENTATION', payload: { ...implPayload, allowed_scope: ['allowed'], forbidden_scope: ['README.md'] } });
    const run = await delegateTask(store, gitBefore, task.id, task.revision, {
      adapterId: 'scope-reproduction', inProcess: true, executionInstanceId: 'scope-runner',
      adapter: { id: 'scope-reproduction', async probe() {}, async execute() {
        renameSync(join(repo, 'README.md'), join(repo, 'allowed', 'renamed.md'));
        git(repo, ['add', '-A']);
        return { ...completed };
      } },
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('SCOPE_VIOLATION');
  });
});

describe('release campaign: real process exit authority', () => {
  it.each([0, 7])('valid EWP completion cannot override unsuccessful process exit %s', async (exitCode) => {
    const { repo, store } = setup();
    const task = createTask(store, snapshot(repo), { type: 'IMPLEMENTATION', payload: implPayload });
    const wireResult = { protocol: 'engineering-worker/1', ...completed };
    const adapter = new GenericCliAdapter(cliAdapterManifestSchema.parse({
      schema: 'engineering-cli-adapter/1', id: 'exit-reproduction', name: 'Exit reproduction', adapter: 'generic-cli',
      command: process.execPath,
      arguments: ['-e', `process.stdin.resume(); process.stdin.on('end', () => { console.log(${JSON.stringify(JSON.stringify(wireResult))}); process.exitCode = ${exitCode}; });`],
      working_directory: '${repo_root}', prompt: { transport: 'stdin', format: 'engineering-worker/1' },
      result: { source: 'stdout', format: 'json', strategy: 'last-json-object' },
      process: { shell: false, success_exit_codes: [0] },
    }));
    const result = await adapter.execute({ dispatchRunId: task.id, taskId: task.id, repositoryRoot: repo, baseCommit: task.base_commit, task });
    expect(result.exit_code).toBe(exitCode);
    expect(result.outcome).toBe(exitCode === 0 ? 'completed' : 'blocked');
    if (exitCode !== 0) expect(result.blocked_reason).toBe('WORKER_PROCESS_FAILED');
  });
});

it('preserves OWNER cancellation when an already-running adapter returns late', async () => {
  const { repo, store } = setup();
  const before = snapshot(repo);
  const task = createTask(store, before, { type: 'IMPLEMENTATION', payload: implPayload });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = delegateTask(store, before, task.id, task.revision, {
    adapterId: 'late-worker', inProcess: true, executionInstanceId: 'late-runner',
    adapter: { id: 'late-worker', async probe() {}, async execute() {
      await gate;
      // Cancellation fences ledger writes; it does not revoke OS file access.
      writeFileSync(join(repo, 'late-write.txt'), 'worker still has filesystem access\n');
      return { ...completed };
    } },
  });
  const rejected = expect(pending).rejects.toThrow();
  const running = store.getTask(task.id)!;
  cancelTask(store, task.id, running.revision, 'release cancellation');
  const cancelledDispatch = store.listDispatchRunsForTask(task.id)[0];
  release();
  await rejected;
  expect(store.getTask(task.id)?.status).toBe('CANCELLED');
  expect(store.listDispatchRunsForTask(task.id)[0]).toEqual(cancelledDispatch);
});
