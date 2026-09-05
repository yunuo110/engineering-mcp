import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/lifecycle.ts';
import { delegateTask } from '../src/orchestration/dispatcher.ts';
import type { Store } from '../src/store.ts';
import { initGitRepo, openTempStore, removeDir, snapshot, tempDir } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  // Allow spawned worker-runner child processes to fully release the store/repo handles.
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const harnessScript = fileURLToPath(new URL('./fixtures/generic-harness.cjs', import.meta.url));

function testStore(repo: string): Store {
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  return opened.store;
}

function manifestPath(mode: string): string {
  const dir = tempDir('eng-mcp-generic-manifest-');
  dirs.push(dir);
  const path = `${dir}/generic-harness.yaml`;
  writeFileSync(path, `
schema: engineering-cli-adapter/1
id: generic-fixture
name: Generic Fixture
adapter: generic-cli
command: ${JSON.stringify(process.execPath)}
arguments:
  - ${JSON.stringify(harnessScript)}
  - --mode
  - ${mode}
working_directory: "\${repo_root}"
protocol_mode: native
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes:
    - 0
`, 'utf8');
  return path;
}

describe('Generic CLI Harness real orchestration integration', () => {
  it('runs a real Worker Runner to a generic fake harness and completes', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'Create hello.txt with exact content hello from generic harness',
        parent_intent: 'V1.7-A integration',
        allowed_scope: ['hello.txt'],
        forbidden_scope: [],
        acceptance_criteria: ['hello.txt exists'],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });

    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'generic-cli',
      manifestPath: manifestPath('completed'),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('completed');
    expect(db.getTask(task.id)?.status).toBe('COMPLETED');
    // eslint-disable-next-line no-undef
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.readFileSync(`${repo}/hello.txt`, 'utf8')).toBe('hello from generic harness\n');
    expect(snapshot(repo).head).toBe(git.head);
    expect(snapshot(repo).porcelain).toBe('?? hello.txt');
  });

  it('blocks when worker lies about changed files', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'Create hello.txt',
        parent_intent: 'adversarial',
        allowed_scope: ['hello.txt'],
        forbidden_scope: [],
        acceptance_criteria: [],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'generic-cli',
      manifestPath: manifestPath('lie'),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('SCOPE_VIOLATION');
    expect(db.getTask(task.id)?.status).toBe('BLOCKED');
  });

  it('blocks on forbidden scope through generic worker', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'Create src file',
        parent_intent: 'adversarial',
        allowed_scope: ['src'],
        forbidden_scope: ['src/secret.ts'],
        acceptance_criteria: [],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'generic-cli',
      manifestPath: manifestPath('forbidden'),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('SCOPE_VIOLATION');
  });

  it('blocks on HEAD movement by generic worker', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'Create hello.txt',
        parent_intent: 'adversarial',
        allowed_scope: ['hello.txt'],
        forbidden_scope: [],
        acceptance_criteria: [],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'generic-cli',
      manifestPath: manifestPath('head-change'),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('UNEXPECTED_HEAD_CHANGE');
    expect(snapshot(repo).head).not.toBe(git.head);
  });

  it('blocks on malformed EWP result', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'Create hello.txt',
        parent_intent: 'adversarial',
        allowed_scope: ['hello.txt'],
        forbidden_scope: [],
        acceptance_criteria: [],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'generic-cli',
      manifestPath: manifestPath('malformed'),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('blocked');
    expect(run.error_code).toBe('WORKER_PROTOCOL_FAILURE');
  });

  it('fails closed on unknown adapter id', async () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const db = testStore(repo);
    const git = snapshot(repo);
    const task = createTask(db, git, {
      type: 'IMPLEMENTATION',
      payload: {
        goal: 'No-op',
        parent_intent: 'adversarial',
        allowed_scope: [],
        forbidden_scope: [],
        acceptance_criteria: [],
        validation_requirements: [],
        context_files: [],
        knowledge_refs: [],
        parent_risk: 'L1',
      },
    });
    const run = await delegateTask(db, git, task.id, task.revision, {
      adapterId: 'does-not-exist',
      timeoutMs: 30_000,
    });
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('WORKER_PROCESS_FAILED');
    expect(db.getTask(task.id)?.status).toBe('READY');
  });
});
