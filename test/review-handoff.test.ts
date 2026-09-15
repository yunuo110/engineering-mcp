import { writeFileSync } from 'node:fs';
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
import {
  diagnosisPayload,
  extraCommit,
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

function implementationFixture(outcome: 'COMPLETED' | 'BLOCKED') {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  dirs.push(opened.dir);
  stores.push(opened.store);
  const payload = { ...implPayload, allowed_scope: ['output.txt'], forbidden_scope: [], context_files: [] };
  const created = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload });
  const running = claimTask(opened.store, snapshot(repo), 'JUNIOR', 'producer', created.id, created.revision);
  writeFileSync(join(repo, 'output.txt'), 'review output\n');
  const terminal = outcome === 'COMPLETED'
    ? reportResult(opened.store, 'JUNIOR', 'producer', {
        task_id: running.id,
        revision: running.revision,
        outcome: 'completed',
        result: { ...implResult, changed_files: ['output.txt'], working_tree_status: { clean: false, porcelain: '?? output.txt' } },
      })
    : reportBlocked(opened.store, 'JUNIOR', 'producer', {
        task_id: running.id,
        revision: running.revision,
        blocker: { reason: 'OTHER', summary: 'blocked', need_from_owner: 'checkpoint', evidence_refs: [], changed_files: ['output.txt'] },
      });
  return { repo, store: opened.store, dbPath: opened.store.path, terminal };
}

describe('authoritative REVIEW handoff', () => {
  it('binds DIAGNOSIS and principal-visible task identity to the finalized REVIEW checkpoint', () => {
    const fixture = implementationFixture('COMPLETED');
    const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: fixture.terminal.id, revision: fixture.terminal.revision, purpose: 'REVIEW',
    });
    const diagnosis = createDiagnosisFromCheckpoint(fixture.store, snapshot(fixture.repo), {
      producer_task_id: fixture.terminal.id,
      producer_revision: fixture.terminal.revision,
      checkpoint_id: saved.checkpoint.id,
      payload: diagnosisPayload,
    });
    expect(diagnosis.base_commit).toBe(saved.checkpoint.checkpoint_commit);
    expect(diagnosis.source_checkpoint).toEqual({
      checkpoint_id: saved.checkpoint.id,
      producer_task_id: fixture.terminal.id,
      producer_revision: fixture.terminal.revision,
      checkpoint_commit: saved.checkpoint.checkpoint_commit,
      checkpoint_ref: saved.checkpoint.checkpoint_ref,
      prior_base_commit: saved.checkpoint.prior_base_commit,
    });
    const claimed = claimTask(fixture.store, snapshot(fixture.repo), 'PRINCIPAL', 'reviewer', diagnosis.id, diagnosis.revision);
    expect(claimed.source_checkpoint).toEqual(diagnosis.source_checkpoint);
  });

  it('rejects HEAD drift and producer/checkpoint/revision substitution', () => {
    const fixture = implementationFixture('COMPLETED');
    const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: fixture.terminal.id, revision: fixture.terminal.revision, purpose: 'REVIEW',
    });
    extraCommit(fixture.repo, 'later.txt');
    expect(() => createDiagnosisFromCheckpoint(fixture.store, snapshot(fixture.repo), {
      producer_task_id: fixture.terminal.id,
      producer_revision: fixture.terminal.revision,
      checkpoint_id: saved.checkpoint.id,
      payload: diagnosisPayload,
    })).toThrow(/checkpoint|HEAD/i);
    expect(() => createDiagnosisFromCheckpoint(fixture.store, snapshot(fixture.repo), {
      producer_task_id: 'wrong-task',
      producer_revision: fixture.terminal.revision + 1,
      checkpoint_id: saved.checkpoint.id,
      payload: diagnosisPayload,
    })).toThrow(/checkpoint/i);
  });

  it('enforces purpose semantics for BLOCKED, resume, and diagnosis handoff', () => {
    const blockedFixture = implementationFixture('BLOCKED');
    expect(() => checkpointTask(blockedFixture.store, snapshot(blockedFixture.repo), {
      task_id: blockedFixture.terminal.id, revision: blockedFixture.terminal.revision, purpose: 'REVIEW',
    })).toThrow(/purpose|Checkpoint/i);
    const resumeCheckpoint = checkpointTask(blockedFixture.store, snapshot(blockedFixture.repo), {
      task_id: blockedFixture.terminal.id, revision: blockedFixture.terminal.revision, purpose: 'RESUME',
    });
    expect(() => createDiagnosisFromCheckpoint(blockedFixture.store, snapshot(blockedFixture.repo), {
      producer_task_id: blockedFixture.terminal.id,
      producer_revision: blockedFixture.terminal.revision,
      checkpoint_id: resumeCheckpoint.checkpoint.id,
      payload: diagnosisPayload,
    })).toThrow(/checkpoint/i);

    const completedFixture = implementationFixture('COMPLETED');
    const reviewCheckpoint = checkpointTask(completedFixture.store, snapshot(completedFixture.repo), {
      task_id: completedFixture.terminal.id, revision: completedFixture.terminal.revision, purpose: 'REVIEW',
    });
    expect(() => resumeTask(completedFixture.store, snapshot(completedFixture.repo), {
      task_id: completedFixture.terminal.id, revision: reviewCheckpoint.task.revision,
    })).toThrow(/REVIEW checkpoint/);
  });

  it('persists the diagnosis linkage across restart', () => {
    const fixture = implementationFixture('COMPLETED');
    const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: fixture.terminal.id, revision: fixture.terminal.revision, purpose: 'REVIEW',
    });
    const diagnosis = createDiagnosisFromCheckpoint(fixture.store, snapshot(fixture.repo), {
      producer_task_id: fixture.terminal.id,
      producer_revision: fixture.terminal.revision,
      checkpoint_id: saved.checkpoint.id,
      payload: diagnosisPayload,
    });
    fixture.store.close();
    stores.splice(stores.indexOf(fixture.store), 1);
    const reopened = Store.open(fixture.dbPath, { repoRoot: fixture.repo });
    stores.push(reopened);
    expect(reopened.getTask(diagnosis.id)?.source_checkpoint).toEqual(diagnosis.source_checkpoint);
  });
});
