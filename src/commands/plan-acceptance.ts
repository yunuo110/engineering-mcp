import {
  canonicalMessageDigest,
  parseTrustedActorContext,
} from '../c2c/guards.ts';
import type { TrustedActorContext } from '../c2c/schema.ts';
import type { Store } from '../store.ts';
import { nowIso } from '../types.ts';
import {
  acceptPlanCommandSchema,
  planAcceptanceReceiptSchema,
  type PlanAcceptanceEvaluation,
  type PlanAcceptanceRejectCode,
} from './schema.ts';

export type PlanAcceptanceStage =
  | 'after_validation'
  | 'after_insert'
  | 'after_commit';

export type PlanAcceptanceOptions = {
  onStage?: (stage: PlanAcceptanceStage) => void;
};

function reject(
  code: PlanAcceptanceRejectCode,
  message: string,
): PlanAcceptanceEvaluation {
  return { decision: 'REJECT', code, message };
}

function requireOwnerAdmission(
  context: TrustedActorContext,
): PlanAcceptanceEvaluation | null {
  if (context.actor_role !== 'OWNER') {
    return reject(
      'ROLE_FORBIDDEN',
      'Only OWNER may accept an evaluated C2C PLAN',
    );
  }
  return null;
}

export function acceptEvaluatedPlan(
  store: Store,
  rawCommand: unknown,
  rawTrustedActorContext: unknown,
  options?: PlanAcceptanceOptions,
): PlanAcceptanceEvaluation {
  const parsedCommand = acceptPlanCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) {
    return reject(
      'INVALID_COMMAND',
      `Invalid PLAN acceptance command: ${parsedCommand.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  const command = parsedCommand.data;

  const parsedContext = parseTrustedActorContext(rawTrustedActorContext);
  if (!parsedContext.ok) {
    return reject(
      'INVALID_TRUSTED_CONTEXT',
      parsedContext.failure.message,
    );
  }
  const context = parsedContext.value;

  const roleFailure = requireOwnerAdmission(context);
  if (roleFailure) return roleFailure;

  const result = store.transact<PlanAcceptanceEvaluation>(() => {
    // Current trusted admission happens before exact replay. Replay may bypass
    // revision/status freshness, but never OWNER/repository/task binding.
    const task = store.getTask(command.plan_message.task_id);
    if (!task) {
      return reject(
        'TASK_NOT_FOUND',
        `Task ${command.plan_message.task_id} was not found`,
      );
    }

    if (context.repo_root !== task.repo_root) {
      return reject(
        'REPOSITORY_MISMATCH',
        'Trusted repository does not match the authoritative task repository',
      );
    }

    if (command.plan_message.state !== 'PLAN') {
      return reject(
        'NOT_PLAN',
        'Only an evaluated C2C PLAN message may be accepted',
      );
    }

    const evaluation = store.getC2CEvaluationReceipt(
      command.plan_message.message_id,
    );
    if (!evaluation) {
      return reject(
        'EVALUATION_RECEIPT_MISSING',
        `No durable S3A evaluation receipt exists for message ${command.plan_message.message_id}`,
      );
    }

    const digest = canonicalMessageDigest(command.plan_message);
    if (digest !== evaluation.message_digest) {
      return reject(
        'EVALUATION_MESSAGE_CONFLICT',
        'PLAN message content does not match the immutable S3A evaluation receipt',
      );
    }

    if (
      command.plan_message.task_id !== evaluation.task_id ||
      task.id !== evaluation.task_id
    ) {
      return reject(
        'EVALUATION_TASK_MISMATCH',
        'PLAN task identity does not match the immutable S3A evaluation receipt',
      );
    }

    if (
      command.plan_message.expected_revision !==
      evaluation.evaluated_revision
    ) {
      return reject(
        'EVALUATION_REVISION_MISMATCH',
        'PLAN expected_revision does not match the immutable S3A evaluated revision',
      );
    }

    if (evaluation.decision !== 'REQUIRES_OWNER_ACTION') {
      return reject(
        'EVALUATION_DECISION_MISMATCH',
        `S3A decision ${evaluation.decision} is not an owner-action PLAN evaluation`,
      );
    }

    const existing = store.getPlanAcceptanceReceipt(command.command_id);
    if (existing) {
      if (
        existing.evaluation_message_id !== evaluation.message_id ||
        existing.task_id !== evaluation.task_id ||
        existing.accepted_revision !== evaluation.evaluated_revision
      ) {
        return reject(
          'COMMAND_ID_CONFLICT',
          'command_id was already used for a different PLAN acceptance',
        );
      }

      options?.onStage?.('after_validation');
      return {
        decision: 'NOOP_WITH_EXISTING_ACCEPTANCE',
        receipt: existing,
      };
    }

    const acceptedElsewhere = store.getPlanAcceptanceForEvaluation(
      evaluation.message_id,
    );
    if (acceptedElsewhere) {
      return reject(
        'PLAN_ALREADY_ACCEPTED',
        `PLAN evaluation ${evaluation.message_id} was already accepted by command ${acceptedElsewhere.command_id}`,
      );
    }

    // Fresh acceptance is only valid for the exact READY revision that S3A
    // evaluated. Resume/delegate/spawn are intentionally separate decisions.
    if (task.status !== 'READY') {
      return reject(
        'TASK_NOT_READY',
        `Cannot accept PLAN for task ${task.id} in status ${task.status}`,
      );
    }

    if (task.revision !== evaluation.evaluated_revision) {
      return reject(
        'REVISION_MISMATCH',
        `Evaluated revision ${evaluation.evaluated_revision} is stale; authoritative task revision is ${task.revision}`,
      );
    }

    options?.onStage?.('after_validation');
    const acceptedAt = nowIso();
    store.insertPlanAcceptanceReceipt({
      command_id: command.command_id,
      evaluation_message_id: evaluation.message_id,
      accepted_at: acceptedAt,
    });
    options?.onStage?.('after_insert');

    return {
      decision: 'ACCEPTED',
      receipt: planAcceptanceReceiptSchema.parse({
        command_id: command.command_id,
        evaluation_message_id: evaluation.message_id,
        task_id: evaluation.task_id,
        accepted_revision: evaluation.evaluated_revision,
        accepted_at: acceptedAt,
      }),
    };
  });

  options?.onStage?.('after_commit');
  return result;
}
