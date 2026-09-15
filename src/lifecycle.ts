import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.ts';
import { canClaimTaskType, isWorkerRole } from './role.ts';
import type { Store } from './store.ts';
import {
  assigneeForType,
  WRITER_PROTOCOL_GENERATION,
  diagnosisPayloadSchema,
  diagnosisResultSchema,
  implementationPayloadSchema,
  implementationResultSchema,
  workerBlockerSchema,
  nowIso,
  type CreateTaskInput,
  type CreateDiagnosisFromCheckpointInput,
  type CheckpointTaskInput,
  type CheckpointIntent,
  type ClaimTicket,
  type DispatchRun,
  type GitSnapshot,
  type RecoverTaskInput,
  type ReportBlockedInput,
  type ReportResultInput,
  type ResumeTaskInput,
  type Role,
  type TaskContract,
  type TaskCheckpoint,
  type TaskPayload,
  type TaskStatus,
  type TaskType,
  type RunnerObservedEvidence,
  taskCheckpointSchema,
} from './types.ts';
import {
  applyGitCheckpoint,
  planGitCheckpoint,
  verifyGitCheckpointIdentity,
  type CheckpointGitStage,
  type GitCheckpointPlan,
  requireClaimBaseline,
  requireCleanBaseline,
  requireResumeBaseline,
  requireSameRepository,
} from './git.ts';

const RESUMABLE: ReadonlySet<TaskStatus> = new Set(['BLOCKED', 'FAILED', 'COMPLETED']);
const CANCELLABLE: ReadonlySet<TaskStatus> = new Set([
  'READY',
  'RUNNING',
  'BLOCKED',
  'FAILED',
  'COMPLETED',
]);
const CLOSABLE: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const WORKER_VISIBLE: ReadonlySet<TaskStatus> = new Set(['RUNNING', 'BLOCKED']);

function requireTask(store: Store, taskId: string): TaskContract {
  const task = store.getTask(taskId);
  if (!task) {
    throw new DomainError('TASK_NOT_FOUND', `Task ${taskId} was not found`);
  }
  return task;
}

function requireRevision(task: TaskContract, expected: number): void {
  if (task.revision !== expected) {
    throw new DomainError(
      'REVISION_MISMATCH',
      `Expected revision ${expected}, found ${task.revision}`,
      { expected, actual: task.revision },
    );
  }
}

function payloadForType(type: TaskType, payload: TaskPayload): TaskPayload {
  const parsed =
    type === 'IMPLEMENTATION'
      ? implementationPayloadSchema.safeParse(payload)
      : diagnosisPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError('PAYLOAD_TYPE_MISMATCH', `Payload does not match task type ${type}`);
  }
  return parsed.data;
}

