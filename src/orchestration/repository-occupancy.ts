import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '../errors.ts';
import type { Store } from '../store.ts';
import { executionWitnessDirectory, observeExecutionGroup } from './execution-group.ts';
import { assertProtectedRepositoryBinding, isProtectedExecutionMode } from './trusted-runtime.ts';

function assertRepositoryOccupancy(store: Store, repoRoot: string, currentDispatchId?: string): void {
  const protectedMode = isProtectedExecutionMode();
  if (protectedMode) assertProtectedRepositoryBinding(store.path, repoRoot);
  const dispatches = store.listRepositoryDispatchRuns(repoRoot);
  if (protectedMode) {
    // A legacy/manual claim has no Keeper inventory. Its later cancellation or
    // closure cannot manufacture drain proof when a ledger enters protected mode.
    const claims = store.listRepositoryExecutionClaims(repoRoot);
    for (const claim of claims) {
      const accounted = dispatches.some((dispatch) => {
        const receipt = store.getC2CDelegationIntentForDispatch(dispatch.id);
        return receipt && dispatch.task_id === claim.task_id
          && receipt.accepted_revision + 1 === claim.revision
          && typeof claim.detail?.execution_instance_id === 'string'
          && dispatch.runner_instance_id === claim.detail.execution_instance_id;
      });
      if (!accounted) {
        throw new DomainError('REPOSITORY_WRITER_OCCUPIED', 'Historical repository execution has no managed drain inventory',
          { task_id: claim.task_id, claim_revision: claim.revision, execution_group_state: 'UNKNOWN' });
      }
    }
    const running = store.getRunning();
    if (running && !claims.some((claim) => claim.task_id === running.id
      && claim.revision === running.revision && claim.detail?.execution_instance_id === running.execution_instance_id)) {
      throw new DomainError('REPOSITORY_WRITER_OCCUPIED', 'Running repository execution has no durable claim inventory',
        { task_id: running.id, execution_group_state: 'UNKNOWN' });
    }
  }
  if (currentDispatchId !== undefined) {
    const current = store.getDispatchRun(currentDispatchId);
    const task = current ? store.getTask(current.task_id) : undefined;
    if (!current || !task || task.repo_root !== repoRoot
      || (current.status !== 'launching' && current.status !== 'running')
      || (task.status !== 'READY' && task.status !== 'RUNNING')) {
      throw new DomainError('REPOSITORY_WRITER_OCCUPIED', 'Current execution does not own an active repository reservation',
        { dispatch_run_id: currentDispatchId });
    }
  }

  // Dispatch history, not Task status, owns occupancy. Cancel/close/report never
  // delete this inventory or reinterpret a missing receipt as a drained group.
  for (const dispatch of dispatches) {
    if (dispatch.id === currentDispatchId) continue;
    const managed = store.getC2CDelegationIntentForDispatch(dispatch.id) !== undefined;
    if (!managed && !protectedMode) {
      // Standard package recovery retains its explicit manual-stop contract.
      // This exception never satisfies protected execution admission.
      continue;
    } else if (store.getRepositoryLaunchState(dispatch.id) === 'NOT_REQUESTED'
      && dispatch.status !== 'launching' && dispatch.status !== 'running'
      && !existsSync(executionWitnessDirectory(store.path, dispatch.id))
      && !existsSync(join(dirname(store.path), 'execution-witnesses', `${dispatch.id}.json`))) {
      // Only the durable pre-launch record proves this terminal reservation
      // never requested a process. Legacy rows without it remain UNKNOWN.
      continue;
    }
    const group = observeExecutionGroup(store.path, repoRoot, dispatch.id, dispatch.runner_instance_id ?? undefined);
    if (group.state !== 'DRAINED') {
      throw new DomainError('REPOSITORY_WRITER_OCCUPIED', `Repository execution writers are ${group.state}`,
        { repo_root: repoRoot, task_id: dispatch.task_id, dispatch_run_id: dispatch.id,
          execution_group_state: group.state });
    }
  }
}

/** Call inside the same Store transaction as a new claim/dispatch reservation. */
export function assertRepositoryWriterAdmission(store: Store, repoRoot: string,
  options: { currentDispatchId?: string } = {}): void {
  assertRepositoryOccupancy(store, repoRoot, options.currentDispatchId);
  const active = store.listRepositoryDispatchRuns(repoRoot).find((dispatch) => dispatch.id !== options.currentDispatchId
    && (dispatch.status === 'launching' || dispatch.status === 'running'));
  if (active) {
    throw new DomainError('REPOSITORY_WRITER_OCCUPIED', 'Repository has another active dispatch reservation',
      { task_id: active.task_id, dispatch_run_id: active.id });
  }
  const running = store.getRunning();
  const current = options.currentDispatchId === undefined ? undefined : store.getDispatchRun(options.currentDispatchId);
  if (running && (!current || current.task_id !== running.id
    || current.runner_instance_id !== running.execution_instance_id)) {
    throw new DomainError('TASK_ALREADY_RUNNING', `Task ${running.id} is already RUNNING`,
      { running_task_id: running.id, running_type: running.type });
  }
}

/** Recovery/checkpoint require physical drain even when the ledger says terminal. */
export function assertRepositoryWritersDrained(store: Store, repoRoot: string): void {
  assertRepositoryOccupancy(store, repoRoot);
}

/** Commit immediately before the single physical launch; never retry on ambiguity. */
export function recordRepositoryLaunchRequest(store: Store, repoRoot: string, dispatchRunId: string): void {
  store.transact(() => {
    assertRepositoryWriterAdmission(store, repoRoot, { currentDispatchId: dispatchRunId });
    const receipt = store.getC2CDelegationIntentForDispatch(dispatchRunId);
    const dispatch = store.getDispatchRun(dispatchRunId);
    const task = dispatch ? store.getTask(dispatch.task_id) : undefined;
    if (!receipt || !dispatch || !task || dispatch.status !== 'launching'
      || dispatch.runner_instance_id !== null || task.status !== 'READY'
      || task.id !== receipt.task_id || task.revision !== receipt.accepted_revision) {
      throw new DomainError('ILLEGAL_TRANSITION', 'Launch reservation was revoked or changed');
    }
    store.requestRepositoryLaunch(dispatchRunId);
  });
}
