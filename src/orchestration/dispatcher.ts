import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireClaimBaseline } from '../git.ts';
import type { DomainErrorCode } from '../errors.ts';
import type { Store } from '../store.ts';
import type { DispatchRun, GitSnapshot } from '../types.ts';
import { CodexExecAdapter } from '../adapters/codex-exec-adapter.ts';
import type { WorkerAdapter } from './types.ts';
import { runWorkerRunner } from './worker-runner.ts';
import { resolveRuntimeEntry } from '../runtime-resolver.ts';
import { dispatchRunDir } from '../dispatch-run-dir.ts';
import { requireNoRepositoryCheckpoint } from '../lifecycle.ts';
import { DomainError } from '../errors.ts';
import { isProtectedExecutionMode } from './trusted-runtime.ts';
import { assertRepositoryWriterAdmission } from './repository-occupancy.ts';

const WORKER_RUNNER_ENTRY = resolveRuntimeEntry(import.meta.url, {
  source: './worker-runner-entry.ts',
  dist: './worker-runner-entry.js',
});

export type DelegateOptions = {
  adapterId: string;
  workerProfileId?: string;
  inProcess?: boolean;
  executionInstanceId?: string;
  adapter?: WorkerAdapter;
  wait?: boolean;
  timeoutMs?: number;
  runnerEntry?: string;
  runnerArgs?: string[];
  manifestPath?: string;
  manifestSnapshot?: string;
  profile?: string;
  model?: string;
};

export async function delegateTask(
  store: Store,
  git: GitSnapshot,
  taskId: string,
  expectedRevision: number,
  options: DelegateOptions,
): Promise<DispatchRun> {
  if (isProtectedExecutionMode()) {
    throw new DomainError('ROLE_FORBIDDEN', 'Ordinary delegate_task is unavailable in protected execution mode');
  }
  requireNoRepositoryCheckpoint(store);
  const task = store.getTask(taskId);
  if (!task) throw new Error('task not found');
  if (task.status !== 'READY') {
    throw new Error(`task is not READY: ${task.status}`);
  }
  if (task.revision !== expectedRevision) {
    throw new Error('revision mismatch');
  }
  requireClaimBaseline(git, {
    repo_root: task.repo_root,
    branch: task.branch,
    base_commit: task.base_commit,
  });
  const existingActive = store.getActiveDispatchForTask(taskId);
  if (existingActive) {
    throw new Error('active dispatch already exists');
  }

  const timestamp = new Date().toISOString();
  const run: DispatchRun = {
    id: randomUUID(),
    task_id: taskId,
    worker_role: 'JUNIOR',
    adapter_id: options.adapterId,
    worker_profile_id: options.workerProfileId ?? null,
    runner_instance_id: null,
    pid: null,
    status: 'launching',
    started_at: null,
    finished_at: null,
    exit_code: null,
    error_code: null,
    error_detail: null,
    created_at: timestamp,
    updated_at: timestamp,
  };

  store.transact(() => {
    requireNoRepositoryCheckpoint(store);
    assertRepositoryWriterAdmission(store, git.repoRoot);
    store.insertDispatchRun(run);
  });

  if (options.inProcess && options.adapter && options.executionInstanceId) {
    try {
      await runWorkerRunner({
        store,
        git,
        taskId,
        expectedRevision,
        executionInstanceId: options.executionInstanceId,
        dispatchRunId: run.id,
        adapter: options.adapter,
      });
    } catch (error) {
      store.recordDispatchProcessObservation(run.id, { kind: 'failure', errorCode: 'CLAIM_FAILED',
        errorDetail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } else {
    let runnerManifestPath = options.manifestPath;
    if (options.manifestSnapshot) {
      runnerManifestPath = join(dispatchRunDir(run.id), 'manifest.yaml');
      writeFileSync(runnerManifestPath, options.manifestSnapshot, 'utf8');
    }
    const child = spawn(
      process.execPath,
      [
        options.runnerEntry ?? WORKER_RUNNER_ENTRY,
        '--store',
        store.path,
        '--repo',
        git.repoRoot,
        '--task',
        taskId,
        '--revision',
        String(expectedRevision),
        '--dispatch',
        run.id,
        '--adapter',
        options.adapterId,
        ...(runnerManifestPath ? ['--manifest', runnerManifestPath] : []),
        ...(options.profile ? ['--profile', options.profile] : []),
        ...(options.model ? ['--model', options.model] : []),
        ...(options.runnerArgs ?? []),
      ],
      {
        cwd: git.repoRoot,
        shell: false,
        windowsHide: true,
      },
    );
    store.recordDispatchProcessObservation(run.id, { kind: 'pid', pid: child.pid ?? null });
    child.on('error', (error) => {
      try {
        store.recordDispatchProcessObservation(run.id, { kind: 'failure', errorCode: 'WORKER_PROCESS_FAILED',
          errorDetail: `Failed to spawn worker runner: ${error.message}` });
      } catch {
        // Store may already be closed; dispatch cleanup is best-effort.
      }
    });
    child.on('close', () => {
      try {
        store.recordDispatchProcessObservation(run.id, { kind: 'failure', errorCode: 'WORKER_PROCESS_FAILED',
          errorDetail: 'Worker Runner exited before terminal dispatch update' });
      } catch {
        // Store may already be closed; dispatch cleanup is best-effort.
      }
    });
  }

  if (options.wait !== false) {
    return await waitForDispatch(store, run.id, options.timeoutMs ?? 120_000);
  }
  return store.getDispatchRun(run.id) ?? run;
}

export async function waitForDispatch(store: Store, dispatchRunId: string, timeoutMs: number): Promise<DispatchRun> {
  const started = Date.now();
  for (;;) {
    const run = store.getDispatchRun(dispatchRunId);
    if (!run) throw new Error('dispatch run not found');
    if (run.status === 'completed' || run.status === 'blocked' || run.status === 'failed') {
      return run;
    }
    if (Date.now() - started >= timeoutMs) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
