import { z } from 'zod/v4';
import { durableTargetSpecSchema } from '../c2c/durable-target-registry.ts';

export const createAcceptedDispatchIntentCommandSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    acceptance_command_id: z.string().min(1).max(200),
    worker_profile_id: z.string().min(1).max(200),
  })
  .strict();

export type CreateAcceptedDispatchIntentCommand = z.infer<
  typeof createAcceptedDispatchIntentCommandSchema
>;

export const normalizedC2CDelegationReceiptRowSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    acceptance_command_id: z.string().min(1).max(200),
    dispatch_run_id: z.string().min(1),
    launch_spec: durableTargetSpecSchema,
    created_at: z.string().min(1),
  })
  .strict();

export type NormalizedC2CDelegationReceiptRow = z.infer<
  typeof normalizedC2CDelegationReceiptRowSchema
>;

export const c2cDelegationIntentReceiptSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    acceptance_command_id: z.string().min(1).max(200),
    dispatch_run_id: z.string().min(1),
    task_id: z.string().min(1),
    accepted_revision: z.number().int().positive(),
    worker_profile_id: z.string().min(1),
    adapter_id: z.string().min(1),
    dispatch_status: z.enum([
      'launching',
      'running',
      'completed',
      'blocked',
      'failed',
    ]),
    launch_spec: durableTargetSpecSchema,
    created_at: z.string().min(1),
  })
  .strict();

export type C2CDelegationIntentReceipt = z.infer<
  typeof c2cDelegationIntentReceiptSchema
>;

export const C2C_DELEGATION_REJECT_CODES = [
  'INVALID_COMMAND',
  'INVALID_TRUSTED_CONTEXT',
  'ROLE_FORBIDDEN',
  'COMMAND_ID_CONFLICT',
  'TASK_NOT_FOUND',
  'REPOSITORY_MISMATCH',
  'ACCEPTANCE_NOT_FOUND',
  'ACCEPTANCE_ALREADY_CONSUMED',
  'WRONG_TASK_TYPE',
  'TASK_NOT_READY',
  'REVISION_MISMATCH',
  'CHECKPOINT_FINALIZATION_REQUIRED',
  'ACTIVE_DISPATCH_EXISTS',
  'LAUNCH_TARGET_UNSUPPORTED',
  'LAUNCH_TARGET_INVALID',
  'DURABLE_TARGET_UNSUPPORTED',
  'COMMAND_RECEIPT_DISAPPEARED',
] as const;

export type C2CDelegationRejectCode =
  (typeof C2C_DELEGATION_REJECT_CODES)[number];

export type C2CDelegationEvaluation =
  | {
      decision: 'CREATED';
      receipt: C2CDelegationIntentReceipt;
    }
  | {
      decision: 'NOOP_WITH_EXISTING_DELEGATION';
      receipt: C2CDelegationIntentReceipt;
    }
  | {
      decision: 'REJECT';
      code: C2CDelegationRejectCode;
      message: string;
    };
