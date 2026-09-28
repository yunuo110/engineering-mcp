import { createHash } from 'node:crypto';
import { DomainError } from '../errors.ts';
import { resumeTask } from '../lifecycle.ts';
import type { Store } from '../store.ts';
import type { GitSnapshot, TaskContract } from '../types.ts';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;

export type PendingWorkDecision = {
  decision_id: string;
  task_id: string;
  task_revision: number;
  decision_type: 'PERMISSION_RETRY';
  reason: 'PERMISSION';
  prompt: string;
  allowed_responses: ['RETRY_UNCHANGED'];
  created_at: string;
  resolved: false;
};

export function pendingWorkDecision(submissionId: string, task: TaskContract): PendingWorkDecision | undefined {
  if (task.status !== 'BLOCKED' || task.blocker?.reason !== 'PERMISSION') return undefined;
  const decisionId = createHash('sha256')
    .update(JSON.stringify(['engineering-work-decision/1', submissionId, task.id, task.revision,
      task.blocker.reason, task.updated_at]), 'utf8').digest('hex');
  return {
    decision_id: decisionId,
    task_id: task.id,
    task_revision: task.revision,
    decision_type: 'PERMISSION_RETRY',
    reason: 'PERMISSION',
    prompt: task.blocker.need_from_owner,
    allowed_responses: ['RETRY_UNCHANGED'],
    created_at: task.updated_at,
    resolved: false,
  };
}

export type ResolveWorkDecisionInput = {
  submission_id: string;
  decision_id: string;
  response_id: string;
  action: 'RETRY_UNCHANGED';
};

export type ResolvedWorkDecision = {
  task: TaskContract;
  response_replayed: boolean;
  resolved_revision: number;
};

export function resolveWorkDecision(store: Store, git: GitSnapshot, input: ResolveWorkDecisionInput): ResolvedWorkDecision {
  if (!ID.test(input.submission_id) || !ID.test(input.response_id)
    || !SHA.test(input.decision_id) || input.action !== 'RETRY_UNCHANGED') {
    throw new DomainError('WORK_RESPONSE_INVALID', 'Invalid Work decision response');
  }
  const responseDigest = createHash('sha256')
    .update(JSON.stringify(['engineering-work-response/1', input.decision_id, input.action]), 'utf8')
    .digest('hex');

  function replay(): ResolvedWorkDecision | undefined {
    const receipt = store.getWorkDecisionResponse(input.submission_id, input.response_id);
    if (!receipt) return undefined;
    if (receipt.response_digest !== responseDigest || receipt.decision_id !== input.decision_id) {
      throw new DomainError('WORK_RESPONSE_CONFLICT', 'Response identity was used for different content');
    }
    const binding = store.getWorkSubmission(input.submission_id);
    if (!binding || receipt.task_id !== binding.task_id) {
      throw new DomainError('SCHEMA_MISMATCH', 'Work response refers to an unbound task');
    }
    const task = store.getTask(receipt.task_id);
    if (!task || task.revision < receipt.resolved_revision) {
      throw new DomainError('SCHEMA_MISMATCH', 'Work response refers to a missing revision');
    }
    return { task, response_replayed: true, resolved_revision: receipt.resolved_revision };
  }

  const prior = replay();
  if (prior) return prior;
  const binding = store.getWorkSubmission(input.submission_id);
  if (!binding) throw new DomainError('WORK_SUBMISSION_NOT_FOUND', 'Work submission was not found');
  const task = store.getTask(binding.task_id);
  if (!task) throw new DomainError('SCHEMA_MISMATCH', 'Work submission refers to a missing task');
  const decision = pendingWorkDecision(input.submission_id, task);
  if (!decision || decision.decision_id !== input.decision_id) {
    throw new DomainError('WORK_DECISION_STALE', 'Pending Work decision is not current');
  }
  try {
    const resumed = resumeTask(store, git, { task_id: task.id, revision: decision.task_revision }, (previous, next) => {
      const current = pendingWorkDecision(input.submission_id, previous);
      if (!current || current.decision_id !== input.decision_id) {
        throw new DomainError('WORK_DECISION_STALE', 'Pending Work decision changed');
      }
      store.insertWorkDecisionResponse(input.submission_id, input.response_id, responseDigest,
        input.decision_id, next.id, next.revision, next.updated_at);
    });
    return { task: resumed, response_replayed: false, resolved_revision: resumed.revision };
  } catch (error) {
    // A concurrent identical response may have committed between the read and
    // the revision guard. Only a durable matching receipt makes replay safe.
    const committed = replay();
    if (committed) return committed;
    throw error;
  }
}
