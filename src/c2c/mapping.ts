import {
  canonicalMessageDigest,
  checkDuplicateIdentity,
  parseAuthoritativeSnapshot,
  parseMessage,
  parseTrustedActorContext,
  requireCurrentRevision,
  requireExecutedReviewPrerequisites,
  requireRepositoryBinding,
  requireSenderConsistency,
  requireTaskBinding,
  serializeForBoundedValidation,
  type GuardFailure,
} from './guards.ts';
import type {
  AuthoritativeSnapshot,
  C2CDecision,
  C2CEvaluation,
  C2CMessage,
  C2CReceipt,
  TrustedActorContext,
} from './schema.ts';

function reject(failure: GuardFailure): C2CEvaluation {
  return {
    decision: 'REJECT',
    code: failure.code,
    message: failure.message,
  };
}
function receiptFor(
  message: C2CMessage,
  digest: string,
  snapshot: AuthoritativeSnapshot,
  decision: Extract<C2CDecision, 'REQUIRES_OWNER_ACTION' | 'READY_FOR_REVIEW'>,
): C2CReceipt {
  return {
    message_id: message.message_id,
    message_digest: digest,
    task_id: message.task_id,
    evaluated_revision: snapshot.task.revision,
    decision,
  };
}

function stateDecision(
  message: C2CMessage,
  context: TrustedActorContext,
  snapshot: AuthoritativeSnapshot,
): { decision: 'REQUIRES_OWNER_ACTION' | 'READY_FOR_REVIEW'; failure?: GuardFailure } {
  if (message.state !== 'EXECUTED') {
    return { decision: 'REQUIRES_OWNER_ACTION' };
  }

  const failure = requireExecutedReviewPrerequisites(context, snapshot);
  if (failure) {
    return { decision: 'REQUIRES_OWNER_ACTION', failure };
  }

  return { decision: 'READY_FOR_REVIEW' };
}

/**
 * Pure C2C S1 dry-run evaluator.
 *
 * It never opens a Store, mutates lifecycle state, emits task events, creates
 * checkpoints, delegates work, or starts a worker. The caller must materialize
 * trusted actor context and an authoritative snapshot before calling it.
 */
export function evaluateC2CMessage(
  rawMessage: unknown,
  rawTrustedActorContext: unknown,
  rawAuthoritativeSnapshot: unknown,
): C2CEvaluation {
  const serialized = serializeForBoundedValidation(rawMessage);
  if (!serialized.ok) {
    return reject(serialized.failure);
  }

  const parsedMessage = parseMessage(rawMessage);
  if (!parsedMessage.ok) {
    return reject(parsedMessage.failure);
  }
  const message = parsedMessage.value;

  const parsedContext = parseTrustedActorContext(rawTrustedActorContext);
  if (!parsedContext.ok) {
    return reject(parsedContext.failure);
  }
  const context = parsedContext.value;

  const parsedSnapshot = parseAuthoritativeSnapshot(rawAuthoritativeSnapshot);
  if (!parsedSnapshot.ok) {
    return reject(parsedSnapshot.failure);
  }
  const snapshot = parsedSnapshot.value;

  const digest = canonicalMessageDigest(message);

  const taskFailure = requireTaskBinding(message, snapshot);
  if (taskFailure) {
    return reject(taskFailure);
  }

  const repositoryFailure = requireRepositoryBinding(context, snapshot);
  if (repositoryFailure) {
    return reject(repositoryFailure);
  }

  const senderFailure = requireSenderConsistency(message, context);
  if (senderFailure) {
    return reject(senderFailure);
  }

  // Exact replay is recognized after trusted identity/binding checks but
  // before revision freshness. The task may legitimately have advanced after
  // the original evaluation.
  const duplicate = checkDuplicateIdentity(message, digest, snapshot);
  if (duplicate.kind === 'reject') {
    return reject(duplicate.failure);
  }
  if (duplicate.kind === 'noop') {
    return {
      decision: 'NOOP_WITH_EXISTING_RECEIPT',
      receipt: duplicate.receipt,
    };
  }

  const revisionFailure = requireCurrentRevision(message, snapshot);
  if (revisionFailure) {
    return reject(revisionFailure);
  }

  const mapped = stateDecision(message, context, snapshot);
  if (mapped.failure) {
    return reject(mapped.failure);
  }

  return {
    decision: mapped.decision,
    receipt: receiptFor(message, digest, snapshot, mapped.decision),
  };
}
