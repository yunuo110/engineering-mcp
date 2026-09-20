import { DomainError } from '../errors.ts';
import { canClaimTaskType, isWorkerRole } from '../role.ts';
import type { Store } from '../store.ts';
import { nowIso, type DispatchRun, type TaskContract } from '../types.ts';
import {
  parseMessage,
  parseTrustedActorContext,
  serializeForBoundedValidation,
  type GuardFailure,
} from '../c2c/guards.ts';
import { evaluateC2CMessage } from '../c2c/mapping.ts';
import type {
  AuthoritativeDispatchSnapshot,
  AuthoritativeSnapshot,
  C2CEvaluation,
  TrustedActorContext,
} from '../c2c/schema.ts';
import type { DurableC2CEvaluationReceipt } from './schema.ts';
import { toC2CReceipt } from './schema.ts';

export type DurableC2CEvaluationStage =
  | 'after_evaluation'
  | 'after_insert'
  | 'after_commit';

export type DurableC2CEvaluationOptions = {
  onStage?: (stage: DurableC2CEvaluationStage) => void;
};

function reject(failure: GuardFailure): C2CEvaluation {
  return {
    decision: 'REJECT',
    code: failure.code,
    message: failure.message,
  };
}

function rejectCode(
  code:
    | 'TASK_MISMATCH'
    | 'REPOSITORY_MISMATCH'
    | 'EXECUTION_PROVENANCE_MISSING'
    | 'EXECUTION_PROVENANCE_MISMATCH',
  message: string,
): C2CEvaluation {
  return { decision: 'REJECT', code, message };
}

function requireEvaluationAdmission(
  task: TaskContract,
  context: TrustedActorContext,
): void {
  if (context.actor_role === 'OWNER') return;

  if (!isWorkerRole(context.actor_role)) {
    throw new DomainError(
      'ROLE_FORBIDDEN',
      `${context.actor_role} is not allowed to evaluate task ${task.id}`,
    );
  }

  if (!canClaimTaskType(context.actor_role, task.type)) {
    throw new DomainError(
      'WRONG_TASK_TYPE',
      `${context.actor_role} cannot evaluate ${task.type} task ${task.id}`,
      { task_id: task.id, task_type: task.type, actor_role: context.actor_role },
    );
  }

  if (task.assignee_role !== context.actor_role) {
    throw new DomainError(
      'NOT_ASSIGNED',
      `Task ${task.id} is not currently assigned to ${context.actor_role}`,
      { task_id: task.id, actor_role: context.actor_role },
    );
  }

  if (
    task.status !== 'RUNNING' &&
    task.status !== 'BLOCKED' &&
    task.status !== 'FAILED' &&
    task.status !== 'COMPLETED'
  ) {
    throw new DomainError(
      'NOT_ASSIGNED',
      `Task ${task.id} is not currently visible for ${context.actor_role} C2C evaluation`,
      { task_id: task.id, actor_role: context.actor_role, status: task.status },
    );
  }
}

function toAuthoritativeDispatch(
  run: DispatchRun,
): AuthoritativeDispatchSnapshot {
  return {
    id: run.id,
    task_id: run.task_id,
    worker_role: run.worker_role,
    runner_instance_id: run.runner_instance_id,
    status: run.status,
  };
}

