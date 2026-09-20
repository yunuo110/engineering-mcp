import {
  getDurableTargetRuntime,
  type DurableTargetRuntimeOptions,
} from '../c2c/durable-target-registry.ts';
import {
  claimC2CDispatchTask,
  failC2CDispatchBeforeClaim,
} from '../lifecycle.ts';
import type { Store } from '../store.ts';
import type { GitSnapshot, TaskContract } from '../types.ts';
import { runClaimedWorkerExecution } from './worker-runner.ts';

export type C2CWorkerRunnerInput = {
  store: Store;
  git: GitSnapshot;
  dispatchRunId: string;
  executionInstanceId: string;
  adapterOptions?: DurableTargetRuntimeOptions;
};

export async function runC2CWorkerRunner(
  input: C2CWorkerRunnerInput,
): Promise<TaskContract> {
  const receipt = input.store.getC2CDelegationIntentForDispatch(
    input.dispatchRunId,
  );
  if (!receipt) {
    throw new Error(
      `C2C delegation receipt not found for dispatch ${input.dispatchRunId}`,
    );
  }

  const dispatch = input.store.getDispatchRun(input.dispatchRunId);
  if (!dispatch) {
    throw new Error(`dispatch run not found: ${input.dispatchRunId}`);
  }
  if (
    dispatch.task_id !== receipt.task_id ||
    dispatch.status !== 'launching' ||
    dispatch.runner_instance_id !== null
  ) {
    throw new Error('C2C dispatch is not in pre-claim launching state');
  }

  const task = input.store.getTask(receipt.task_id);
  if (!task) {
    throw new Error(`task not found: ${receipt.task_id}`);
  }
  if (
    task.status !== 'READY' ||
    task.revision !== receipt.accepted_revision
  ) {
    throw new Error(
      'C2C task is no longer READY at the accepted revision',
    );
  }

  const targetRuntime = getDurableTargetRuntime(receipt.launch_spec.schema);
  const targetSpec = targetRuntime.parse(receipt.launch_spec);
  const verified = targetRuntime.preclaimVerify(
    targetSpec,
    input.adapterOptions,
  );
  if (!verified.ok) {
    try {
      failC2CDispatchBeforeClaim(
        input.store,
        dispatch.id,
        verified.code,
        verified.message,
      );
    } catch {
      // Another authoritative transition may have won the race. A pre-claim
      // verifier never overwrites a successful claim/cancel/recovery.
    }
    throw new Error(verified.message);
  }

  const claimed = claimC2CDispatchTask(
    input.store,
    input.git,
    input.executionInstanceId,
    dispatch.id,
  );

  const adapter = targetRuntime.createExactAdapter(
    targetSpec,
    input.adapterOptions,
  );

  return await runClaimedWorkerExecution(
    {
      store: input.store,
      git: input.git,
      taskId: receipt.task_id,
      expectedRevision: receipt.accepted_revision,
      executionInstanceId: input.executionInstanceId,
      dispatchRunId: dispatch.id,
      adapter,
    },
    claimed,
  );
}
