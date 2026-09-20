import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelTask,
  checkpointTask,
  claimTask,
  closeTask,
  createTask,
  reportBlocked,
  reportResult,
  recoverTask,
  resumeTask,
  type CheckpointFailureStage,
} from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';
import { WRITER_PROTOCOL_GENERATION } from '../src/types.ts';
import { git, implPayload, implResult, initGitRepo, openTempStore, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function blockedFixture() {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  dirs.push(opened.dir);
  stores.push(opened.store);
  const payload = { ...implPayload, allowed_scope: ['output.txt'], forbidden_scope: [], context_files: [] };
  const created = createTask(opened.store, snapshot(repo), { type: 'IMPLEMENTATION', payload });
  const running = claimTask(opened.store, snapshot(repo), 'JUNIOR', 'writer', created.id, created.revision);
  writeFileSync(join(repo, 'output.txt'), 'recoverable\n');
  const blocked = reportBlocked(opened.store, 'JUNIOR', 'writer', {
    task_id: running.id,
    revision: running.revision,
    blocker: {
      reason: 'VALIDATION_ENVIRONMENT',
      summary: 'environment blocked',
      need_from_owner: 'checkpoint',
      evidence_refs: [],
      changed_files: ['output.txt'],
    },
  });
  return { repo, store: opened.store, blocked };
}

describe('recoverable checkpoint finalization protocol', () => {
  const retryStages: CheckpointFailureStage[] = [
    'after_intent',
    'after_commit_object',
    'after_checkpoint_ref',
    'after_branch_cas',
    'after_git_applied_record',
    'after_checkpoint_row',
    'after_task_update',
    'after_event_insert',
    'before_finalize_transaction_commit',
    'after_finalize_transaction',
    'before_finalized_state_commit',
    'after_finalized_state_commit',
    'after_response_commit',
  ];

  for (const failureStage of retryStages) {
    it(`converges to one checkpoint after restart from ${failureStage}`, () => {
      const fixture = blockedFixture();
      const request = { task_id: fixture.blocked.id, revision: fixture.blocked.revision, purpose: 'RESUME' as const };
      expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), request, {
        onStage(stage) { if (stage === failureStage) throw new Error(`crash:${stage}`); },
      })).toThrow(`crash:${failureStage}`);

      const dbPath = fixture.store.path;
      fixture.store.close();
      stores.splice(stores.indexOf(fixture.store), 1);
      const reopened = Store.open(dbPath, { repoRoot: fixture.repo });
      stores.push(reopened);
      const recovered = checkpointTask(reopened, snapshot(fixture.repo), request);
      expect(recovered.checkpoint.state).toBe('FINALIZED');
      expect(recovered.task.base_commit).toBe(recovered.checkpoint.checkpoint_commit);
      expect(reopened.listCheckpoints(fixture.blocked.id)).toHaveLength(1);
      expect(reopened.listEvents(fixture.blocked.id).filter((event) => event.kind === 'checkpointed')).toHaveLength(1);
      expect(git(fixture.repo, ['show', `${recovered.checkpoint.checkpoint_commit}:output.txt`])).toBe('recoverable');
    });
  }

  it('returns the original finalized receipt data after response loss', () => {
    const fixture = blockedFixture();
    const request = { task_id: fixture.blocked.id, revision: fixture.blocked.revision, purpose: 'RESUME' as const };
    expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), request, {
      onStage(stage) { if (stage === 'after_response_commit') throw new Error('response lost'); },
    })).toThrow('response lost');
    const replay = checkpointTask(fixture.store, snapshot(fixture.repo), request);
    expect(replay.checkpoint.producer_revision).toBe(request.revision);
    expect(replay.task.revision).toBe(request.revision + 1);
  });

  it('fences resume, cancel, close, report, claim, and a second checkpoint while intent is pending', () => {
    const fixture = blockedFixture();
    const request = { task_id: fixture.blocked.id, revision: fixture.blocked.revision, purpose: 'RESUME' as const };
    expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), request, {
      onStage(stage) { if (stage === 'after_intent') throw new Error('stop'); },
    })).toThrow('stop');
    for (const operation of [
      () => resumeTask(fixture.store, snapshot(fixture.repo), request),
      () => cancelTask(fixture.store, request.task_id, request.revision),
      () => claimTask(fixture.store, snapshot(fixture.repo), 'JUNIOR', 'late-claim', request.task_id, request.revision),
      () => reportBlocked(fixture.store, 'JUNIOR', 'writer', {
        task_id: request.task_id,
        revision: request.revision,
        blocker: { reason: 'OTHER', summary: 'late', need_from_owner: 'none', evidence_refs: [] },
      }),
      () => reportResult(fixture.store, 'JUNIOR', 'writer', {
        task_id: request.task_id,
        revision: request.revision,
        outcome: 'failed',
        result: implResult,
      }),
      () => recoverTask(fixture.store, snapshot(fixture.repo), request),
      () => checkpointTask(fixture.store, snapshot(fixture.repo), { ...request, purpose: 'REVIEW' }),
    ]) expect(operation).toThrow(/checkpoint|Checkpoint/i);

    expect(() => fixture.store.updateTask({ ...fixture.blocked, writer_generation: fixture.blocked.writer_generation + WRITER_PROTOCOL_GENERATION, status: 'CLOSED', revision: fixture.blocked.revision + 1 })).toThrow(/CHECKPOINT_FINALIZATION_REQUIRED/);
    expect(() => fixture.store.updateTask({
      ...fixture.blocked,
      writer_generation: fixture.blocked.writer_generation + WRITER_PROTOCOL_GENERATION,
      base_commit: fixture.store.getCheckpointForRevision(request.task_id, request.revision)!.checkpoint_commit ?? fixture.blocked.base_commit,
      revision: fixture.blocked.revision + 1,
      payload: { ...fixture.blocked.payload, goal: 'mutated during finalization' },
    })).toThrow(/CHECKPOINT_FINALIZATION_REQUIRED/);
  });

  it('fails closed when the branch moves during SQLite finalization', () => {
    const fixture = blockedFixture();
    const request = { task_id: fixture.blocked.id, revision: fixture.blocked.revision, purpose: 'RESUME' as const };
    expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), request, {
      onStage(stage) {
        if (stage === 'after_task_update') {
          writeFileSync(join(fixture.repo, 'external.txt'), 'external\n');
          git(fixture.repo, ['add', 'external.txt']);
          git(fixture.repo, ['commit', '-m', 'external move']);
        }
      },
    })).toThrow(/checkpoint|Checkpoint/i);
    expect(fixture.store.getCheckpointForRevision(request.task_id, request.revision)?.state).toBe('FINALIZING');
    expect(() => resumeTask(fixture.store, snapshot(fixture.repo), {
      task_id: request.task_id,
      revision: request.revision + 1,
    })).toThrow(/checkpoint|Checkpoint/i);
  });

  it('detects missing and corrupt checkpoint refs before resume', () => {
    for (const corruption of ['missing', 'wrong'] as const) {
      const fixture = blockedFixture();
      const saved = checkpointTask(fixture.store, snapshot(fixture.repo), {
        task_id: fixture.blocked.id,
        revision: fixture.blocked.revision,
        purpose: 'RESUME',
      });
      if (corruption === 'missing') git(fixture.repo, ['update-ref', '-d', saved.checkpoint.checkpoint_ref]);
      else git(fixture.repo, ['update-ref', saved.checkpoint.checkpoint_ref, saved.checkpoint.prior_base_commit]);
      expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), {
        task_id: fixture.blocked.id,
        revision: fixture.blocked.revision,
        purpose: 'RESUME',
      })).toThrow(/checkpoint|Checkpoint/i);
      expect(() => resumeTask(fixture.store, snapshot(fixture.repo), {
        task_id: saved.task.id,
        revision: saved.task.revision,
      })).toThrow(/checkpoint|Checkpoint/i);
    }
  });

  it('fences close while a REVIEW checkpoint intent is pending', () => {
    const fixture = blockedFixture();
    const initialCheckpoint = checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: fixture.blocked.id,
      revision: fixture.blocked.revision,
      purpose: 'RESUME',
    });
    const resumed = resumeTask(fixture.store, snapshot(fixture.repo), {
      task_id: fixture.blocked.id,
      revision: initialCheckpoint.task.revision,
    });
    const running = claimTask(fixture.store, snapshot(fixture.repo), 'JUNIOR', 'writer-2', resumed.id, resumed.revision);
    writeFileSync(join(fixture.repo, 'output.txt'), 'complete\n');
    const completed = reportResult(fixture.store, 'JUNIOR', 'writer-2', {
      task_id: running.id,
      revision: running.revision,
      outcome: 'completed',
      result: { ...implResult, changed_files: ['output.txt'], working_tree_status: { clean: false, porcelain: ' M output.txt' } },
    });
    expect(() => checkpointTask(fixture.store, snapshot(fixture.repo), {
      task_id: completed.id, revision: completed.revision, purpose: 'REVIEW',
    }, { onStage(stage) { if (stage === 'after_intent') throw new Error('stop'); } })).toThrow('stop');
    expect(() => closeTask(fixture.store, completed.id, completed.revision)).toThrow(/checkpoint|Checkpoint/i);
  });
});