function resultForType(type: TaskType, result: ReportResultInput['result']): ReportResultInput['result'] {
  const parsed =
    type === 'IMPLEMENTATION'
      ? implementationResultSchema.safeParse(result)
      : diagnosisResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new DomainError('INVALID_PAYLOAD', `Result does not match task type ${type}`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function requireAssignedWorker(task: TaskContract, actor: Role): void {
  if (!isWorkerRole(actor) || task.assignee_role !== actor) {
    throw new DomainError('NOT_ASSIGNED', `Task ${task.id} is not assigned to ${actor}`);
  }
}

function requireExecutionOwner(task: TaskContract, actor: Role, executionInstanceId: string): void {
  if (!isWorkerRole(actor) || task.assignee_role !== actor) {
    throw new DomainError('NOT_ASSIGNED', `Task ${task.id} is not assigned to ${actor}`);
  }
  if (task.execution_instance_id !== executionInstanceId) {
    throw new DomainError(
      'EXECUTION_OWNER_MISMATCH',
      `Task ${task.id} is owned by another execution instance`,
      { task_id: task.id },
    );
  }
}

export function createTask(
  store: Store,
  git: GitSnapshot,
  input: CreateTaskInput,
): TaskContract {
  requireNoRepositoryCheckpoint(store);
  requireCleanBaseline(git);
  const timestamp = nowIso();
  const task: TaskContract = {
    id: randomUUID(),
    type: input.type,
    status: 'READY',
    owner_role: 'OWNER',
    assignee_role: null,
    execution_instance_id: null,
    writer_generation: WRITER_PROTOCOL_GENERATION,
    repo_root: git.repoRoot,
    base_commit: git.head,
    branch: git.branch,
    source_checkpoint: null,
    payload: input.payload,
    result: null,
    blocker: null,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };

  return store.transact(() => {
    store.insertTask(task);
    store.insertEvent({
      task_id: task.id,
      at: timestamp,
      actor_role: 'OWNER',
      kind: 'created',
      from_status: null,
      to_status: 'READY',
      revision: task.revision,
      detail: { base_commit: task.base_commit, branch: task.branch },
    });
    return task;
  });
}

export function getTask(store: Store, actor: Role, taskId: string): TaskContract {
  const task = requireTask(store, taskId);
  if (actor === 'OWNER') {
    return task;
  }
  if (task.assignee_role === actor && WORKER_VISIBLE.has(task.status)) {
    return task;
  }
  throw new DomainError('NOT_ASSIGNED', `Task ${taskId} is not assigned to ${actor}`);
}

export function listActiveTasks(store: Store, type?: TaskType): TaskContract[] {
  return store.listActive(type);
}

function workerReportedEvidence(value: {
  evidence?: { worker_reported?: Record<string, unknown> };
  implementation_complete?: boolean;
  changed_files?: string[];
  validation?: unknown[];
  git?: unknown;
  environment?: unknown;
  blocker_classification?: unknown;
}): Record<string, unknown> {
  const explicit = value.evidence?.worker_reported;
  if (explicit) return explicit;
  return {
    ...(value.implementation_complete === undefined ? {} : { implementation_complete: value.implementation_complete }),
    ...(value.changed_files === undefined ? {} : { changed_files: value.changed_files }),
    ...(value.validation === undefined ? {} : { validation: value.validation }),
    ...(value.git === undefined ? {} : { git: value.git }),
    ...(value.environment === undefined ? {} : { environment: value.environment }),
    ...(value.blocker_classification === undefined ? {} : { blocker_classification: value.blocker_classification }),
  };
}

function authoritativeEvidence(task: TaskContract, actor: Role) {
  return {
    task_id: task.id,
    task_type: task.type,
    producer_revision: task.revision,
    actor_role: actor,
    repo_root: task.repo_root,
    base_commit: task.base_commit,
    branch: task.branch,
  };
}

export function requireNoRepositoryCheckpoint(store: Store): void {
  const checkpoint = store.getAnyUnfinalizedCheckpoint();
  if (checkpoint) {
    throw new DomainError('CHECKPOINT_FINALIZATION_REQUIRED', 'Repository has a durable checkpoint intent that must be finalized before any lifecycle mutation', {
      task_id: checkpoint.task_id,
      checkpoint_id: checkpoint.id,
      checkpoint_state: checkpoint.state,
      producer_revision: checkpoint.producer_revision,
      request_identity: checkpoint.request_identity,
    });
  }
}

function requireCheckpointRecoveryExclusive(store: Store, intent: CheckpointIntent): CheckpointIntent {
  const pending = store.getAnyUnfinalizedCheckpoint();
  if (
    !pending ||
    pending.id !== intent.id ||
    pending.task_id !== intent.task_id ||
    pending.producer_revision !== intent.producer_revision ||
    pending.purpose !== intent.purpose ||
    pending.request_identity !== intent.request_identity
  ) {
    throw new DomainError('CHECKPOINT_REQUEST_MISMATCH', 'Checkpoint recovery does not own the repository checkpoint fence', {
      requested_checkpoint_id: intent.id,
      requested_task_id: intent.task_id,
      requested_producer_revision: intent.producer_revision,
      active_checkpoint_id: pending?.id,
      active_task_id: pending?.task_id,
      active_checkpoint_state: pending?.state,
    });
  }
  const running = store.getRunning();
  if (running) {
    throw new DomainError('TASK_ALREADY_RUNNING', `Cannot recover checkpoint while task ${running.id} is RUNNING`, {
      checkpoint_id: pending.id,
      checkpoint_task_id: pending.task_id,
      checkpoint_state: pending.state,
      running_task_id: running.id,
      running_type: running.type,
    });
  }
  const dispatch = store.getActiveDispatch();
  if (dispatch) {
    throw new DomainError('CHECKPOINT_FINALIZATION_REQUIRED', `Cannot recover checkpoint while dispatch ${dispatch.id} is active`, {
      checkpoint_id: pending.id,
      checkpoint_task_id: pending.task_id,
      checkpoint_state: pending.state,
      active_dispatch_id: dispatch.id,
      active_dispatch_task_id: dispatch.task_id,
      active_dispatch_state: dispatch.status,
    });
  }
  return pending;
}

function requireCheckpointBaselineIntegrity(store: Store, task: TaskContract): TaskCheckpoint | undefined {
  const checkpoint = [...store.listCheckpoints(task.id)]
    .reverse()
    .find((item) => item.checkpoint_commit === task.base_commit);
  if (checkpoint) verifyCheckpointIntentGit(checkpoint);
  return checkpoint;
}

export function inspectClaimableTask(
  store: Store,
  git: GitSnapshot,
  actor: Role,
  taskId: string,
): ClaimTicket {
  const task = requireTask(store, taskId);
  if (task.status !== 'READY') {
    throw new DomainError('ILLEGAL_TRANSITION', `Cannot claim task in status ${task.status}`, {
      status: task.status,
    });
  }
  if (!canClaimTaskType(actor, task.type)) {
    throw new DomainError('WRONG_TASK_TYPE', `${actor} cannot claim ${task.type} tasks`, {
      role: actor,
      type: task.type,
    });
  }
  requireClaimBaseline(git, {
    repo_root: task.repo_root,
    branch: task.branch,
    base_commit: task.base_commit,
  });
  requireCheckpointBaselineIntegrity(store, task);
  return {
    task_id: task.id,
    type: task.type,
    status: 'READY',
    revision: task.revision,
    assignee_role: assigneeForType(task.type),
    repo_root: task.repo_root,
    base_commit: task.base_commit,
    branch: task.branch,
  };
}

export function claimTask(
  store: Store,
  git: GitSnapshot,
  actor: Role,
  executionInstanceId: string,
  taskId: string,
  revision: number,
  dispatch?: DispatchRun,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, taskId);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, revision);
    if (task.status !== 'READY') {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot claim task in status ${task.status}`,
        { status: task.status },
      );
    }
    if (!canClaimTaskType(actor, task.type)) {
      throw new DomainError(
        'WRONG_TASK_TYPE',
        `${actor} cannot claim ${task.type} tasks`,
        { role: actor, type: task.type },
      );
    }
    requireClaimBaseline(git, {
      repo_root: task.repo_root,
      branch: task.branch,
      base_commit: task.base_commit,
    });
    requireCheckpointBaselineIntegrity(store, task);
    const running = store.getRunning();
    if (running) {
      throw new DomainError(
        'TASK_ALREADY_RUNNING',
        `Task ${running.id} is already RUNNING`,
        { running_task_id: running.id, running_type: running.type },
      );
    }

    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'RUNNING',
      assignee_role: actor === 'JUNIOR' ? 'JUNIOR' : 'PRINCIPAL',
      execution_instance_id: executionInstanceId,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: actor,
      kind: 'claimed',
      from_status: 'READY',
      to_status: 'RUNNING',
      revision: next.revision,
      detail: { execution_instance_id: next.execution_instance_id },
    });
    if (dispatch) store.updateDispatchRun(dispatch);
    return next;
  });
}

function typeForWorker(actor: Role): TaskType {
  if (actor === 'JUNIOR') {
    return 'IMPLEMENTATION';
  }
  if (actor === 'PRINCIPAL') {
    return 'DIAGNOSIS';
  }
  throw new DomainError(
    'ROLE_FORBIDDEN',
    `Only workers can claim the next task; ${actor} cannot claim`,
  );
}

export function claimNextTask(
  store: Store,
  git: GitSnapshot,
  actor: Role,
  executionInstanceId: string,
): TaskContract {
  return store.transact(() => {
    const type = typeForWorker(actor);
    requireNoRepositoryCheckpoint(store);
    const running = store.getRunning();
    if (running) {
      throw new DomainError(
        'TASK_ALREADY_RUNNING',
        `Task ${running.id} is already RUNNING`,
        { running_task_id: running.id, running_type: running.type },
      );
    }
    const task = store.getNextReady(type);
    if (!task) {
      throw new DomainError(
        'NO_PENDING_TASK',
        `No READY ${type} task is waiting to be claimed`,
        { type },
      );
    }
    requireClaimBaseline(git, {
      repo_root: task.repo_root,
      branch: task.branch,
      base_commit: task.base_commit,
    });
    requireCheckpointBaselineIntegrity(store, task);

    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'RUNNING',
      assignee_role: actor === 'JUNIOR' ? 'JUNIOR' : 'PRINCIPAL',
      execution_instance_id: executionInstanceId,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: actor,
      kind: 'claimed',
      from_status: 'READY',
      to_status: 'RUNNING',
      revision: next.revision,
      detail: { execution_instance_id: next.execution_instance_id },
    });
    return next;
  });
}

export function reportResult(
  store: Store,
  actor: Role,
  executionInstanceId: string,
  input: ReportResultInput,
  dispatch?: DispatchRun,
  runnerObserved?: RunnerObservedEvidence,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, input.revision);
    requireExecutionOwner(task, actor, executionInstanceId);
    if (task.status !== 'RUNNING') {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot report result from status ${task.status}`,
        { status: task.status },
      );
    }
    const parsedResult = resultForType(task.type, input.result);
    const result = resultForType(task.type, {
      ...parsedResult,
      evidence: {
        worker_reported: workerReportedEvidence(parsedResult),
        ...(runnerObserved ? { runner_observed: runnerObserved } : {}),
        server_authoritative: authoritativeEvidence(task, actor),
      },
    });
    const timestamp = nowIso();
    const nextStatus: TaskStatus = input.outcome === 'completed' ? 'COMPLETED' : 'FAILED';
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: nextStatus,
      execution_instance_id: null,
      result,
      blocker: null,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: actor,
      kind: 'result',
      from_status: 'RUNNING',
      to_status: nextStatus,
      revision: next.revision,
      detail: { outcome: input.outcome, result },
    });
    if (dispatch) store.updateDispatchRun(dispatch);
    return next;
  });
}

