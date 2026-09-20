import {
  claimedEventDetailSchema,
  executionEvidenceSnapshotSchema,
  executionSelectorSchema,
  recoveryBlockedEventDetailSchema,
  resultEventDetailSchema,
  workerBlockedEventDetailSchema,
  type EvidenceProjectionError,
  type ExecutionEvidenceSnapshot,
  type ExecutionSelector,
  type ReviewSnapshotProjection,
} from './schema.ts';
import type {
  Blocker,
  DispatchRun,
  TaskCheckpoint,
  TaskEvent,
  TaskResult,
} from '../types.ts';

export type TerminalRecord =
  | {
      kind: 'RESULT';
      event: TaskEvent;
      outcome: 'completed' | 'failed';
      result: TaskResult;
    }
  | {
      kind: 'BLOCKER';
      event: TaskEvent;
      blocker: Blocker;
    };

export type BoundExecution = {
  kind: 'BOUND_TERMINAL_EXECUTION';
  snapshot: ExecutionEvidenceSnapshot;
  selector: ExecutionSelector;
  executionInstanceId: string;
  dispatch: DispatchRun | undefined;
  claimEvent: TaskEvent;
  terminal: TerminalRecord;
  reviewSnapshot: ReviewSnapshotProjection | null;
};

export type DispatchFailedBeforeClaim = {
  kind: 'DISPATCH_FAILED_BEFORE_CLAIM';
  snapshot: ExecutionEvidenceSnapshot;
  selector: Extract<ExecutionSelector, { dispatch_run_id: string }>;
  dispatch: DispatchRun;
};

export type UnavailableExecution = {
  kind: 'UNAVAILABLE';
  snapshot: ExecutionEvidenceSnapshot;
  selector: ExecutionSelector;
  executionInstanceId: string | null;
  dispatch: DispatchRun | undefined;
  claimEvent: TaskEvent | null;
  reason:
    | 'DISPATCH_NOT_CLAIMED_YET'
    | 'CLAIMED_WITHOUT_TERMINAL_RECORD';
};

export type RejectedBinding = {
  kind: 'REJECT';
  error: EvidenceProjectionError;
};

export type ExecutionBinding =
  | BoundExecution
  | DispatchFailedBeforeClaim
  | UnavailableExecution
  | RejectedBinding;

function reject(code: EvidenceProjectionError['code'], message: string): RejectedBinding {
  return { kind: 'REJECT', error: { code, message } };
}

function parseInputs(
  rawSnapshot: unknown,
  rawSelector: unknown,
):
  | {
      ok: true;
      snapshot: ExecutionEvidenceSnapshot;
      selector: ExecutionSelector;
    }
  | { ok: false; error: RejectedBinding } {
  const selector = executionSelectorSchema.safeParse(rawSelector);
  if (!selector.success) {
    return {
      ok: false,
      error: reject(
        'INVALID_SELECTOR',
        selector.error.issues.map((issue) => issue.message).join('; '),
      ),
    };
  }

  const snapshot = executionEvidenceSnapshotSchema.safeParse(rawSnapshot);
  if (!snapshot.success) {
    return {
      ok: false,
      error: reject(
        'INVALID_SNAPSHOT',
        snapshot.error.issues.map((issue) => issue.message).join('; '),
      ),
    };
  }

  return {
    ok: true,
    snapshot: snapshot.data as ExecutionEvidenceSnapshot,
    selector: selector.data,
  };
}

