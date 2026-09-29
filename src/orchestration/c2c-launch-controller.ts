import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { testProcessTraceEnabled, traceTestProcess } from './v2-process-trace.ts';
import { executionWitnessPath, reserveExecutionWitness,
  waitForExecutionWitness } from './execution-group.ts';
import { boundedControlEnvironment } from './runtime-environment.ts';
import { verifyTrustedRuntime, assertProtectedRepositoryBinding, isProtectedExecutionMode,
  type TrustedRuntimeBinding } from './trusted-runtime.ts';
import { acquireProductionIdentityFrame } from './production-credential.ts';
import { validateIdentityFrame } from './development-identity-channel.ts';
import { assertRepositoryWriterAdmission, recordRepositoryLaunchRequest } from './repository-occupancy.ts';
import type { Store } from '../store.ts';
import type { DispatchRun, TaskContract } from '../types.ts';

export type C2CPhysicalObservation =
  | { kind: 'spawned'; pid: number | null }
  | { kind: 'error'; message: string }
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null };

export type ControlledC2CLaunchResult = {
  state: 'SPAWNED' | 'ALREADY_CLAIMED' | 'TERMINAL' | 'REFUSED';
  dispatch: DispatchRun;
  task: TaskContract;
  pid: number | null;
};

export type ControlledC2CLaunchOptions = {
  /** One-time binary frame supplied only by a local operator/test harness. */
  developmentIdentityFrame?: Buffer;
  onPhysicalObservation?: (observation: C2CPhysicalObservation) => void;
};

export function launchControlledC2CWorker(
  store: Store,
  repoRoot: string,
  dispatchRunId: string,
  options: ControlledC2CLaunchOptions = {},
): ControlledC2CLaunchResult {
  try { return launchWithOwnedFrame(store, repoRoot, dispatchRunId, options); }
  finally { options.developmentIdentityFrame?.fill(0); }
}

function launchWithOwnedFrame(store: Store, repoRoot: string, dispatchRunId: string,
  options: ControlledC2CLaunchOptions): ControlledC2CLaunchResult {
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

  const protectedMode = isProtectedExecutionMode();
  if (protectedMode && options.developmentIdentityFrame !== undefined) {
    options.onPhysicalObservation?.({ kind: 'error', message: 'production credential acquisition refused launch' });
    return { state: 'REFUSED', dispatch, task, pid: null };
  }

  const instanceId = randomUUID();
  let binding: ReturnType<typeof verifyTrustedRuntime>;
  try {
    binding = verifyTrustedRuntime();
    assertProtectedRepositoryBinding(store.path, repoRoot);
    assertRepositoryWriterAdmission(store, repoRoot, { currentDispatchId: dispatchRunId });
  } catch (error) {
    options.onPhysicalObservation?.({ kind: 'error', message: 'trusted runtime preflight refused launch' });
    traceTestProcess('bootstrap_preflight_refused', { dispatch_run_id: dispatchRunId,
      error_class: error instanceof Error ? error.name : 'unknown' });
    return { state: 'REFUSED', dispatch, task, pid: null };
  }
  let frame: Buffer;
  try {
    if (protectedMode) frame = acquireProductionIdentityFrame(binding);
    else {
      if (!options.developmentIdentityFrame) throw new Error('IDENTITY_FRAME_REFUSED');
      frame = options.developmentIdentityFrame;
      validateIdentityFrame(frame);
    }
  } catch {
    options.onPhysicalObservation?.({ kind: 'error', message: protectedMode
      ? 'production credential acquisition refused launch' : 'development identity channel absent' });
    return { state: 'REFUSED', dispatch, task, pid: null };
  }
  try {
    return launchWithVerifiedFrame(store, repoRoot, dispatchRunId, options,
      binding, instanceId, dispatch, task, frame);
  } finally { frame.fill(0); }
}

