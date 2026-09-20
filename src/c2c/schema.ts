import { z } from 'zod/v4';
import {
  DISPATCH_STATUSES,
  assigneeRoleSchema,
  roleSchema,
  taskResultSchema,
  taskStatusSchema,
  taskTypeSchema,
} from '../types.ts';

export const C2C_PROTOCOL_VERSION = 'engineering-c2c/1' as const;
export const C2C_PRIVATE_OPERATION = 'execute_c2c_plan' as const;
export const C2C_PRIVATE_TRANSPORT = 'mcp-stdio' as const;
export const MAX_C2C_MESSAGE_BYTES = 64 * 1024;

export const C2C_WIRE_STATES = [
  'INIT',
  'PLAN',
  'EXECUTED',
  'DONE',
  'BLOCKED',
  'ERROR',
] as const;
export type C2CWireState = (typeof C2C_WIRE_STATES)[number];

export const C2C_DECISIONS = [
  'REJECT',
  'NOOP_WITH_EXISTING_RECEIPT',
  'REQUIRES_OWNER_ACTION',
  'READY_FOR_REVIEW',
] as const;
export type C2CDecision = (typeof C2C_DECISIONS)[number];

export const C2C_REJECT_CODES = [
  'MESSAGE_NOT_SERIALIZABLE',
  'MESSAGE_TOO_LARGE',
  'INVALID_PROTOCOL_VERSION',
  'INVALID_MESSAGE',
  'INVALID_TRUSTED_CONTEXT',
  'INVALID_AUTHORITATIVE_SNAPSHOT',
  'TASK_MISMATCH',
  'REPOSITORY_MISMATCH',
  'SENDER_ROLE_MISMATCH',
  'MESSAGE_ID_CONFLICT',
  'RECEIPT_TASK_MISMATCH',
  'REVISION_MISMATCH',
  'EXECUTED_RESULT_NOT_ACCEPTED',
  'EXECUTION_PROVENANCE_MISSING',
  'EXECUTION_PROVENANCE_MISMATCH',
] as const;
export type C2CRejectCode = (typeof C2C_REJECT_CODES)[number];

export const c2cWireStateSchema = z.enum(C2C_WIRE_STATES);

export const c2cMessageSchema = z
  .object({
    protocol_version: z.literal(C2C_PROTOCOL_VERSION),
    message_id: z.string().min(1).max(200),
    task_id: z.string().min(1).max(500),
    sender_role: roleSchema,
    state: c2cWireStateSchema,
    expected_revision: z.number().int().positive(),
    in_reply_to: z.string().min(1).max(200).optional(),
    goal: z.string().min(1).max(16_384).optional(),
    rationale: z.string().min(1).max(16_384).optional(),
    evidence_refs: z.array(z.string().min(1).max(2_048)).max(256).optional(),
    error: z.string().min(1).max(16_384).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'ERROR' && value.error === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'ERROR state requires error',
        path: ['error'],
      });
    }
  });

export type C2CMessage = z.infer<typeof c2cMessageSchema>;

export const trustedActorContextSchema = z
  .object({
    actor_role: roleSchema,
    repo_root: z.string().min(1),
    dispatch_run_id: z.string().min(1).optional(),
    runner_instance_id: z.string().min(1).optional(),
  })
  .strict();

export type TrustedActorContext = z.infer<typeof trustedActorContextSchema>;

export const authoritativeTaskSnapshotSchema = z
  .object({
    id: z.string().min(1),
    type: taskTypeSchema,
    status: taskStatusSchema,
    revision: z.number().int().positive(),
    repo_root: z.string().min(1),
    assignee_role: assigneeRoleSchema.nullable(),
    execution_instance_id: z.string().nullable(),
    result: taskResultSchema.nullable(),
  })
  .strict();

export type AuthoritativeTaskSnapshot = z.infer<typeof authoritativeTaskSnapshotSchema>;

export const authoritativeDispatchSnapshotSchema = z
  .object({
    id: z.string().min(1),
    task_id: z.string().min(1),
    worker_role: z.literal('JUNIOR'),
    runner_instance_id: z.string().min(1).nullable(),
    status: z.enum(DISPATCH_STATUSES),
  })
  .strict();

export type AuthoritativeDispatchSnapshot = z.infer<typeof authoritativeDispatchSnapshotSchema>;

export const c2cReceiptDecisionSchema = z.enum([
  'REQUIRES_OWNER_ACTION',
  'READY_FOR_REVIEW',
]);

export const c2cReceiptSchema = z
  .object({
    message_id: z.string().min(1).max(200),
    message_digest: z.string().regex(/^[0-9a-f]{64}$/),
    task_id: z.string().min(1),
    evaluated_revision: z.number().int().positive(),
    decision: c2cReceiptDecisionSchema,
  })
  .strict();

export type C2CReceipt = z.infer<typeof c2cReceiptSchema>;

export const authoritativeSnapshotSchema = z
  .object({
    task: authoritativeTaskSnapshotSchema,
    dispatch: authoritativeDispatchSnapshotSchema.optional(),
    existing_receipt: c2cReceiptSchema.optional(),
  })
  .strict();

export type AuthoritativeSnapshot = z.infer<typeof authoritativeSnapshotSchema>;

export type C2CRejectEvaluation = {
  decision: 'REJECT';
  code: C2CRejectCode;
  message: string;
};

export type C2CNoopEvaluation = {
  decision: 'NOOP_WITH_EXISTING_RECEIPT';
  receipt: C2CReceipt;
};

export type C2CAcceptedEvaluation = {
  decision: 'REQUIRES_OWNER_ACTION' | 'READY_FOR_REVIEW';
  receipt: C2CReceipt;
};

export type C2CEvaluation =
  | C2CRejectEvaluation
  | C2CNoopEvaluation
  | C2CAcceptedEvaluation;