function requireSnapshotTaskIntegrity(
  snapshot: ExecutionEvidenceSnapshot,
  selector: ExecutionSelector,
): RejectedBinding | null {
  if (selector.task_id !== snapshot.task.id) {
    return reject(
      'TASK_MISMATCH',
      `Selector task ${selector.task_id} does not match snapshot task ${snapshot.task.id}`,
    );
  }

  if (snapshot.trusted_repo_root !== snapshot.task.repo_root) {
    return reject(
      'REPOSITORY_MISMATCH',
      'Trusted repository does not match the authoritative task repository',
    );
  }

  const foreignEvent = snapshot.task_events.find(
    (event) => event.task_id !== snapshot.task.id,
  );
  if (foreignEvent) {
    return reject(
      'FOREIGN_TASK_EVENT',
      `Snapshot contains event ${foreignEvent.id} for foreign task ${foreignEvent.task_id}`,
    );
  }

  const foreignCheckpoint = snapshot.checkpoints?.find(
    (checkpoint) => checkpoint.task_id !== snapshot.task.id,
  );
  if (foreignCheckpoint) {
    return reject(
      'FOREIGN_TASK_CHECKPOINT',
      `Snapshot contains checkpoint ${foreignCheckpoint.id} for foreign task ${foreignCheckpoint.task_id}`,
    );
  }

  const mismatchedCheckpoint = snapshot.checkpoints?.find(
    (checkpoint) =>
      checkpoint.repo_root !== snapshot.task.repo_root ||
      checkpoint.branch !== snapshot.task.branch,
  );
  if (mismatchedCheckpoint) {
    return reject(
      'CHECKPOINT_PROVENANCE_MISMATCH',
      `Checkpoint ${mismatchedCheckpoint.id} does not match the authoritative task repository/branch`,
    );
  }

  if (snapshot.dispatch && snapshot.dispatch.task_id !== snapshot.task.id) {
    return reject(
      'DISPATCH_MISMATCH',
      'Snapshot dispatch belongs to a different task',
    );
  }

  if (snapshot.dispatch && snapshot.task.type !== 'IMPLEMENTATION') {
    return reject(
      'EXECUTION_PROVENANCE_MISMATCH',
      'Current DispatchRun records are JUNIOR implementation executions and cannot bind a DIAGNOSIS task',
    );
  }

  return null;
}

function parseClaimedEvents(
  events: readonly TaskEvent[],
): { ok: true; claims: Array<{ event: TaskEvent; executionInstanceId: string }> } | RejectedBinding {
  const claims: Array<{ event: TaskEvent; executionInstanceId: string }> = [];

  for (const event of events) {
    if (event.kind !== 'claimed') continue;

    const parsed = claimedEventDetailSchema.safeParse(event.detail);
    if (!parsed.success) {
      return reject(
        'MALFORMED_EVENT_DETAIL',
        `Claimed event ${event.id} has malformed detail`,
      );
    }

    if (
      event.from_status !== 'READY' ||
      event.to_status !== 'RUNNING'
    ) {
      return reject(
        'MALFORMED_EVENT_DETAIL',
        `Claimed event ${event.id} has invalid lifecycle states`,
      );
    }

    claims.push({
      event,
      executionInstanceId: parsed.data.execution_instance_id,
    });
  }

  return { ok: true, claims };
}

function expectedWorkerRole(taskType: ExecutionEvidenceSnapshot['task']['type']): 'JUNIOR' | 'PRINCIPAL' {
  return taskType === 'IMPLEMENTATION' ? 'JUNIOR' : 'PRINCIPAL';
}

function bindReviewCheckpoint(
  snapshot: ExecutionEvidenceSnapshot,
  terminalRevision: number,
): ReviewSnapshotProjection | RejectedBinding | null {
  const matching = (snapshot.checkpoints ?? []).filter(
    (checkpoint) =>
      checkpoint.purpose === 'REVIEW' &&
      checkpoint.producer_revision === terminalRevision,
  );

  if (matching.length > 1) {
    return reject(
      'AMBIGUOUS_REVIEW_CHECKPOINT',
      `Multiple REVIEW checkpoints match terminal revision ${terminalRevision}`,
    );
  }

  const checkpoint = matching[0];
  if (!checkpoint) return null;

  return {
    verification: 'VERIFIED',
    checkpoint_id: checkpoint.id,
    producer_revision: checkpoint.producer_revision,
    checkpoint_commit: checkpoint.checkpoint_commit,
    checkpoint_ref: checkpoint.checkpoint_ref,
    prior_base_commit: checkpoint.prior_base_commit,
    changed_files: [...checkpoint.changed_files],
    finalized_at: checkpoint.finalized_at,
  };
}

function requireServerAuthoritative(
  terminal: TaskResult | Blocker,
  taskId: string,
  repoRoot: string,
  producerRevision: number,
): RejectedBinding | null {
  const authoritative = terminal.evidence?.server_authoritative;
  if (!authoritative) return null;

  if (
    authoritative.task_id !== taskId ||
    authoritative.repo_root !== repoRoot ||
    authoritative.producer_revision !== producerRevision
  ) {
    return reject(
      'TERMINAL_PROVENANCE_MISMATCH',
      'Terminal server-authoritative evidence does not match selected execution provenance',
    );
  }

  return null;
}