function launchWithVerifiedFrame(store: Store, repoRoot: string, dispatchRunId: string,
  options: ControlledC2CLaunchOptions, binding: TrustedRuntimeBinding, instanceId: string,
  dispatch: DispatchRun, task: TaskContract, frame: Buffer): ControlledC2CLaunchResult {
  try {
    const reserved = store.transact(() => {
      assertRepositoryWriterAdmission(store, repoRoot, { currentDispatchId: dispatchRunId });
      return reserveExecutionWitness(store.path, dispatchRunId, instanceId, repoRoot);
    });
    if (!reserved) return { state: 'SPAWNED', dispatch, task, pid: null };
    // A committed request is never released on a physical-launch ambiguity.
    recordRepositoryLaunchRequest(store, repoRoot, dispatchRunId);
  } catch {
    options.onPhysicalObservation?.({ kind: 'error', message: 'repository reservation or witness security refused launch' });
    return { state: 'REFUSED', dispatch, task, pid: null };
  }
  let child: ChildProcess;
  traceTestProcess('bootstrap_spawn_requested', { dispatch_run_id: dispatchRunId,
    helper: binding.bootstrapHelper, runner_entry: binding.runnerEntry,
    shell: false, windowsHide: true, detached: true });
  try {
    child = spawn(
      binding.bootstrapHelper,
      [
        'launch',
        executionWitnessPath(store.path, dispatchRunId),
        binding.nodePath,
        binding.runnerEntry,
        binding.keeperPath,
        store.path,
        repoRoot,
        dispatchRunId,
        instanceId,
        binding.keeperSid,
      ],
      {
        cwd: binding.root,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: boundedControlEnvironment(),
      },
    );
  } catch (error) {
    // Once physical launch was requested, retain the exclusive reservation;
    // a launcher exception is not authoritative proof that no child exists.
    traceTestProcess('bootstrap_spawn_throw', { dispatch_run_id: dispatchRunId,
      message: error instanceof Error ? error.message : String(error) });
    // Ambiguous bootstrap retains the durable reservation. Never relaunch.
    options.onPhysicalObservation?.({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return { state: 'REFUSED', dispatch, task, pid: null };
  }

  const bootstrapPid = child.pid ?? null;
  // stream writes can outlive this synchronous call. Own a separate bounded
  // buffer until its write callback; the caller's frame is always cleared.
  const transferFrame = Buffer.from(frame);
  frame.fill(0);
  const clearFrame = () => transferFrame.fill(0);
  if (child.stdin) {
    child.stdin.once('error', clearFrame);
    child.stdin.once('close', clearFrame);
    try { child.stdin.end(transferFrame, clearFrame); }
    catch { clearFrame(); return { state: 'REFUSED', dispatch, task, pid: null }; }
  } else {
    clearFrame();
  }
  child.once('error', clearFrame);
  child.unref();
  const witness = waitForExecutionWitness(store.path, repoRoot, dispatchRunId, instanceId);
  const pid = witness?.runner_pid ?? null;
  traceTestProcess('bootstrap_spawn_returned', { dispatch_run_id: dispatchRunId,
    bootstrap_pid: bootstrapPid, runner_pid: pid, sealed: witness !== undefined });
  if (pid !== null) options.onPhysicalObservation?.({ kind: 'spawned', pid });

  if (testProcessTraceEnabled()) {
    let stdoutTail = '';
    let stderrTail = '';
    const tail = (value: string, chunk: Buffer) => (value + String(chunk)).slice(-2048);
    child.stdout?.on('data', (chunk: Buffer) => { stdoutTail = tail(stdoutTail, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = tail(stderrTail, chunk); });
    child.on('spawn', () => traceTestProcess('bootstrap_spawn', { dispatch_run_id: dispatchRunId, bootstrap_pid: bootstrapPid }));
    child.on('exit', (code, signal) => traceTestProcess('bootstrap_exit', {
      dispatch_run_id: dispatchRunId, bootstrap_pid: bootstrapPid, code, signal,
    }));
    child.on('close', (code, signal) => traceTestProcess('bootstrap_close', {
      dispatch_run_id: dispatchRunId, bootstrap_pid: bootstrapPid, code, signal, stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
    }));
    child.on('disconnect', () => traceTestProcess('bootstrap_disconnect', {
      dispatch_run_id: dispatchRunId, bootstrap_pid: bootstrapPid,
    }));
  }

  child.on('error', (error) => {
    traceTestProcess('bootstrap_error', { dispatch_run_id: dispatchRunId,
      bootstrap_pid: bootstrapPid, error_code: (error as NodeJS.ErrnoException).code ?? null,
      message: error.message });
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
