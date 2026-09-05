import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.ts';
import { canClaimTaskType, isWorkerRole } from './role.ts';
import type { Store } from './store.ts';
import {
  diagnosisPayloadSchema,
  diagnosisResultSchema,
  implementationPayloadSchema,
  implementationResultSchema,
  nowIso,
  type CreateTaskInput,
  type GitSnapshot,
  type RecoverTaskInput,
  type ReportBlockedInput,
  type ReportResultInput,
  type ResumeTaskInput,
  type Role,
  type TaskContract,
  type TaskPayload,
  type TaskStatus,
  type TaskType,
} from './types.ts';
import {
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
  requireCleanBaseline(git);
  const timestamp = nowIso();
  const task: TaskContract = {
    id: randomUUID(),
    type: input.type,
    status: 'READY',
    owner_role: 'OWNER',
    assignee_role: null,
    execution_instance_id: null,
    writer_generation: 2,
    repo_root: git.repoRoot,
    base_commit: git.head,
    branch: git.branch,
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

export function claimTask(
  store: Store,
  git: GitSnapshot,
  actor: Role,
  executionInstanceId: string,
  taskId: string,
  revision: number,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, taskId);
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
      writer_generation: task.writer_generation + 2,
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

    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + 2,
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
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireRevision(task, input.revision);
    requireExecutionOwner(task, actor, executionInstanceId);
    if (task.status !== 'RUNNING') {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot report result from status ${task.status}`,
        { status: task.status },
      );
    }
    const result = resultForType(task.type, input.result);
    const timestamp = nowIso();
    const nextStatus: TaskStatus = input.outcome === 'completed' ? 'COMPLETED' : 'FAILED';
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + 2,
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
    return next;
  });
}

export function reportBlocked(
  store: Store,
  actor: Role,
  executionInstanceId: string,
  input: ReportBlockedInput,
): TaskContract {
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireRevision(task, input.revision);
    requireExecutionOwner(task, actor, executionInstanceId);
    if (task.status !== 'RUNNING') {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot report blocked from status ${task.status}`,
        { status: task.status },
      );
    }
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + 2,
      status: 'BLOCKED',
      execution_instance_id: null,
      blocker: input.blocker,
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
      detail: { blocker: input.blocker },
    });
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
      writer_generation: task.writer_generation + 2,
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

export function resumeTask(
  store: Store,
  git: GitSnapshot,
  input: ResumeTaskInput,
): TaskContract {
  const existing = requireTask(store, input.task_id);
  requireResumeBaseline(git, { repo_root: existing.repo_root, branch: existing.branch });
  return store.transact(() => {
    const task = requireTask(store, input.task_id);
    requireRevision(task, input.revision);
    if (!RESUMABLE.has(task.status)) {
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot resume task in status ${task.status}`,
        { status: task.status },
      );
    }
    requireResumeBaseline(git, { repo_root: task.repo_root, branch: task.branch });
    const payload = input.payload === undefined ? task.payload : payloadForType(task.type, input.payload);
    const timestamp = nowIso();
    const next: TaskContract = {
      ...task,
      writer_generation: task.writer_generation + 2,
      status: 'READY',
      assignee_role: null,
      execution_instance_id: null,
      base_commit: git.head,
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
      writer_generation: task.writer_generation + 2,
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
      writer_generation: task.writer_generation + 2,
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
