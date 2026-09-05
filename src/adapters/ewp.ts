import { z } from 'zod/v4';
import type { TaskContract } from '../types.ts';
import type { WorkerResult } from '../orchestration/types.ts';

export const EWP_PROTOCOL = 'engineering-worker/1';

export const ewpRequestSchema = z.object({
  protocol: z.literal(EWP_PROTOCOL),
  request_id: z.string().min(1),
  task: z.object({
    id: z.string().min(1),
    type: z.literal('IMPLEMENTATION'),
    goal: z.string().min(1),
    allowed_scope: z.array(z.string()),
    forbidden_scope: z.array(z.string()),
    acceptance_criteria: z.array(z.string()),
    validation_requirements: z.array(z.string()),
    context_files: z.array(z.string()),
    knowledge_refs: z.array(z.string()),
  }),
  repository: z.object({
    root: z.string().min(1),
    base_commit: z.string().min(1),
  }),
  worker: z.object({
    role: z.literal('JUNIOR'),
  }),
}).strict();

export type EwpRequest = z.infer<typeof ewpRequestSchema>;

export const ewpValidationEntrySchema = z.object({
  command: z.string().min(1),
  status: z.enum(['passed', 'failed', 'not_run']),
  summary: z.string().optional(),
});

export const ewpResultSchema = z.object({
  protocol: z.literal(EWP_PROTOCOL),
  outcome: z.enum(['completed', 'blocked']),
  summary: z.string().min(1),
  changed_files: z.array(z.string()),
  validation: z.array(ewpValidationEntrySchema),
  known_limitations: z.array(z.string()),
  blocked_reason: z.string().optional(),
  exit_code: z.number().int().nonnegative(),
}).strict();

export type EwpResult = z.infer<typeof ewpResultSchema>;

export function buildWorkerRequest(
  task: TaskContract,
  repositoryRoot: string,
  baseCommit: string,
  requestId: string,
): EwpRequest {
  if (task.type !== 'IMPLEMENTATION') {
    throw new Error('EWP/1 currently supports IMPLEMENTATION tasks only');
  }
  const payload = task.payload as {
    goal: string;
    allowed_scope: string[];
    forbidden_scope: string[];
    acceptance_criteria: string[];
    validation_requirements: string[];
    context_files: string[];
    knowledge_refs: string[];
  };
  return {
    protocol: EWP_PROTOCOL,
    request_id: requestId,
    task: {
      id: task.id,
      type: 'IMPLEMENTATION',
      goal: payload.goal,
      allowed_scope: payload.allowed_scope,
      forbidden_scope: payload.forbidden_scope,
      acceptance_criteria: payload.acceptance_criteria,
      validation_requirements: payload.validation_requirements,
      context_files: payload.context_files,
      knowledge_refs: payload.knowledge_refs,
    },
    repository: {
      root: repositoryRoot,
      base_commit: baseCommit,
    },
    worker: {
      role: 'JUNIOR',
    },
  };
}

export function ewpResultToWorkerResult(result: EwpResult): WorkerResult {
  return {
    outcome: result.outcome,
    summary: result.summary,
    changed_files: result.changed_files,
    validation: result.validation.map((entry) => ({
      check: entry.command,
      status: entry.status,
    })),
    known_limitations: result.known_limitations,
    blocked_reason: result.blocked_reason,
    exit_code: result.exit_code,
  };
}
