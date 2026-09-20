import { spawn, type ChildProcess } from 'node:child_process';
import { resolveRuntimeEntry } from '../runtime-resolver.ts';
import type { Store } from '../store.ts';
import type { DispatchRun, TaskContract } from '../types.ts';

const C2C_WORKER_RUNNER_ENTRY = resolveRuntimeEntry(import.meta.url, {
  source: './c2c-worker-runner-entry.ts',
  dist: './c2c-worker-runner-entry.js',
});

export type C2CPhysicalObservation =
  | { kind: 'spawned'; pid: number | null }
  | { kind: 'error'; message: string }
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null };

export type ControlledC2CLaunchResult = {
  state: 'SPAWNED' | 'ALREADY_CLAIMED' | 'TERMINAL';
  dispatch: DispatchRun;
  task: TaskContract;
  pid: number | null;
};

export type ControlledC2CLaunchOptions = {
  runnerEntry?: string;
  spawnWorker?: typeof spawn;
  onPhysicalObservation?: (observation: C2CPhysicalObservation) => void;
};

export function launchControlledC2CWorker(
  store: Store,
  repoRoot: string,
  dispatchRunId: string,
  options: ControlledC2CLaunchOptions = {},
): ControlledC2CLaunchResult {
  const receipt = store.getC2CDelegationIntentForDispatch(dispatchRunId);
  if (!receipt) {
    throw new Error(
      `C2C delegation receipt not found for dispatch ${dispatchRunId}`,
    );
  }

  const dispatch = store.getDispatchRun(dispatchRunId);
  const task = store.getTask(receipt.task_id);
  if (!dispatch || !task) {
    throw new Error('C2C dispatch/task disappeared');
  }
  if (task.repo_root !== repoRoot || dispatch.task_id !== task.id) {
    throw new Error('C2C launch repository/task binding mismatch');
  }

  if (
    dispatch.status === 'running' &&
    task.status === 'RUNNING' &&
    dispatch.runner_instance_id !== null &&
    dispatch.runner_instance_id === task.execution_instance_id
  ) {
    return {
      state: 'ALREADY_CLAIMED',
      dispatch,
      task,
      pid: dispatch.pid,
    };
  }

  if (
    dispatch.status === 'completed' ||
    dispatch.status === 'blocked' ||
    dispatch.status === 'failed'
  ) {
    return { state: 'TERMINAL', dispatch, task, pid: dispatch.pid };
  }

  if (
    dispatch.status !== 'launching' ||
    dispatch.runner_instance_id !== null ||
    task.status !== 'READY' ||
    task.revision !== receipt.accepted_revision
  ) {
    throw new Error(
      'C2C launch state is inconsistent; refusing physical Worker spawn',
    );
  }

  const spawnWorker = options.spawnWorker ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnWorker(
      process.execPath,
      [
        options.runnerEntry ?? C2C_WORKER_RUNNER_ENTRY,
        '--store',
        store.path,
        '--repo',
        repoRoot,
        '--dispatch',
        dispatchRunId,
      ],
      {
        cwd: repoRoot,
        shell: false,
        windowsHide: true,
      },
    );
  } catch (error) {
    // Physical spawn failure is diagnostic only. The logical dispatch remains
    // launching because another eligible Worker attempt may already exist.
    options.onPhysicalObservation?.({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return { state: 'SPAWNED', dispatch, task, pid: null };
  }

  const pid = child.pid ?? null;
  options.onPhysicalObservation?.({ kind: 'spawned', pid });

  child.on('error', (error) => {
    // Non-authoritative by design: never mutate task/dispatch here.
    options.onPhysicalObservation?.({
      kind: 'error',
      message: error.message,
    });
  });
  child.on('close', (code, signal) => {
    // Non-authoritative by design: never mutate task/dispatch here.
    options.onPhysicalObservation?.({ kind: 'close', code, signal });
  });

  return { state: 'SPAWNED', dispatch, task, pid };
}
