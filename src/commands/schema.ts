import { z } from 'zod/v4';
import { c2cMessageSchema } from '../c2c/schema.ts';

export const acceptPlanCommandSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    plan_message: c2cMessageSchema,
  })
  .strict();

export type AcceptPlanCommand = z.infer<typeof acceptPlanCommandSchema>;

export const normalizedPlanAcceptanceRowSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    evaluation_message_id: z.string().min(1).max(200),
    accepted_at: z.string().min(1),
  })
  .strict();

export type NormalizedPlanAcceptanceRow = z.infer<
  typeof normalizedPlanAcceptanceRowSchema
>;

export const planAcceptanceReceiptSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    evaluation_message_id: z.string().min(1).max(200),
    task_id: z.string().min(1),
    accepted_revision: z.number().int().positive(),
    accepted_at: z.string().min(1),
  })
  .strict();

export type PlanAcceptanceReceipt = z.infer<
  typeof planAcceptanceReceiptSchema
>;

export const PLAN_ACCEPTANCE_REJECT_CODES = [
  'INVALID_COMMAND',
  'INVALID_TRUSTED_CONTEXT',
  'ROLE_FORBIDDEN',
  'TASK_NOT_FOUND',
  'REPOSITORY_MISMATCH',
  'NOT_PLAN',
  'EVALUATION_RECEIPT_MISSING',
  'EVALUATION_MESSAGE_CONFLICT',
  'EVALUATION_TASK_MISMATCH',
  'EVALUATION_REVISION_MISMATCH',
  'EVALUATION_DECISION_MISMATCH',
  'TASK_NOT_READY',
  'REVISION_MISMATCH',
  'COMMAND_ID_CONFLICT',
  'PLAN_ALREADY_ACCEPTED',
] as const;

export type PlanAcceptanceRejectCode =
  (typeof PLAN_ACCEPTANCE_REJECT_CODES)[number];

export type PlanAcceptanceEvaluation =
  | {
      decision: 'ACCEPTED';
      receipt: PlanAcceptanceReceipt;
    }
  | {
      decision: 'NOOP_WITH_EXISTING_ACCEPTANCE';
      receipt: PlanAcceptanceReceipt;
    }
  | {
      decision: 'REJECT';
      code: PlanAcceptanceRejectCode;
      message: string;
    };
