import { randomUUID } from 'node:crypto';
import { parseTrustedActorContext } from '../c2c/guards.ts';
import type { TrustedActorContext } from '../c2c/schema.ts';
import type { Store } from '../store.ts';
import { nowIso, type DispatchRun } from '../types.ts';
import type { WorkerProfiles } from '../worker-profiles.ts';
import {
  buildDurableTargetFromTrustedProfile,
  type BuiltDurableTarget,
  type DurableTargetBuildOptions,
} from '../c2c/durable-target-registry.ts';
import {
  createAcceptedDispatchIntentCommandSchema,
  type C2CDelegationEvaluation,
  type C2CDelegationRejectCode,
} from './delegation-schema.ts';

export type DelegationIntentStage =
  | 'after_validation'
  | 'after_dispatch_insert'
  | 'after_receipt_insert'
  | 'after_commit';

export type DelegationIntentOptions = {
  onStage?: (stage: DelegationIntentStage) => void;
  launchSpecBuildOptions?: DurableTargetBuildOptions;
};

function reject(
  code: C2CDelegationRejectCode,
  message: string,
): C2CDelegationEvaluation {
  return { decision: 'REJECT', code, message };
}

function requireOwnerAdmission(
  context: TrustedActorContext,
): C2CDelegationEvaluation | null {
  if (context.actor_role !== 'OWNER') {
    return reject(
      'ROLE_FORBIDDEN',
      'Only OWNER may create an accepted-PLAN dispatch intent',
    );
  }
  return null;
}

function repoFailure(
  context: TrustedActorContext,
  taskRepoRoot: string,
): C2CDelegationEvaluation | null {
  if (context.repo_root !== taskRepoRoot) {
    return reject(
      'REPOSITORY_MISMATCH',
      'Trusted repository does not match the authoritative task repository',
    );
  }
  return null;
}

