import { z } from 'zod/v4';
import {
  c2cReceiptDecisionSchema,
  type C2CReceipt,
} from '../c2c/schema.ts';

export const durableC2CEvaluationReceiptSchema = z
  .object({
    message_id: z.string().min(1).max(200),
    message_digest: z.string().regex(/^[0-9a-f]{64}$/),
    task_id: z.string().min(1),
    evaluated_revision: z.number().int().positive(),
    decision: c2cReceiptDecisionSchema,
    created_at: z.string().min(1),
  })
  .strict();

export type DurableC2CEvaluationReceipt = z.infer<
  typeof durableC2CEvaluationReceiptSchema
>;

export function toC2CReceipt(
  receipt: DurableC2CEvaluationReceipt,
): C2CReceipt {
  return {
    message_id: receipt.message_id,
    message_digest: receipt.message_digest,
    task_id: receipt.task_id,
    evaluated_revision: receipt.evaluated_revision,
    decision: receipt.decision,
  };
}
