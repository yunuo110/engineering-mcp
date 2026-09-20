import { z } from 'zod/v4';
import { DomainError } from '../errors.ts';
import type { Store } from '../store.ts';
import { taskStatusSchema, DISPATCH_STATUSES, type ProcessRole } from '../types.ts';
import type { WorkerProfiles } from '../worker-profiles.ts';
import { durableEvaluateC2CMessage } from '../receipts/c2c-evaluation.ts';
import { acceptEvaluatedPlan } from '../commands/plan-acceptance.ts';
import {
  acceptPlanCommandSchema,
  planAcceptanceReceiptSchema,
  PLAN_ACCEPTANCE_REJECT_CODES,
} from '../commands/schema.ts';
import { createAcceptedDispatchIntent } from '../commands/delegation-intent.ts';
import {
  createAcceptedDispatchIntentCommandSchema,
  c2cDelegationIntentReceiptSchema,
  C2C_DELEGATION_REJECT_CODES,
} from '../commands/delegation-schema.ts';
import { launchControlledC2CWorker } from '../orchestration/c2c-launch-controller.ts';
import {
  c2cMessageSchema,
  c2cReceiptSchema,
  C2C_DECISIONS,
  C2C_PROTOCOL_VERSION,
  C2C_REJECT_CODES,
} from './schema.ts';
import { parseMessage, serializeForBoundedValidation } from './guards.ts';

export const executeC2CPlanInputSchema = z.object({
  plan_message: c2cMessageSchema,
  acceptance_command_id: acceptPlanCommandSchema.shape.command_id,
  delegation_command_id: createAcceptedDispatchIntentCommandSchema.shape.command_id,
  worker_profile_id: createAcceptedDispatchIntentCommandSchema.shape.worker_profile_id,
}).strict();
export type ExecuteC2CPlanInput = z.infer<typeof executeC2CPlanInputSchema>;

const evaluationProjection = z.object({
  decision: z.enum(C2C_DECISIONS),
  evaluated_revision: c2cReceiptSchema.shape.evaluated_revision.optional(),
}).strict();
const acceptanceProjection = planAcceptanceReceiptSchema.pick({ command_id: true }).extend({
  decision: z.enum(['REJECT', 'ACCEPTED', 'NOOP_WITH_EXISTING_ACCEPTANCE']),
  accepted_revision: planAcceptanceReceiptSchema.shape.accepted_revision.optional(),
}).strict();
const delegationProjection = c2cDelegationIntentReceiptSchema.pick({ command_id: true }).extend({
  decision: z.enum(['REJECT', 'CREATED', 'NOOP_WITH_EXISTING_DELEGATION']),
  dispatch_run_id: c2cDelegationIntentReceiptSchema.shape.dispatch_run_id.optional(),
  worker_profile_id: c2cDelegationIntentReceiptSchema.shape.worker_profile_id.optional(),
}).strict();
const launchProjection = z.object({
  state: z.enum(['SPAWNED', 'ALREADY_CLAIMED', 'TERMINAL']),
  dispatch_status: z.enum(DISPATCH_STATUSES),
  task_status: taskStatusSchema,
  physical_spawn_requested: z.boolean(),
  physical_spawn_observed: z.boolean(),
}).strict();
const stages = ['input', 'evaluation', 'acceptance', 'delegation', 'launch'] as const;
export const C2C_CONTROLLER_ERROR_CODES = [
  'CONTROLLER_DISABLED',
  'INVALID_COMMAND',
  'NOT_PLAN',
  'CONTROLLER_PHASE_FAILED',
  ...C2C_REJECT_CODES,
  ...PLAN_ACCEPTANCE_REJECT_CODES,
  ...C2C_DELEGATION_REJECT_CODES,
] as const;
export type C2CControllerErrorCode = (typeof C2C_CONTROLLER_ERROR_CODES)[number];
export const c2cControllerErrorCodeSchema = z.enum(C2C_CONTROLLER_ERROR_CODES);
const progressSchema = z.object({
  plan_message_id: c2cReceiptSchema.shape.message_id.optional(),
  task_id: c2cReceiptSchema.shape.task_id.optional(),
  evaluation: evaluationProjection.optional(),
  acceptance: acceptanceProjection.optional(),
  delegation: delegationProjection.optional(),
}).strict();
export const executeC2CPlanOutputSchema = z.discriminatedUnion('ok', [
  progressSchema.required().extend({ ok: z.literal(true), stage: z.literal('launch'), launch: launchProjection }).strict(),
  progressSchema.extend({
    ok: z.literal(false), stage: z.enum(stages),
    error: z.object({ code: c2cControllerErrorCodeSchema, message: z.string() }).strict(),
  }).strict(),
]);
export type C2CControllerResult = z.infer<typeof executeC2CPlanOutputSchema>;

/** Supplied only by server construction, never by tool arguments. */
export type C2CControllerContext = {
  processRole: ProcessRole;
  enableC2CController?: boolean;
  repoPath: string;
  store: Store;
  workerProfiles: WorkerProfiles;
};