function parseTerminalEvent(
  event: TaskEvent,
  claimEvent: TaskEvent,
  snapshot: ExecutionEvidenceSnapshot,
  dispatch: DispatchRun | undefined,
): TerminalRecord | RejectedBinding {
  if (event.kind === 'result') {
    const parsed = resultEventDetailSchema.safeParse(event.detail);
    if (!parsed.success) {
      return reject(
        'MALFORMED_EVENT_DETAIL',
        `Result event ${event.id} has malformed detail`,
      );
    }

    const expectedStatus = parsed.data.outcome === 'completed' ? 'COMPLETED' : 'FAILED';
    if (event.to_status !== expectedStatus) {
      return reject(
        'TERMINAL_PROVENANCE_MISMATCH',
        'Result event lifecycle status does not match its outcome',
      );
    }

    if (event.actor_role !== claimEvent.actor_role) {
      return reject(
        'TERMINAL_PROVENANCE_MISMATCH',
        'Result event actor does not match the actor that claimed the execution',
      );
    }

    const provenanceFailure = requireServerAuthoritative(
      parsed.data.result,
      snapshot.task.id,
      snapshot.task.repo_root,
      claimEvent.revision,
    );
    if (provenanceFailure) return provenanceFailure;

    if (dispatch) {
      const allowed =
        (parsed.data.outcome === 'completed' && dispatch.status === 'completed') ||
        (parsed.data.outcome === 'failed' && dispatch.status === 'failed');
      if (!allowed) {
        return reject(
          'TERMINAL_PROVENANCE_MISMATCH',
          'Dispatch terminal state does not match the selected result event',
        );
      }
    }

    return {
      kind: 'RESULT',
      event,
      outcome: parsed.data.outcome,
      result: parsed.data.result,
    };
  }

  const workerBlocked = workerBlockedEventDetailSchema.safeParse(event.detail);
  const recoveryBlocked = recoveryBlockedEventDetailSchema.safeParse(event.detail);

  if (!workerBlocked.success && !recoveryBlocked.success) {
    return reject(
      'MALFORMED_EVENT_DETAIL',
      `Blocked event ${event.id} has malformed detail`,
    );
  }

  if (event.to_status !== 'BLOCKED') {
    return reject(
      'TERMINAL_PROVENANCE_MISMATCH',
      'Blocked event lifecycle status must be BLOCKED',
    );
  }

  let blocker: Blocker;
  let isRecovery: boolean;
  if (workerBlocked.success) {
    blocker = workerBlocked.data.blocker;
    isRecovery = false;
  } else if (recoveryBlocked.success) {
    blocker = recoveryBlocked.data.blocker;
    isRecovery = true;
  } else {
    return reject(
      'MALFORMED_EVENT_DETAIL',
      `Blocked event ${event.id} has malformed detail`,
    );
  }
  if (
    (!isRecovery && event.actor_role !== claimEvent.actor_role) ||
    (isRecovery && event.actor_role !== 'OWNER')
  ) {
    return reject(
      'TERMINAL_PROVENANCE_MISMATCH',
      'Blocked event actor does not match the selected execution transition',
    );
  }

  const provenanceFailure = requireServerAuthoritative(
    blocker,
    snapshot.task.id,
    snapshot.task.repo_root,
    claimEvent.revision,
  );
  if (provenanceFailure) return provenanceFailure;

  if (dispatch && dispatch.status !== 'blocked' && dispatch.status !== 'failed') {
    return reject(
      'TERMINAL_PROVENANCE_MISMATCH',
      'Dispatch terminal state does not match the selected blocked event',
    );
  }

  return {
    kind: 'BLOCKER',
    event,
    blocker,
  };
}