function materializeDispatch(
  store: Store,
  task: TaskContract,
  context: TrustedActorContext,
): AuthoritativeDispatchSnapshot | C2CEvaluation | undefined {
  if (context.dispatch_run_id !== undefined) {
    const run = store.getDispatchRun(context.dispatch_run_id);
    if (!run) {
      return rejectCode(
        'EXECUTION_PROVENANCE_MISSING',
        `Trusted dispatch_run_id ${context.dispatch_run_id} does not exist`,
      );
    }
    if (run.task_id !== task.id) {
      return rejectCode(
        'EXECUTION_PROVENANCE_MISMATCH',
        'Trusted dispatch_run_id belongs to a different task',
      );
    }
    if (
      context.runner_instance_id !== undefined &&
      run.runner_instance_id !== context.runner_instance_id
    ) {
      return rejectCode(
        'EXECUTION_PROVENANCE_MISMATCH',
        'Trusted runner_instance_id does not match trusted dispatch_run_id',
      );
    }
    return toAuthoritativeDispatch(run);
  }

  if (context.runner_instance_id !== undefined) {
    const matches = store
      .listDispatchRunsForTask(task.id)
      .filter((run) => run.runner_instance_id === context.runner_instance_id);

    if (matches.length === 0) {
      return rejectCode(
        'EXECUTION_PROVENANCE_MISSING',
        `No authoritative dispatch matches runner_instance_id ${context.runner_instance_id}`,
      );
    }
    if (matches.length > 1) {
      return rejectCode(
        'EXECUTION_PROVENANCE_MISMATCH',
        `runner_instance_id ${context.runner_instance_id} matches multiple dispatches for task ${task.id}`,
      );
    }
    return toAuthoritativeDispatch(matches[0]!);
  }

  return undefined;
}

function authoritativeSnapshot(
  task: TaskContract,
  dispatch: AuthoritativeDispatchSnapshot | undefined,
  receipt: DurableC2CEvaluationReceipt | undefined,
): AuthoritativeSnapshot {
  return {
    task: {
      id: task.id,
      type: task.type,
      status: task.status,
      revision: task.revision,
      repo_root: task.repo_root,
      assignee_role: task.assignee_role,
      execution_instance_id: task.execution_instance_id,
      result: task.result,
    },
    ...(dispatch ? { dispatch } : {}),
    ...(receipt ? { existing_receipt: toC2CReceipt(receipt) } : {}),
  };
}

export function durableEvaluateC2CMessage(
  store: Store,
  rawMessage: unknown,
  rawTrustedActorContext: unknown,
  options?: DurableC2CEvaluationOptions,
): C2CEvaluation {
  const serialized = serializeForBoundedValidation(rawMessage);
  if (!serialized.ok) return reject(serialized.failure);

  const parsedMessage = parseMessage(rawMessage);
  if (!parsedMessage.ok) return reject(parsedMessage.failure);
  const message = parsedMessage.value;

  const parsedContext = parseTrustedActorContext(rawTrustedActorContext);
  if (!parsedContext.ok) return reject(parsedContext.failure);
  const context = parsedContext.value;

  const evaluation = store.transact(() => {
    // All persistence-sensitive work stays under this single BEGIN IMMEDIATE:
    // receipt lookup, authoritative reads, exact dispatch materialization,
    // frozen S1 evaluation, and initial receipt insert.
    const existing = store.getC2CEvaluationReceipt(message.message_id);
    const task = store.getTask(message.task_id);
    if (!task) {
      return rejectCode(
        'TASK_MISMATCH',
        `Message task ${message.task_id} does not exist in the authoritative ledger`,
      );
    }

    if (context.repo_root !== task.repo_root) {
      return rejectCode(
        'REPOSITORY_MISMATCH',
        'Trusted repository does not match the authoritative task repository',
      );
    }

    // Durable replay never bypasses current access control.
    requireEvaluationAdmission(task, context);

    const dispatchOrFailure = materializeDispatch(store, task, context);
    if (
      dispatchOrFailure !== undefined &&
      'decision' in dispatchOrFailure
    ) {
      return dispatchOrFailure;
    }

    const result = evaluateC2CMessage(
      rawMessage,
      context,
      authoritativeSnapshot(task, dispatchOrFailure, existing),
    );
    options?.onStage?.('after_evaluation');

    if (
      result.decision === 'REJECT' ||
      result.decision === 'NOOP_WITH_EXISTING_RECEIPT'
    ) {
      return result;
    }

    store.insertC2CEvaluationReceipt({
      ...result.receipt,
      created_at: nowIso(),
    });
    options?.onStage?.('after_insert');
    return result;
  });

  options?.onStage?.('after_commit');
  return evaluation;
}
