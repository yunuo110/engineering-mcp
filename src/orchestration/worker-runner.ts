import { execFileSync } from 'node:child_process';
import { inspectRepo } from '../git.ts';
import { claimTask, reportBlocked, reportResult } from '../lifecycle.ts';
import type { Store } from '../store.ts';
import type { GitSnapshot, TaskContract } from '../types.ts';
import { workerResultSchema } from './types.ts';
import type { WorkerAdapter, WorkerResult } from './types.ts';

export type RunnerInput = {
  store: Store;
  git: GitSnapshot;
  taskId: string;
  expectedRevision: number;
  executionInstanceId: string;
  dispatchRunId: string;
  adapter: WorkerAdapter;
};

function changedFilesFromPorcelain(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function changedFilesFromRepo(repo: string): string[] {
  const porcelain = execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-uall'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  return changedFilesFromPorcelain(porcelain);
}

function isAllowedFile(task: TaskContract, file: string): boolean {
  if (task.type !== 'IMPLEMENTATION') return false;
  const { allowed_scope, forbidden_scope } = task.payload as { allowed_scope: string[]; forbidden_scope: string[] };
  const allowed = allowed_scope.some((scope: string) => file === scope || file.startsWith(`${scope}/`));
  const forbidden = forbidden_scope.some((scope: string) => file === scope || file.startsWith(`${scope}/`));
  return allowed && !forbidden;
}

function resultForWorker(task: TaskContract, result: WorkerResult, git: GitSnapshot) {
  if (task.type !== 'IMPLEMENTATION') {
    throw new Error('WorkerRunner currently supports IMPLEMENTATION tasks only');
  }
  return {
    summary: result.summary,
    changed_files: result.changed_files,
    validation: result.validation,
    existing_tests_changed: [],
    scope_changes: [],
    unverified: result.known_limitations,
    working_tree_status: { clean: git.clean, porcelain: git.porcelain },
  };
}

function blockerForError(task: TaskContract, result: WorkerResult, errorCode: string) {
  const reason =
    errorCode === 'SCOPE_VIOLATION'
      ? 'SCOPE_CONFLICT'
      : errorCode === 'UNEXPECTED_HEAD_CHANGE'
        ? 'REPOSITORY_DIVERGED'
        : 'OTHER';
  return {
    reason: reason as 'SCOPE_CONFLICT' | 'REPOSITORY_DIVERGED' | 'OTHER',
    summary: result.summary || `Worker blocked: ${errorCode}`,
    need_from_owner: 'Inspect worker output and repository state before resuming.',
    evidence_refs: [],
  };
}

export async function runWorkerRunner(input: RunnerInput): Promise<TaskContract> {
  const dispatch = input.store.getDispatchRun(input.dispatchRunId);
  if (!dispatch) {
    throw new Error(`dispatch run not found: ${input.dispatchRunId}`);
  }

  const taskBefore = input.store.getTask(input.taskId);
  if (!taskBefore) {
    throw new Error(`task not found: ${input.taskId}`);
  }

  if (taskBefore.status !== 'READY') {
    throw new Error('task is not READY');
  }
  if (taskBefore.revision !== input.expectedRevision) {
    throw new Error('revision mismatch');
  }

  const claimed = claimTask(
    input.store,
    input.git,
    'JUNIOR',
    input.executionInstanceId,
    input.taskId,
    input.expectedRevision,
  );

  // Claim succeeded before adapter is launched.
  const timestampAfterClaim = new Date().toISOString();
  const dispatchAfterClaim = input.store.getDispatchRun(input.dispatchRunId);
  if (dispatchAfterClaim) {
    input.store.updateDispatchRun({
      ...dispatchAfterClaim,
      status: 'running',
      runner_instance_id: input.executionInstanceId,
      started_at: timestampAfterClaim,
      updated_at: timestampAfterClaim,
    });
  }

  let workerResult: WorkerResult | null = null;
  let errorCode: string | null = null;
  try {
    workerResult = await input.adapter.execute({
      dispatchRunId: input.dispatchRunId,
      taskId: input.taskId,
      repositoryRoot: input.git.repoRoot,
      baseCommit: taskBefore.base_commit,
      task: claimed,
    });
  } catch (error) {
    errorCode = 'WORKER_PROCESS_FAILED';
    workerResult = {
      outcome: 'blocked',
      summary: error instanceof Error ? error.message : String(error),
      changed_files: [],
      validation: [],
      known_limitations: [],
      blocked_reason: 'WORKER_PROCESS_FAILED',
      exit_code: 1,
    };
  }

  if (workerResult) {
    const parsed = workerResultSchema.safeParse(workerResult);
    if (!parsed.success) {
      errorCode = 'WORKER_PROTOCOL_FAILURE';
      workerResult = {
        outcome: 'blocked',
        summary: 'Worker protocol validation failed',
        changed_files: [],
        validation: [],
        known_limitations: [],
        blocked_reason: 'WORKER_PROTOCOL_FAILURE',
        exit_code: workerResult.exit_code ?? 1,
      };
    }
  }

  if (workerResult && workerResult.outcome === 'blocked' && errorCode === null) {
    const reason = workerResult.blocked_reason;
    if (
      reason === 'WORKER_PROCESS_FAILED' ||
      reason === 'WORKER_PROTOCOL_FAILURE' ||
      reason === 'SCOPE_VIOLATION' ||
      reason === 'UNEXPECTED_HEAD_CHANGE'
    ) {
      errorCode = reason;
    }
  }

  const repoAfter = inspectRepo(input.git.repoRoot);
  const changedFiles = changedFilesFromRepo(input.git.repoRoot);

  if (workerResult && workerResult.outcome === 'completed') {
    if (repoAfter.head !== claimed.base_commit) {
      errorCode = 'UNEXPECTED_HEAD_CHANGE';
      workerResult.outcome = 'blocked';
      workerResult.blocked_reason = 'UNEXPECTED_HEAD_CHANGE';
    } else if (changedFiles.some((file) => !isAllowedFile(claimed, file))) {
      const outOfScope = changedFiles.filter((file) => !isAllowedFile(claimed, file));
      errorCode = 'SCOPE_VIOLATION';
      workerResult.outcome = 'blocked';
      workerResult.blocked_reason = `SCOPE_VIOLATION: ${outOfScope.join(', ')}`;
    }
  }

  if (!errorCode && workerResult && workerResult.outcome !== 'completed' && workerResult.outcome !== 'blocked') {
    errorCode = 'WORKER_PROTOCOL_FAILURE';
    workerResult = {
      ...workerResult,
      outcome: 'blocked',
      blocked_reason: 'WORKER_PROTOCOL_FAILURE',
    };
  }

  const timestamp = new Date().toISOString();
  let terminal: TaskContract;
  if (workerResult && workerResult.outcome === 'completed' && errorCode === null) {
    terminal = reportResult(input.store, 'JUNIOR', input.executionInstanceId, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: resultForWorker(claimed, workerResult, repoAfter),
    });
  } else {
    const result = workerResult ?? {
      outcome: 'blocked' as const,
      summary: 'Worker produced no result',
      changed_files: [],
      validation: [],
      known_limitations: [],
      blocked_reason: errorCode ?? 'WORKER_PROTOCOL_FAILURE',
      exit_code: 1,
    };
    terminal = reportBlocked(input.store, 'JUNIOR', input.executionInstanceId, {
      task_id: claimed.id,
      revision: claimed.revision,
      blocker: blockerForError(claimed, result, errorCode ?? 'WORKER_PROTOCOL_FAILURE'),
    });
  }

  const finalDispatch = input.store.getDispatchRun(input.dispatchRunId);
  if (finalDispatch) {
    input.store.updateDispatchRun({
      ...finalDispatch,
      status: terminal.status === 'COMPLETED' ? 'completed' : 'blocked',
      finished_at: timestamp,
      exit_code: workerResult?.exit_code ?? null,
      error_code: errorCode,
      error_detail: workerResult?.blocked_reason ?? null,
      updated_at: timestamp,
    });
  }

  return terminal;
}