export function reportBlocked(
  store: Store,
  actor: Role,
  executionInstanceId: string,
  input: ReportBlockedInput,
  dispatch?: DispatchRun,
  runnerObserved?: RunnerObservedEvidence,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, input.revision);
    requireExecutionOwner(task, actor, executionInstanceId);
    if (task.status !== 'RUNNING') {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot report blocked from status ${task.status}`,
        { status: task.status },
      );
    }
    const parsedBlocker = workerBlockerSchema.parse(input.blocker);
    const blocker = {
      ...parsedBlocker,
      evidence: {
        worker_reported: workerReportedEvidence({
          ...parsedBlocker,
          blocker_classification: parsedBlocker.reason,
        }),
        ...(runnerObserved ? { runner_observed: runnerObserved } : {}),
        server_authoritative: authoritativeEvidence(task, actor),
      },
    };
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'BLOCKED',
      execution_instance_id: null,
      blocker,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: actor,
      kind: 'blocked',
      from_status: 'RUNNING',
      to_status: 'BLOCKED',
      revision: next.revision,
      detail: { blocker },
    });
    if (dispatch) store.updateDispatchRun(dispatch);
    return next;
  });
}

export function recoverTask(
  store: Store,
  git: GitSnapshot,
  input: RecoverTaskInput,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, input.revision);
    if (task.status !== 'RUNNING') {
      throw new DomainError(
        'INVALID_RECOVERY_STATE',
        `Cannot recover task in status ${task.status}; only RUNNING tasks can be explicitly recovered`,
        { task_id: task.id, status: task.status },
      );
    }
    requireSameRepository(git, task.repo_root);

    const timestamp = nowIso();
    const blocker = {
      reason: 'CONTEXT_STALE' as const,
      summary: `OWNER explicitly recovered a RUNNING task at ${timestamp}; no completion was reported.`,
      need_from_owner: 'Inspect repository state, then resume or cancel this task.',
      evidence_refs: [],
      recovery: {
        reason: 'EXPLICIT_OWNER_RECOVERY' as const,
        previous_status: 'RUNNING' as const,
        detected_at: timestamp,
        detected_by_role: 'OWNER' as const,
        retry_safe: false,
        prior_execution_instance_id: task.execution_instance_id ?? undefined,
      },
    };
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'BLOCKED',
      execution_instance_id: null,
      blocker,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: 'OWNER',
      kind: 'blocked',
      from_status: 'RUNNING',
      to_status: 'BLOCKED',
      revision: next.revision,
      detail: {
        recovery: blocker.recovery,
        prior_execution_instance_id: task.execution_instance_id,
        blocker: next.blocker,
      },
    });
    store.failActiveDispatchForTask(next.id, 'EXPLICIT_OWNER_RECOVERY', 'Active dispatch terminated by explicit OWNER recovery');
    return next;
  });
}

export function checkpointTask(
  store: Store,
  git: GitSnapshot,
  input: CheckpointTaskInput,
  options?: { onStage?: (stage: CheckpointFailureStage) => void },
): { task: TaskContract; checkpoint: TaskCheckpoint } {
  let task = requireTask(store, input.task_id);
  requireSameRepository(git, task.repo_root);
  let intent = store.getCheckpointForRevision(input.task_id, input.revision);
  if (intent) {
    if (intent.purpose !== input.purpose) {
      throw new DomainError('CHECKPOINT_REQUEST_MISMATCH', 'Checkpoint retry does not match the durable request', {
        expected_purpose: intent.purpose,
        actual_purpose: input.purpose,
      });
    }
    if (intent.state === 'FINALIZED') {
      requireNoRepositoryCheckpoint(store);
      if (task.revision !== intent.producer_revision + 1 || task.base_commit !== intent.checkpoint_commit) {
        throw new DomainError('CHECKPOINT_REQUEST_MISMATCH', 'Finalized checkpoint retry no longer matches task state');
      }
      verifyCheckpointIntentGit(intent);
      return { task, checkpoint: finalizedCheckpoint(intent) };
    }
    intent = requireCheckpointRecoveryExclusive(store, intent);
  } else {
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, input.revision);
    if (task.type !== 'IMPLEMENTATION') {
      throw new DomainError(
        'INVALID_CHECKPOINT_STATE',
        `Cannot checkpoint ${task.type} task in status ${task.status}`,
        { task_id: task.id, type: task.type, status: task.status },
      );
    }
    const validPurposeState =
      (input.purpose === 'RESUME' && (task.status === 'BLOCKED' || task.status === 'FAILED')) ||
      (input.purpose === 'REVIEW' && task.status === 'COMPLETED');
    if (!validPurposeState) {
      throw new DomainError('INVALID_CHECKPOINT_STATE', `Checkpoint purpose ${input.purpose} is invalid for ${task.status}`, {
        task_id: task.id,
        status: task.status,
        purpose: input.purpose,
      });
    }
    const running = store.getRunning();
    if (running) {
      throw new DomainError(
        'TASK_ALREADY_RUNNING',
        `Cannot checkpoint while task ${running.id} is RUNNING`,
        { running_task_id: running.id, running_type: running.type },
      );
    }
    const dispatch = store.getActiveDispatch();
    if (dispatch) {
      throw new DomainError('CHECKPOINT_FINALIZATION_REQUIRED', `Cannot checkpoint while dispatch ${dispatch.id} is active`, {
        active_dispatch_id: dispatch.id,
        active_dispatch_task_id: dispatch.task_id,
        active_dispatch_state: dispatch.status,
      });
    }
    const payload = implementationPayloadSchema.parse(task.payload);
    const reportedChangedFiles =
      task.blocker?.changed_files ??
      (task.result && 'changed_files' in task.result ? task.result.changed_files : undefined);
    const timestamp = nowIso();
    const plan = planGitCheckpoint(task.repo_root, {
      taskId: task.id,
      producerRevision: task.revision,
      purpose: input.purpose,
      priorBaseCommit: task.base_commit,
      branch: task.branch,
      allowedScope: payload.allowed_scope,
      forbiddenScope: payload.forbidden_scope,
      expectedChangedFiles: reportedChangedFiles,
      timestamp,
    });
    intent = {
      id: randomUUID(),
      task_id: task.id,
      producer_revision: task.revision,
      purpose: input.purpose,
      state: 'PREPARED',
      request_identity: plan.requestIdentity,
      repo_root: plan.repoRoot,
      prior_base_commit: task.base_commit,
      expected_tree: plan.expectedTree,
      scope_identity: plan.scopeIdentity,
      checkpoint_commit: null,
      checkpoint_ref: plan.checkpointRef,
      branch: task.branch,
      changed_files: plan.changedFiles,
      created_at: timestamp,
      finalized_at: null,
    };
    store.transact(() => {
      requireNoRepositoryCheckpoint(store);
      const current = requireTask(store, task.id);
      requireRevision(current, input.revision);
      if (
        current.type !== task.type ||
        current.status !== task.status ||
        current.repo_root !== task.repo_root ||
        current.base_commit !== task.base_commit ||
        current.branch !== task.branch
      ) {
        throw new DomainError('CHECKPOINT_REQUEST_MISMATCH', 'Task changed while checkpoint intent was being prepared', {
          task_id: task.id,
          producer_revision: input.revision,
        });
      }
      const currentRunning = store.getRunning();
      if (currentRunning) {
        throw new DomainError('TASK_ALREADY_RUNNING', `Cannot checkpoint while task ${currentRunning.id} is RUNNING`, {
          running_task_id: currentRunning.id,
          running_type: currentRunning.type,
        });
      }
      const currentDispatch = store.getActiveDispatch();
      if (currentDispatch) {
        throw new DomainError('CHECKPOINT_FINALIZATION_REQUIRED', `Cannot checkpoint while dispatch ${currentDispatch.id} is active`, {
          active_dispatch_id: currentDispatch.id,
          active_dispatch_task_id: currentDispatch.task_id,
          active_dispatch_state: currentDispatch.status,
        });
      }
      store.insertCheckpointIntent(intent!);
    });
    options?.onStage?.('after_intent');
    intent = requireCheckpointRecoveryExclusive(store, intent);
  }

  const payload = implementationPayloadSchema.parse(task.payload);
  const plan = checkpointPlanFromIntent(intent, payload);
  let checkpointCommit: string;
  if (intent.state === 'FINALIZING') {
    if (!intent.checkpoint_commit) {
      throw new DomainError('CHECKPOINT_PROVENANCE_MISMATCH', 'FINALIZING checkpoint has no commit');
    }
    checkpointCommit = intent.checkpoint_commit;
    verifyCheckpointIntentGit(intent);
  } else {
    intent = requireCheckpointRecoveryExclusive(store, intent);
    checkpointCommit = applyGitCheckpoint(task.repo_root, plan, (stage) => {
      options?.onStage?.(stageForGit(stage));
    });
    intent = requireCheckpointRecoveryExclusive(store, intent);
    store.transact(() => store.setCheckpointState(intent!.id, 'GIT_APPLIED'));
    options?.onStage?.('after_git_applied_record');
    intent = requireCheckpointRecoveryExclusive(store, intent);
  }
  if (intent.state !== 'FINALIZING') {
    intent = requireCheckpointRecoveryExclusive(store, intent);
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      base_commit: checkpointCommit,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.transact(
      () => {
        intent = requireCheckpointRecoveryExclusive(store, intent!);
        store.setCheckpointState(intent!.id, 'FINALIZING', checkpointCommit);
        options?.onStage?.('after_checkpoint_row');
        store.updateTask(next);
        options?.onStage?.('after_task_update');
        store.insertEvent({
          task_id: task.id,
          at: timestamp,
          actor_role: 'OWNER',
          kind: 'checkpointed',
          from_status: task.status,
          to_status: task.status,
          revision: next.revision,
          detail: { checkpoint_id: intent!.id, request_identity: intent!.request_identity },
        });
        options?.onStage?.('after_event_insert');
      },
      () => options?.onStage?.('before_finalize_transaction_commit'),
    );
    task = next;
  } else {
    intent = requireCheckpointRecoveryExclusive(store, intent);
    task = requireTask(store, task.id);
    if (task.revision !== intent.producer_revision + 1 || task.base_commit !== checkpointCommit) {
      throw new DomainError('CHECKPOINT_PROVENANCE_MISMATCH', 'Partially finalized checkpoint does not match task state');
    }
  }
  options?.onStage?.('after_finalize_transaction');
  intent = requireCheckpointRecoveryExclusive(store, intent);
  verifyCheckpointIntentGit({ ...intent, checkpoint_commit: checkpointCommit });
  const finalizedAt = nowIso();
  store.transact(
    () => {
      intent = requireCheckpointRecoveryExclusive(store, intent!);
      store.setCheckpointState(intent!.id, 'FINALIZED', checkpointCommit, finalizedAt);
    },
    () => options?.onStage?.('before_finalized_state_commit'),
  );
  options?.onStage?.('after_finalized_state_commit');
  intent = store.getCheckpointById(intent.id)!;
  try {
    verifyCheckpointIntentGit(intent);
  } catch (error) {
    store.transact(() => store.setCheckpointState(intent!.id, 'FINALIZING', checkpointCommit));
    throw error;
  }
  options?.onStage?.('after_response_commit');
  return { task: requireTask(store, task.id), checkpoint: finalizedCheckpoint(intent) };
}

export type CheckpointFailureStage =
  | 'after_intent'
  | 'after_commit_object'
  | 'after_checkpoint_ref'
  | 'after_branch_cas'
  | 'after_git_applied_record'
  | 'after_checkpoint_row'
  | 'after_task_update'
  | 'after_event_insert'
  | 'before_finalize_transaction_commit'
  | 'after_finalize_transaction'
  | 'before_finalized_state_commit'
  | 'after_finalized_state_commit'
  | 'after_response_commit';

function stageForGit(stage: CheckpointGitStage): CheckpointFailureStage {
  if (stage === 'commit_object') return 'after_commit_object';
  if (stage === 'checkpoint_ref') return 'after_checkpoint_ref';
  return 'after_branch_cas';
}

function checkpointPlanFromIntent(intent: CheckpointIntent, payload: ReturnType<typeof implementationPayloadSchema.parse>): GitCheckpointPlan {
  return {
    taskId: intent.task_id,
    producerRevision: intent.producer_revision,
    purpose: intent.purpose,
    repoRoot: intent.repo_root,
    priorBaseCommit: intent.prior_base_commit,
    branch: intent.branch,
    branchRef: `refs/heads/${intent.branch}`,
    checkpointRef: intent.checkpoint_ref,
    expectedTree: intent.expected_tree,
    changedFiles: intent.changed_files,
    scopeIdentity: intent.scope_identity,
    requestIdentity: intent.request_identity,
    allowedScope: payload.allowed_scope,
    forbiddenScope: payload.forbidden_scope,
    timestamp: intent.created_at,
    message: `Engineering MCP checkpoint ${intent.task_id} r${intent.producer_revision} ${intent.request_identity}`,
  };
}

function checkpointIdentity(intent: CheckpointIntent & { checkpoint_commit: string }): Parameters<typeof verifyGitCheckpointIdentity>[1] {
  return {
    taskId: intent.task_id,
    producerRevision: intent.producer_revision,
    repoRoot: intent.repo_root,
    priorBaseCommit: intent.prior_base_commit,
    branch: intent.branch,
    checkpointRef: intent.checkpoint_ref,
    expectedTree: intent.expected_tree,
    requestIdentity: intent.request_identity,
    checkpointCommit: intent.checkpoint_commit,
  };
}

function verifyCheckpointIntentGit(intent: CheckpointIntent): void {
  if (!intent.checkpoint_commit) {
    throw new DomainError('CHECKPOINT_FINALIZATION_REQUIRED', 'Checkpoint Git identity is not finalized');
  }
  verifyGitCheckpointIdentity(intent.repo_root, checkpointIdentity(intent as CheckpointIntent & { checkpoint_commit: string }));
}

function finalizedCheckpoint(intent: CheckpointIntent): TaskCheckpoint {
  if (intent.state !== 'FINALIZED') {
    throw new DomainError('CHECKPOINT_FINALIZATION_REQUIRED', 'Checkpoint is not finalized', { state: intent.state });
  }
  return taskCheckpointSchema.parse(intent);
}

export function createDiagnosisFromCheckpoint(
  store: Store,
  git: GitSnapshot,
  input: CreateDiagnosisFromCheckpointInput,
): TaskContract {
  requireNoRepositoryCheckpoint(store);
  const checkpointIntent = store.getCheckpointById(input.checkpoint_id);
  if (
    !checkpointIntent ||
    checkpointIntent.task_id !== input.producer_task_id ||
    checkpointIntent.producer_revision !== input.producer_revision ||
    checkpointIntent.purpose !== 'REVIEW' ||
    checkpointIntent.state !== 'FINALIZED'
  ) {
    throw new DomainError('REVIEW_CHECKPOINT_BINDING_MISMATCH', 'REVIEW checkpoint identity does not match the requested producer');
  }
  const checkpoint = finalizedCheckpoint(checkpointIntent);
  const producer = requireTask(store, input.producer_task_id);
  if (
    producer.type !== 'IMPLEMENTATION' ||
    producer.status !== 'COMPLETED' ||
    producer.revision !== input.producer_revision + 1 ||
    producer.base_commit !== checkpoint.checkpoint_commit
  ) {
    throw new DomainError('REVIEW_CHECKPOINT_BINDING_MISMATCH', 'Producer task is not at the finalized REVIEW checkpoint');
  }
  verifyCheckpointIntentGit(checkpoint);
  requireClaimBaseline(git, {
    repo_root: checkpoint.repo_root,
    branch: checkpoint.branch,
    base_commit: checkpoint.checkpoint_commit,
  });
  const timestamp = nowIso();
  const source = {
    checkpoint_id: checkpoint.id,
    producer_task_id: checkpoint.task_id,
    producer_revision: checkpoint.producer_revision,
    checkpoint_commit: checkpoint.checkpoint_commit,
    checkpoint_ref: checkpoint.checkpoint_ref,
    prior_base_commit: checkpoint.prior_base_commit,
  };
  const diagnosis: TaskContract = {
    id: randomUUID(),
    type: 'DIAGNOSIS',
    status: 'READY',
    owner_role: 'OWNER',
    assignee_role: null,
    execution_instance_id: null,
    writer_generation: WRITER_PROTOCOL_GENERATION,
    repo_root: checkpoint.repo_root,
    base_commit: checkpoint.checkpoint_commit,
    branch: checkpoint.branch,
    source_checkpoint: source,
    payload: input.payload,
    result: null,
    blocker: null,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
  return store.transact(() => {
    requireNoRepositoryCheckpoint(store);
    const currentCheckpoint = store.getCheckpointById(checkpoint.id);
    const currentProducer = requireTask(store, producer.id);
    if (!currentCheckpoint || currentCheckpoint.state !== 'FINALIZED') {
      throw new DomainError('REVIEW_CHECKPOINT_BINDING_MISMATCH', 'REVIEW checkpoint is no longer finalized');
    }
    if (
      currentProducer.status !== 'COMPLETED' ||
      currentProducer.revision !== checkpoint.producer_revision + 1 ||
      currentProducer.base_commit !== checkpoint.checkpoint_commit
    ) {
      throw new DomainError('REVIEW_CHECKPOINT_BINDING_MISMATCH', 'Producer task moved after REVIEW handoff validation');
    }
    verifyCheckpointIntentGit(currentCheckpoint);
    store.insertTask(diagnosis);
    store.insertEvent({
      task_id: diagnosis.id,
      at: timestamp,
      actor_role: 'OWNER',
      kind: 'created',
      from_status: null,
      to_status: 'READY',
      revision: diagnosis.revision,
      detail: { source_checkpoint: source },
    });
    return diagnosis;
  });
}

export function resumeTask(
  store: Store,
  git: GitSnapshot,
  input: ResumeTaskInput,
): TaskContract {
  const existing = requireTask(store, input.task_id);
  requireNoRepositoryCheckpoint(store);
  const checkpoint = requireCheckpointBaselineIntegrity(store, existing);
  if (checkpoint?.purpose === 'REVIEW') {
    throw new DomainError('INVALID_CHECKPOINT_STATE', 'A REVIEW checkpoint cannot enter the resume path', {
      checkpoint_id: checkpoint.id,
    });
  }
  if (checkpoint) {
    requireClaimBaseline(git, {
      repo_root: existing.repo_root,
      branch: existing.branch,
      base_commit: checkpoint.checkpoint_commit,
    });
  } else {
    requireResumeBaseline(git, { repo_root: existing.repo_root, branch: existing.branch });
  }
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, input.revision);
    if (!RESUMABLE.has(task.status)) {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot resume task in status ${task.status}`,
        { status: task.status },
      );
    }
    if (checkpoint) {
      requireClaimBaseline(git, {
        repo_root: task.repo_root,
        branch: task.branch,
        base_commit: checkpoint.checkpoint_commit,
      });
      verifyCheckpointIntentGit(checkpoint);
    } else {
      requireResumeBaseline(git, { repo_root: task.repo_root, branch: task.branch });
    }
    const payload = input.payload === undefined ? task.payload : payloadForType(task.type, input.payload);
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'READY',
      assignee_role: null,
      execution_instance_id: null,
      base_commit: checkpoint?.checkpoint_commit ?? git.head,
      payload,
      result: null,
      blocker: null,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: 'OWNER',
      kind: 'resumed',
      from_status: task.status,
      to_status: 'READY',
      revision: next.revision,
      detail: {
        previous_status: task.status,
        previous_result: task.result,
        previous_blocker: task.blocker,
        previous_base_commit: task.base_commit,
        previous_payload: task.payload,
        new_base_commit: next.base_commit,
      },
    });
    return next;
  });
}