export function createAcceptedDispatchIntent(
  store: Store,
  rawCommand: unknown,
  rawTrustedActorContext: unknown,
  workerProfiles: WorkerProfiles,
  options: DelegationIntentOptions = {},
): C2CDelegationEvaluation {
  const parsedCommand =
    createAcceptedDispatchIntentCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) {
    return reject(
      'INVALID_COMMAND',
      `Invalid accepted-PLAN delegation command: ${parsedCommand.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  const command = parsedCommand.data;

  const parsedContext = parseTrustedActorContext(rawTrustedActorContext);
  if (!parsedContext.ok) {
    return reject(
      'INVALID_TRUSTED_CONTEXT',
      parsedContext.failure.message,
    );
  }
  const context = parsedContext.value;
  const roleFailure = requireOwnerAdmission(context);
  if (roleFailure) return roleFailure;

  // Non-authoritative replay optimization only. If a receipt appears present,
  // skip mutable launcher discovery/hash. BEGIN IMMEDIATE below always repeats
  // the receipt lookup and all access-control checks.
  const preflightExisting = store.getC2CDelegationIntentReceipt(
    command.command_id,
  );

  let builtTarget: BuiltDurableTarget | undefined;
  if (!preflightExisting) {
    const built = buildDurableTargetFromTrustedProfile(
      workerProfiles,
      command.worker_profile_id,
      options.launchSpecBuildOptions,
    );
    if (!built.ok) {
      return reject(built.code, built.message);
    }
    builtTarget = built;
  }

  const result = store.transact<C2CDelegationEvaluation>(() => {
    const existing = store.getC2CDelegationIntentReceipt(command.command_id);
    if (existing) {
      const task = store.getTask(existing.task_id);
      if (!task) {
        return reject(
          'TASK_NOT_FOUND',
          `Task ${existing.task_id} was not found`,
        );
      }

      const repositoryFailure = repoFailure(context, task.repo_root);
      if (repositoryFailure) return repositoryFailure;

      if (
        command.acceptance_command_id !== existing.acceptance_command_id ||
        command.worker_profile_id !== existing.worker_profile_id
      ) {
        return reject(
          'COMMAND_ID_CONFLICT',
          'command_id was already used for a different delegation identity',
        );
      }

      options.onStage?.('after_validation');
      return {
        decision: 'NOOP_WITH_EXISTING_DELEGATION',
        receipt: existing,
      };
    }

    // If the transaction-external preflight saw a durable receipt, exact replay
    // must never re-resolve a mutable launch target. A disappeared receipt is
    // treated as corruption/external mutation, not as permission to create a
    // new command from freshly discovered launcher state.
    if (preflightExisting) {
      return reject(
        'COMMAND_RECEIPT_DISAPPEARED',
        'Delegation receipt disappeared between replay preflight and authoritative transaction lookup',
      );
    }

    if (!builtTarget) {
      return reject(
        'LAUNCH_TARGET_INVALID',
        'No first-attempt launch spec is available',
      );
    }

    const acceptance = store.getPlanAcceptanceReceipt(
      command.acceptance_command_id,
    );
    if (!acceptance) {
      return reject(
        'ACCEPTANCE_NOT_FOUND',
        `PLAN acceptance ${command.acceptance_command_id} was not found`,
      );
    }

    const task = store.getTask(acceptance.task_id);
    if (!task) {
      return reject(
        'TASK_NOT_FOUND',
        `Task ${acceptance.task_id} was not found`,
      );
    }

    const repositoryFailure = repoFailure(context, task.repo_root);
    if (repositoryFailure) return repositoryFailure;

    if (task.type !== 'IMPLEMENTATION') {
      return reject(
        'WRONG_TASK_TYPE',
        'S3B2A V1 supports only IMPLEMENTATION tasks',
      );
    }

    if (task.status !== 'READY') {
      return reject(
        'TASK_NOT_READY',
        `Cannot create delegation intent for task ${task.id} in status ${task.status}`,
      );
    }

    if (task.revision !== acceptance.accepted_revision) {
      return reject(
        'REVISION_MISMATCH',
        `Accepted revision ${acceptance.accepted_revision} is stale; authoritative task revision is ${task.revision}`,
      );
    }

    const consumed = store.getC2CDelegationIntentForAcceptance(
      acceptance.command_id,
    );
    if (consumed) {
      return reject(
        'ACCEPTANCE_ALREADY_CONSUMED',
        `PLAN acceptance ${acceptance.command_id} was already consumed by delegation command ${consumed.command_id}`,
      );
    }

    const pendingCheckpoint = store.getAnyUnfinalizedCheckpoint();
    if (pendingCheckpoint) {
      return reject(
        'CHECKPOINT_FINALIZATION_REQUIRED',
        `Repository has unfinished checkpoint ${pendingCheckpoint.id} in state ${pendingCheckpoint.state}`,
      );
    }

    const activeDispatch = store.getActiveDispatchForTask(task.id);
    if (activeDispatch) {
      return reject(
        'ACTIVE_DISPATCH_EXISTS',
        `Task ${task.id} already has active dispatch ${activeDispatch.id}`,
      );
    }

    options.onStage?.('after_validation');

    const createdAt = nowIso();
    const dispatch: DispatchRun = {
      id: randomUUID(),
      task_id: task.id,
      worker_role: 'JUNIOR',
      adapter_id: builtTarget.adapterId,
      worker_profile_id: command.worker_profile_id,
      runner_instance_id: null,
      pid: null,
      status: 'launching',
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_code: null,
      error_detail: null,
      created_at: createdAt,
      updated_at: createdAt,
    };

    store.insertDispatchRun(dispatch);
    options.onStage?.('after_dispatch_insert');

    store.insertC2CDelegationIntentReceipt({
      command_id: command.command_id,
      acceptance_command_id: acceptance.command_id,
      dispatch_run_id: dispatch.id,
      launch_spec: builtTarget.spec,
      created_at: createdAt,
    });
    options.onStage?.('after_receipt_insert');

    const receipt = store.getC2CDelegationIntentReceipt(command.command_id);
    if (!receipt) {
      throw new Error('delegation receipt projection disappeared after insert');
    }

    return {
      decision: 'CREATED',
      receipt,
    };
  });

  options.onStage?.('after_commit');
  return result;
}