export function bindExecution(
  rawSnapshot: unknown,
  rawSelector: unknown,
): ExecutionBinding {
  const parsed = parseInputs(rawSnapshot, rawSelector);
  if (!parsed.ok) return parsed.error;

  const { snapshot, selector } = parsed;

  const snapshotFailure = requireSnapshotTaskIntegrity(snapshot, selector);
  if (snapshotFailure) return snapshotFailure;

  const claimsResult = parseClaimedEvents(snapshot.task_events);
  if ('kind' in claimsResult) return claimsResult;

  let executionInstanceId: string | null = null;
  let dispatch: DispatchRun | undefined;

  if ('dispatch_run_id' in selector) {
    dispatch = snapshot.dispatch;
    if (!dispatch) {
      return reject(
        'DISPATCH_REQUIRED',
        'Dispatch-backed selector requires the exact authoritative dispatch in the snapshot',
      );
    }
    if (dispatch.id !== selector.dispatch_run_id) {
      return reject(
        'DISPATCH_MISMATCH',
        'Snapshot dispatch does not match selector dispatch_run_id',
      );
    }

    if (dispatch.runner_instance_id === null) {
      if (dispatch.status === 'failed') {
        return {
          kind: 'DISPATCH_FAILED_BEFORE_CLAIM',
          snapshot,
          selector,
          dispatch,
        };
      }

      if (dispatch.status === 'launching') {
        return {
          kind: 'UNAVAILABLE',
          snapshot,
          selector,
          executionInstanceId: null,
          dispatch,
          claimEvent: null,
          reason: 'DISPATCH_NOT_CLAIMED_YET',
        };
      }

      return reject(
        'EXECUTION_PROVENANCE_MISMATCH',
        'Dispatch has no runner_instance_id after leaving pre-claim launching state',
      );
    }

    executionInstanceId = dispatch.runner_instance_id;
  } else {
    executionInstanceId = selector.execution_instance_id;
    dispatch = snapshot.dispatch;

    if (dispatch && dispatch.runner_instance_id === null) {
      return reject(
        'EXECUTION_PROVENANCE_MISMATCH',
        'A direct execution selector cannot be bound to a dispatch that has no runner identity',
      );
    }

    if (
      dispatch &&
      dispatch.runner_instance_id !== executionInstanceId
    ) {
      return reject(
        'EXECUTION_PROVENANCE_MISMATCH',
        'Snapshot dispatch runner does not match selector execution_instance_id',
      );
    }
  }

  const matchingClaims = claimsResult.claims.filter(
    (claim) => claim.executionInstanceId === executionInstanceId,
  );

  if (matchingClaims.length === 0) {
    return reject(
      'EXECUTION_CLAIM_NOT_FOUND',
      `No claimed event exists for execution instance ${executionInstanceId}`,
    );
  }

  if (matchingClaims.length > 1) {
    return reject(
      'AMBIGUOUS_EXECUTION_CLAIM',
      `Execution instance ${executionInstanceId} claimed task ${snapshot.task.id} more than once`,
    );
  }

  const claimEvent = matchingClaims[0]!.event;
  if (claimEvent.actor_role !== expectedWorkerRole(snapshot.task.type)) {
    return reject(
      'EXECUTION_PROVENANCE_MISMATCH',
      'Claim actor role does not match authoritative task type',
    );
  }

  const terminalRevision = claimEvent.revision + 1;
  const terminalEvents = snapshot.task_events.filter(
    (event) =>
      event.revision === terminalRevision &&
      event.from_status === 'RUNNING' &&
      (event.kind === 'result' || event.kind === 'blocked'),
  );

  if (terminalEvents.length > 1) {
    return reject(
      'AMBIGUOUS_TERMINAL_EVENT',
      `Multiple terminal execution records exist at revision ${terminalRevision}`,
    );
  }

  if (terminalEvents.length === 0) {
    if (dispatch && (dispatch.status === 'completed' || dispatch.status === 'blocked')) {
      return reject(
        'TERMINAL_PROVENANCE_MISMATCH',
        'Dispatch is terminal but the matching lifecycle terminal record is missing',
      );
    }

    return {
      kind: 'UNAVAILABLE',
      snapshot,
      selector,
      executionInstanceId,
      dispatch,
      claimEvent,
      reason: 'CLAIMED_WITHOUT_TERMINAL_RECORD',
    };
  }

  const terminal = parseTerminalEvent(
    terminalEvents[0]!,
    claimEvent,
    snapshot,
    dispatch,
  );
  if (terminal.kind === 'REJECT') return terminal;

  const reviewSnapshot = bindReviewCheckpoint(snapshot, terminalRevision);
  if (reviewSnapshot && 'kind' in reviewSnapshot) return reviewSnapshot;

  return {
    kind: 'BOUND_TERMINAL_EXECUTION',
    snapshot,
    selector,
    executionInstanceId,
    dispatch,
    claimEvent,
    terminal,
    reviewSnapshot,
  };
}