export function cancelTask(
  store: Store,
  taskId: string,
  revision: number,
  reason?: string,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, taskId);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, revision);
    if (!CANCELLABLE.has(task.status)) {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot cancel task in status ${task.status}`,
        { status: task.status },
      );
    }
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'CANCELLED',
      execution_instance_id: null,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: 'OWNER',
      kind: 'cancelled',
      from_status: task.status,
      to_status: 'CANCELLED',
      revision: next.revision,
      detail: reason === undefined ? null : { reason },
    });
    store.failActiveDispatchForTask(next.id, 'OWNER_CANCELLED', 'Active dispatch terminated by OWNER cancellation');
    return next;
  });
}

export function closeTask(
  store: Store,
  taskId: string,
  revision: number,
  decision?: string,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, taskId);
    requireNoRepositoryCheckpoint(store);
    requireRevision(task, revision);
    if (!CLOSABLE.has(task.status)) {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot close task in status ${task.status}`,
        { status: task.status },
      );
    }
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + WRITER_PROTOCOL_GENERATION,
      status: 'CLOSED',
      execution_instance_id: null,
      revision: task.revision + 1,
      updated_at: timestamp,
    };
    store.updateTask(next);
    store.insertEvent({
      task_id: next.id,
      at: timestamp,
      actor_role: 'OWNER',
      kind: 'closed',
      from_status: task.status,
      to_status: 'CLOSED',
      revision: next.revision,
      detail: decision === undefined ? null : { decision },
    });
    return next;
  });
}
