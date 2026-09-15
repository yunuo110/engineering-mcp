import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { changedFilesFromRepo, inspectRepo } from '../git.ts';
import { claimTask, reportBlocked, reportResult } from '../lifecycle.ts';
import { isPathAllowedByScope } from '../scope.ts';
import type { Store } from '../store.ts';
import type { GitSnapshot, RunnerObservedEvidence, TaskContract } from '../types.ts';
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

function ignoredFileSnapshot(repo: string): Map<string, string> {
  // Git enumerates ignored leaves, including descendants of ignored directories.
  // Do not prune caches or paths outside allowed_scope: their mutations must also
  // obey scope. Hash content rather than timestamps so unchanged artifacts are
  // not reported and a same-size edit with restored timestamps is still observed.
  const ignored = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const snapshot = new Map<string, string>();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const file of ignored.split('\0')) {
    if (!file) continue;
    const path = join(repo, file);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      // Observe the link itself; never traverse a link into another tree.
      snapshot.set(file, `${stat.mode}:link:${readlinkSync(path)}`);
    } else if (stat.isFile()) {
      const hash = createHash('sha256');
      const fd = openSync(path, 'r');
      try {
        let bytes: number;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, bytes));
        }
      } finally {
        closeSync(fd);
      }
      snapshot.set(file, `${stat.mode}:file:${hash.digest('hex')}`);
    } else {
      // An opaque nested repository or special file cannot be verified by this
      // file-content observer. Fail closed instead of treating it as unchanged.
      throw new Error(`Cannot verify ignored repository entry: ${file}`);
    }
  }
  return snapshot;
}

function isAllowedFile(task: TaskContract, file: string): boolean {
  if (task.type !== 'IMPLEMENTATION') return false;
  const { allowed_scope, forbidden_scope } = task.payload as { allowed_scope: string[]; forbidden_scope: string[] };
  return isPathAllowedByScope(file, allowed_scope, forbidden_scope);
}

function resultForWorker(task: TaskContract, result: WorkerResult, git: GitSnapshot, observedChangedFiles: string[]) {
  if (task.type !== 'IMPLEMENTATION') {
    throw new Error('WorkerRunner currently supports IMPLEMENTATION tasks only');
  }
  return {
    summary: result.summary,
    implementation_complete: result.implementation_complete,
    changed_files: observedChangedFiles,
    validation: result.validation,
    git: result.git,
    environment: result.environment,
    evidence: {
      worker_reported: {
        implementation_complete: result.implementation_complete,
        changed_files: result.changed_files,
        validation: result.validation,
        git: result.git,
        environment: result.environment,
      },
    },
    existing_tests_changed: [],
    scope_changes: [],
    unverified: result.known_limitations,
    working_tree_status: { clean: git.clean, porcelain: git.porcelain },
  };
}

function blockerForError(result: WorkerResult, errorCode: string | null, git: GitSnapshot, observedChangedFiles: string[]) {
  const authoritativeReason =
    errorCode === 'SCOPE_VIOLATION'
      ? 'SCOPE_CONFLICT'
      : errorCode === 'UNEXPECTED_HEAD_CHANGE'
        ? 'REPOSITORY_DIVERGED'
        : errorCode === 'WORKER_PROCESS_FAILED' || errorCode === 'WORKER_PROTOCOL_FAILURE'
          ? 'TOOL_FAILURE'
          : undefined;
  const reason = authoritativeReason ?? result.blocker_classification ?? 'OTHER';
  return {
    reason,
    summary: result.summary || `Worker blocked: ${errorCode}`,
    need_from_owner: 'Inspect worker output and repository state before resuming.',
    evidence_refs: [],
    implementation_complete: result.implementation_complete,
    changed_files: observedChangedFiles,
    validation: result.validation,
    git: result.git,
    environment: result.environment,
    evidence: {
      worker_reported: {
        implementation_complete: result.implementation_complete,
        changed_files: result.changed_files,
        validation: result.validation,
        git: result.git,
        environment: result.environment,
        blocker_classification: result.blocker_classification,
      },
    },
  };
}

function runnerObserved(git: GitSnapshot, changedFiles: string[], task: TaskContract): RunnerObservedEvidence {
  const rejected = changedFiles.filter((file) => !isAllowedFile(task, file)).sort();
  return {
    changed_files: [...changedFiles].sort(),
    git: {
      head: git.head,
      branch: git.branch,
      working_tree_status: { clean: git.clean, porcelain: git.porcelain },
    },
    scope: { status: rejected.length === 0 ? 'passed' : 'failed', rejected_files: rejected },
  };
}

export async function runWorkerRunner(input: RunnerInput): Promise<TaskContract> {
  const dispatch = input.store.getDispatchRun(input.dispatchRunId);
  if (!dispatch) {
    throw new Error(`dispatch run not found: ${input.dispatchRunId}`);
  }
  if (dispatch.task_id !== input.taskId || dispatch.status !== 'launching') {
    throw new Error('dispatch is not launching for this task');
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
    {
      ...dispatch,
      status: 'running',
      runner_instance_id: input.executionInstanceId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  );
  // Snapshot after our claim transaction, so an ignored in-repository ledger
  // does not make the runner's own bookkeeping look like a worker mutation.
  const ignoredBefore = ignoredFileSnapshot(input.git.repoRoot);

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
    if (workerResult.runner_error_code) {
      errorCode = workerResult.runner_error_code;
    }
  }

  const repoAfter = inspectRepo(input.git.repoRoot);
  const changed = new Set(changedFilesFromRepo(input.git.repoRoot));
  const ignoredAfter = ignoredFileSnapshot(input.git.repoRoot);
  for (const file of new Set([...ignoredBefore.keys(), ...ignoredAfter.keys()])) {
    if (ignoredBefore.get(file) !== ignoredAfter.get(file)) {
      changed.add(file);
    }
  }
  const changedFiles = [...changed];

  if (workerResult) {
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
  const finalDispatch = input.store.getDispatchRun(input.dispatchRunId);
  if (!finalDispatch || finalDispatch.status !== 'running' || finalDispatch.runner_instance_id !== input.executionInstanceId) {
    throw new Error('dispatch execution ownership lost');
  }
  const dispatchResult = {
    ...finalDispatch,
    finished_at: timestamp,
    exit_code: workerResult?.exit_code ?? null,
    error_code: errorCode,
    error_detail: workerResult?.blocked_reason ?? null,
    updated_at: timestamp,
  };
  let terminal: TaskContract;
  const observed = runnerObserved(repoAfter, changedFiles, claimed);
  if (workerResult && workerResult.outcome === 'completed' && errorCode === null) {
    terminal = reportResult(input.store, 'JUNIOR', input.executionInstanceId, {
      task_id: claimed.id,
      revision: claimed.revision,
      outcome: 'completed',
      result: resultForWorker(claimed, workerResult, repoAfter, changedFiles),
    }, { ...dispatchResult, status: 'completed' }, observed);
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
      blocker: blockerForError(result, errorCode ?? (workerResult ? null : 'WORKER_PROTOCOL_FAILURE'), repoAfter, changedFiles),
    }, { ...dispatchResult, status: 'blocked' }, observed);
  }

  return terminal;
}