export function assertC2CControllerMode(role: ProcessRole, enabled: boolean | undefined): void {
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new DomainError('USAGE', 'C2C controller enablement must be an explicit boolean');
  }
  if (enabled === true && role !== 'owner') {
    throw new DomainError('USAGE', '--enable-c2c-controller requires --role owner');
  }
}
export function assertC2CPrivateClientMode(
  role: ProcessRole,
  controllerEnabled: boolean | undefined,
  privateClient: boolean | undefined,
  contractVersion: string | undefined,
): void {
  if (privateClient !== undefined && typeof privateClient !== 'boolean') {
    throw new DomainError('USAGE', 'C2C private-client mode must be an explicit boolean');
  }
  if (privateClient === true) {
    if (role !== 'owner' || controllerEnabled !== true) {
      throw new DomainError(
        'USAGE',
        'C2C private-client mode requires the OWNER C2C controller',
      );
    }
    if (contractVersion !== C2C_PROTOCOL_VERSION) {
      throw new DomainError(
        'USAGE',
        `C2C private-client contract must be ${C2C_PROTOCOL_VERSION}`,
      );
    }
    return;
  }
  if (contractVersion !== undefined) {
    throw new DomainError(
      'USAGE',
      'C2C contract version is valid only for private-client mode',
    );
  }
}

function requestedProtocolVersion(rawInput: unknown): unknown {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined;
  const plan = (rawInput as Record<string, unknown>).plan_message;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return undefined;
  return (plan as Record<string, unknown>).protocol_version;
}

/**
 * Orchestration only. Each frozen phase keeps its own transaction and durable
 * identity. No lifecycle mutation, target discovery, claim, or retry inference
 * is implemented here. Exceptions expose neither upstream text nor details.
 */
export function executeC2CPlan(context: C2CControllerContext, rawInput: unknown): C2CControllerResult {
  let stage: (typeof stages)[number] = 'input';
  const progress: z.infer<typeof progressSchema> = {};
  const fail = (code: C2CControllerErrorCode): C2CControllerResult => ({
    ...progress, ok: false, stage,
    error: { code, message: 'C2C controller stopped at the indicated phase. Preserve request identities when retrying.' },
  });
  if (context.processRole !== 'owner' || context.enableC2CController !== true) return fail('CONTROLLER_DISABLED');
  try {
    const requestedVersion = requestedProtocolVersion(rawInput);
    if (requestedVersion !== undefined && requestedVersion !== C2C_PROTOCOL_VERSION) {
      return fail('INVALID_PROTOCOL_VERSION');
    }
    const input = executeC2CPlanInputSchema.safeParse(rawInput);
    if (!input.success) return fail('INVALID_COMMAND');
    const request = input.data;
    const bounded = serializeForBoundedValidation(request.plan_message);
    if (!bounded.ok) return fail(bounded.failure.code);
    const parsed = parseMessage(request.plan_message);
    if (!parsed.ok) return fail(parsed.failure.code);
    const plan = parsed.value;
    if (plan.state !== 'PLAN') return fail('NOT_PLAN');
    progress.plan_message_id = plan.message_id;
    progress.task_id = plan.task_id;
    const actor = { actor_role: 'OWNER' as const, repo_root: context.repoPath };

    stage = 'evaluation';
    const evaluation = durableEvaluateC2CMessage(context.store, plan, actor);
    progress.evaluation = { decision: evaluation.decision };
    if (evaluation.decision === 'REJECT') return fail(evaluation.code);
    progress.evaluation.evaluated_revision = evaluation.receipt.evaluated_revision;

    stage = 'acceptance';
    const acceptance = acceptEvaluatedPlan(context.store, {
      command_id: request.acceptance_command_id, plan_message: plan,
    }, actor);
    progress.acceptance = { decision: acceptance.decision, command_id: request.acceptance_command_id };
    if (acceptance.decision === 'REJECT') return fail(acceptance.code);
    progress.acceptance = {
      decision: acceptance.decision, command_id: acceptance.receipt.command_id,
      accepted_revision: acceptance.receipt.accepted_revision,
    };

    stage = 'delegation';
    const delegation = createAcceptedDispatchIntent(context.store, {
      command_id: request.delegation_command_id,
      acceptance_command_id: request.acceptance_command_id,
      worker_profile_id: request.worker_profile_id,
    }, actor, context.workerProfiles);
    progress.delegation = { decision: delegation.decision, command_id: request.delegation_command_id };
    if (delegation.decision === 'REJECT') return fail(delegation.code);
    progress.delegation = {
      decision: delegation.decision, command_id: delegation.receipt.command_id,
      dispatch_run_id: delegation.receipt.dispatch_run_id,
      worker_profile_id: delegation.receipt.worker_profile_id,
    };

    stage = 'launch';
    let observed = false;
    const launch = launchControlledC2CWorker(context.store, context.repoPath, delegation.receipt.dispatch_run_id, {
      onPhysicalObservation(observation) {
        // A PID observed synchronously is not a claim or successful execution.
        // Asynchronous error/close events remain diagnostic, never logical state.
        if (observation.kind === 'spawned' && observation.pid !== null) observed = true;
      },
    });
    return {
      ok: true, stage,
      plan_message_id: plan.message_id, task_id: plan.task_id,
      evaluation: progress.evaluation, acceptance: progress.acceptance, delegation: progress.delegation,
      launch: {
        state: launch.state, dispatch_status: launch.dispatch.status, task_status: launch.task.status,
        physical_spawn_requested: launch.state === 'SPAWNED', physical_spawn_observed: observed,
      },
    };
  } catch {
    // A committed earlier phase survives. Exact request replay resumes through
    // the same frozen APIs; an exception never manufactures a completion.
    return fail('CONTROLLER_PHASE_FAILED');
  }
}
