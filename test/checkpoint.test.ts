import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkpointTask,
  claimTask,
  createDiagnosisFromCheckpoint,
  createTask,
  reportBlocked,
  reportResult,
  resumeTask,
} from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import type { ImplementationPayload, TaskContract } from '../src/types.ts';
import {
  diagnosisPayload,
  diagnosisResult,
  expectDomain,
  git,
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

function setup(): {
  repo: string;
  store: Store;
  dbPath: string;
  payload: ImplementationPayload;
  running: TaskContract;
} {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  const payload = {
    ...implPayload,
    allowed_scope: ['output.txt'],
    forbidden_scope: ['private.txt'],
    context_files: [],
  };
  const created = createTask(opened.store, snapshot(repo), {
    type: 'IMPLEMENTATION',
    payload,
  });
  const running = claimTask(
    opened.store,
    snapshot(repo),
    'JUNIOR',
    'producer-one',
    created.id,
    created.revision,
  );
  return {
    repo,
    store: opened.store,
    dbPath: join(opened.dir, 'ledger.sqlite'),
    payload,
    running,
  };
}

function block(store: Store, running: TaskContract): TaskContract {
  return reportBlocked(store, 'JUNIOR', 'producer-one', {
    task_id: running.id,
    revision: running.revision,
    blocker: {
      reason: 'VALIDATION_ENVIRONMENT',
      summary: 'Full validation cannot access an external fixture path',
      need_from_owner: 'Checkpoint the completed implementation and validate in the owner environment.',
      evidence_refs: [],
      implementation_complete: true,
      changed_files: ['output.txt'],
      validation: [
        { command: 'npm test', status: 'failed', summary: 'Permission denied outside repository' },
      ],
    },
  });
}

describe('immutable lifecycle checkpoints', () => {
  it('checkpoints BLOCKED dirty output and resumes it for takeover', () => {
    const fixture = setup();
    writeFileSync(join(fixture.repo, 'output.txt'), 'valuable output\n');
    const blocked = block(fixture.store, fixture.running);

    const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: blocked.id,
      revision: blocked.revision,
      purpose: 'RESUME',
    });

    expect(saved.task.status).toBe('BLOCKED');
    expect(saved.task.base_commit).toBe(saved.checkpoint.checkpoint_commit);
    expect(saved.checkpoint.prior_base_commit).toBe(fixture.running.base_commit);
    expect(saved.checkpoint.producer_revision).toBe(blocked.revision);
    expect(saved.checkpoint.changed_files).toEqual(['output.txt']);
    expect(git(fixture.repo, ['show-ref', '--verify', '--hash', saved.checkpoint.checkpoint_ref])).toBe(
      saved.checkpoint.checkpoint_commit,
    );
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(saved.checkpoint.checkpoint_commit);
    expect(git(fixture.repo, ['rev-parse', 'HEAD^'])).toBe(fixture.running.base_commit);
    expect(git(fixture.repo, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.repo, ['show', 'HEAD:output.txt'])).toBe('valuable output');
    expect(readFileSync(join(fixture.repo, 'output.txt'), 'utf8')).toBe('valuable output\n');
    expect(fixture.store.listCheckpoints(blocked.id)).toEqual([saved.checkpoint]);
    expect(fixture.store.listEvents(blocked.id).at(-1)?.kind).toBe('checkpointed');

    const resumed = resumeTask(fixture.store, snapshot(fixture.repo), {
      task_id: saved.task.id,
      revision: saved.task.revision,
    });
    const takeover = claimTask(
      fixture.store,
      snapshot(fixture.repo),
      'JUNIOR',
      'producer-two',
      resumed.id,
      resumed.revision,
    );
    expect(takeover.status).toBe('RUNNING');
    expect(takeover.base_commit).toBe(saved.checkpoint.checkpoint_commit);
  });

  it('turns completed implementation output into an immutable diagnosis baseline', () => {
    const fixture = setup();
    writeFileSync(join(fixture.repo, 'output.txt'), 'review this\n');
    const completed = reportResult(fixture.store, 'JUNIOR', 'producer-one', {
      task_id: fixture.running.id,
      revision: fixture.running.revision,
      outcome: 'completed',
      result: {
        ...implResult,
        changed_files: ['output.txt'],
        working_tree_status: { clean: false, porcelain: '?? output.txt' },
      },
    });
    const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: completed.id,
      revision: completed.revision,
      purpose: 'REVIEW',
    });
    const review = createDiagnosisFromCheckpoint(fixture.store, snapshot(fixture.repo), {
      producer_task_id: completed.id,
      producer_revision: completed.revision,
      checkpoint_id: saved.checkpoint.id,
      payload: diagnosisPayload,
    });
    expect(review.base_commit).toBe(saved.checkpoint.checkpoint_commit);
    expect(review.branch).toBe(saved.checkpoint.branch);
    expect(review.source_checkpoint?.producer_task_id).toBe(completed.id);
    expect(
      claimTask(
        fixture.store,
        snapshot(fixture.repo),
        'PRINCIPAL',
        'reviewer',
        review.id,
        review.revision,
      ).status,
    ).toBe('RUNNING');
  });

  it('rejects unrelated dirty work before creating a checkpoint object', () => {
    const fixture = setup();
    writeFileSync(join(fixture.repo, 'output.txt'), 'task output\n');
    writeFileSync(join(fixture.repo, 'unrelated.txt'), 'owner work\n');
    const blocked = block(fixture.store, fixture.running);
    const headBefore = git(fixture.repo, ['rev-parse', 'HEAD']);

    expectDomain(
      () =>
        checkpointTask(fixture.store, snapshot(fixture.repo), {
          task_id: blocked.id,
          revision: blocked.revision,
          purpose: 'RESUME',
        }),
      'CHECKPOINT_SCOPE_CONFLICT',
    );
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(readFileSync(join(fixture.repo, 'output.txt'), 'utf8')).toBe('task output\n');
    expect(readFileSync(join(fixture.repo, 'unrelated.txt'), 'utf8')).toBe('owner work\n');
    expect(fixture.store.listCheckpoints(blocked.id)).toEqual([]);
    expect(fixture.store.getTask(blocked.id)?.revision).toBe(blocked.revision);
  });

  it('persists checkpoint provenance across a Store restart', () => {
    const fixture = setup();
    writeFileSync(join(fixture.repo, 'output.txt'), 'restart-safe\n');
    const blocked = block(fixture.store, fixture.running);
    const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: blocked.id,
      revision: blocked.revision,
      purpose: 'RESUME',
    });
    fixture.store.close();
    stores.splice(stores.indexOf(fixture.store), 1);

    const reopened = Store.open(fixture.dbPath, { repoRoot: fixture.repo });
    stores.push(reopened);
    expect(reopened.listCheckpoints(blocked.id)).toEqual([saved.checkpoint]);
    expect(reopened.getTask(blocked.id)?.base_commit).toBe(saved.checkpoint.checkpoint_commit);
  });

  it('retries from a durable intent after process loss during Git application', () => {
    const fixture = setup();
    writeFileSync(join(fixture.repo, 'output.txt'), 'survived process loss\n');
    const blocked = block(fixture.store, fixture.running);
    expect(() =>
      checkpointTask(fixture.store, snapshot(fixture.repo), {
        task_id: blocked.id,
        revision: blocked.revision,
        purpose: 'RESUME',
      }, { onStage(stage) { if (stage === 'after_checkpoint_ref') throw new Error('simulated crash'); } }),
    ).toThrow('simulated crash');
    expect(fixture.store.getTask(blocked.id)?.base_commit).toBe(blocked.base_commit);
    expectDomain(
      () =>
        resumeTask(fixture.store, snapshot(fixture.repo), {
          task_id: blocked.id,
          revision: blocked.revision,
        }),
      'CHECKPOINT_FINALIZATION_REQUIRED',
    );

    const recovered = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: blocked.id,
      revision: blocked.revision,
      purpose: 'RESUME',
    });
    expect(recovered.task.base_commit).toBe(recovered.checkpoint.checkpoint_commit);
    expect(snapshot(fixture.repo).clean).toBe(true);
  });

  it('rejects READY and clean terminal checkpoints', () => {
    const fixture = setup();
    const blocked = block(fixture.store, fixture.running);
    expectDomain(
      () =>
        checkpointTask(fixture.store, snapshot(fixture.repo), {
          task_id: blocked.id,
          revision: blocked.revision,
          purpose: 'RESUME',
        }),
      'CHECKPOINT_NOTHING_TO_SAVE',
    );
    const resumed = resumeTask(fixture.store, snapshot(fixture.repo), {
      task_id: blocked.id,
      revision: blocked.revision,
    });
    writeFileSync(join(fixture.repo, 'output.txt'), 'not legal while ready\n');
    expectDomain(
      () =>
        checkpointTask(fixture.store, snapshot(fixture.repo), {
          task_id: resumed.id,
          revision: resumed.revision,
          purpose: 'RESUME',
        }),
      'INVALID_CHECKPOINT_STATE',
    );
  });

  it('cannot checkpoint through an active writer slot', () => {
    const fixture = setup();
    const blocked = block(fixture.store, fixture.running);
    const other = createTask(fixture.store, snapshot(fixture.repo), {
      type: 'IMPLEMENTATION',
      payload: fixture.payload,
    });
    claimTask(
      fixture.store,
      snapshot(fixture.repo),
      'JUNIOR',
      'active-writer',
      other.id,
      other.revision,
    );
    writeFileSync(join(fixture.repo, 'output.txt'), 'late output from old worker\n');
    expectDomain(
      () =>
        checkpointTask(fixture.store, snapshot(fixture.repo), {
          task_id: blocked.id,
          revision: blocked.revision,
          purpose: 'RESUME',
        }),
      'TASK_ALREADY_RUNNING',
    );
    expect(fixture.store.listCheckpoints(blocked.id)).toEqual([]);
  });

  it('never checkpoints diagnosis output', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const created = createTask(opened.store, snapshot(repo), {
      type: 'DIAGNOSIS',
      payload: diagnosisPayload,
    });
    const running = claimTask(
      opened.store,
      snapshot(repo),
      'PRINCIPAL',
      'diagnosis-worker',
      created.id,
      created.revision,
    );
    const completed = reportResult(opened.store, 'PRINCIPAL', 'diagnosis-worker', {
      task_id: running.id,
      revision: running.revision,
      outcome: 'completed',
      result: diagnosisResult,
    });
    writeFileSync(join(repo, 'README.md'), 'diagnosis should not write\n');
    expectDomain(
      () =>
        checkpointTask(opened.store, snapshot(repo), {
          task_id: completed.id,
          revision: completed.revision,
          purpose: 'REVIEW',
        }),
      'INVALID_CHECKPOINT_STATE',
    );
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(completed.base_commit);
  });

  it('fails before mutation when Git cannot capture nested repository dirt', () => {
    const child = initGitRepo();
    const repo = initGitRepo();
    dirs.push(repo, child);
    writeFileSync(join(child, 'child.txt'), 'base\n');
    git(child, ['add', 'child.txt']);
    git(child, ['commit', '-m', 'child base']);
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor']);
    git(repo, ['commit', '-am', 'add child']);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const payload = { ...implPayload, allowed_scope: ['vendor'], forbidden_scope: [] };
    const created = createTask(opened.store, snapshot(repo), {
      type: 'IMPLEMENTATION',
      payload,
    });
    const running = claimTask(
      opened.store,
      snapshot(repo),
      'JUNIOR',
      'nested-writer',
      created.id,
      created.revision,
    );
    writeFileSync(join(repo, 'vendor', 'child.txt'), 'dirty nested content\n');
    const blocked = reportBlocked(opened.store, 'JUNIOR', 'nested-writer', {
      task_id: running.id,
      revision: running.revision,
      blocker: {
        reason: 'OTHER',
        summary: 'Nested worktree is dirty',
        need_from_owner: 'Preserve the nested repository separately.',
        evidence_refs: [],
      },
    });
    const head = git(repo, ['rev-parse', 'HEAD']);
    expectDomain(
      () =>
        checkpointTask(opened.store, snapshot(repo), {
          task_id: blocked.id,
          revision: blocked.revision,
          purpose: 'RESUME',
        }),
      'CHECKPOINT_UNCAPTURED_CHANGES',
    );
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(repo, 'vendor', 'child.txt'), 'utf8')).toBe('dirty nested content\n');
    expect(opened.store.listCheckpoints(blocked.id)).toEqual([]);
  });

  it('rejects a clean untracked nested repository before any checkpoint side effect', () => {
    const fixture = setup();
    const nested = join(fixture.repo, 'vendor');
    git(fixture.repo, ['init', 'vendor']);
    git(nested, ['config', 'user.email', 'nested@example.com']);
    git(nested, ['config', 'user.name', 'Nested']);
    writeFileSync(join(nested, 'nested.txt'), 'nested value\n');
    git(nested, ['add', 'nested.txt']);
    git(nested, ['commit', '-m', 'nested base']);
    const blocked = block(fixture.store, fixture.running);
    const head = git(fixture.repo, ['rev-parse', 'HEAD']);

    expectDomain(() => checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: blocked.id, revision: blocked.revision, purpose: 'RESUME',
    }), 'CHECKPOINT_UNSAFE_GITLINK');
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(() => git(fixture.repo, ['show-ref', '--verify', `refs/engineering-mcp/checkpoints/${blocked.id}/${blocked.revision}`])).toThrow();
    expect(fixture.store.getCheckpointForRevision(blocked.id, blocked.revision)).toBeUndefined();
    expect(readFileSync(join(nested, 'nested.txt'), 'utf8')).toBe('nested value\n');
  });

  it('rejects a clean submodule HEAD advance and a removed gitlink', () => {
    for (const mutation of ['advance', 'remove'] as const) {
      const child = initGitRepo();
      const repo = initGitRepo();
      dirs.push(child, repo);
      git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor']);
      git(repo, ['commit', '-am', 'add submodule']);
      const opened = openTempStore(repo);
      stores.push(opened.store);
      dirs.push(opened.dir);
      const payload = { ...implPayload, allowed_scope: ['vendor'], forbidden_scope: [], context_files: [] };
      const created = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload });
      const running = claimTask(opened.store, snapshot(repo), 'JUNIOR', `gitlink-${mutation}`, created.id, created.revision);
      if (mutation === 'advance') {
        writeFileSync(join(repo, 'vendor', 'next.txt'), 'next\n');
        git(join(repo, 'vendor'), ['add', 'next.txt']);
        git(join(repo, 'vendor'), ['commit', '-m', 'advance']);
      } else {
        rmSync(join(repo, 'vendor'), { recursive: true, force: true });
      }
      const blocked = reportBlocked(opened.store, 'JUNIOR', `gitlink-${mutation}`, {
        task_id: running.id,
        revision: running.revision,
        blocker: { reason: 'OTHER', summary: 'gitlink changed', need_from_owner: 'checkpoint', evidence_refs: [] },
      });
      const head = git(repo, ['rev-parse', 'HEAD']);
      expectDomain(() => checkpointTask(opened.store, snapshot(repo), {
        task_id: blocked.id, revision: blocked.revision, purpose: 'RESUME',
      }), 'CHECKPOINT_UNSAFE_GITLINK');
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(() => git(repo, ['show-ref', '--verify', `refs/engineering-mcp/checkpoints/${blocked.id}/${blocked.revision}`])).toThrow();
      expect(opened.store.getCheckpointForRevision(blocked.id, blocked.revision)).toBeUndefined();
      if (mutation === 'advance') {
        expect(readFileSync(join(repo, 'vendor', 'next.txt'), 'utf8')).toBe('next\n');
      }
    }
  });

  it('preserves an unchanged existing gitlink while checkpointing an unrelated parent file', () => {
    const child = initGitRepo();
    const repo = initGitRepo();
    dirs.push(child, repo);
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor']);
    git(repo, ['commit', '-am', 'add submodule']);
    const gitlink = git(repo, ['rev-parse', 'HEAD:vendor']);
    const opened = openTempStore(repo);
    stores.push(opened.store);
    dirs.push(opened.dir);
    const payload = { ...implPayload, allowed_scope: ['output.txt'], forbidden_scope: [], context_files: [] };
    const created = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload });
    const running = claimTask(opened.store, snapshot(repo), 'JUNIOR', 'parent-writer', created.id, created.revision);
    writeFileSync(join(repo, 'output.txt'), 'parent output\n');
    const blocked = reportBlocked(opened.store, 'JUNIOR', 'parent-writer', {
      task_id: running.id,
      revision: running.revision,
      blocker: { reason: 'OTHER', summary: 'done', need_from_owner: 'checkpoint', evidence_refs: [], changed_files: ['output.txt'] },
    });
    const saved = checkpointTask(opened.store, snapshot(repo), {
      task_id: blocked.id, revision: blocked.revision, purpose: 'RESUME',
    });
    expect(git(repo, ['rev-parse', `${saved.checkpoint.checkpoint_commit}:vendor`])).toBe(gitlink);
  });
});
