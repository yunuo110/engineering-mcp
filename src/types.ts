import { z } from 'zod/v4';

export const SCHEMA_VERSION = 1;
export const BUSY_TIMEOUT_MS = 5000;

export const ROLES = ['OWNER', 'JUNIOR', 'PRINCIPAL'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const PROCESS_ROLES = ['owner', 'junior', 'principal'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export const TASK_TYPES = ['IMPLEMENTATION', 'DIAGNOSIS'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const taskTypeSchema = z.enum(TASK_TYPES);

export const TASK_STATUSES = [
  'READY',
  'RUNNING',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'COMPLETED',
  'CLOSED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusSchema = z.enum(TASK_STATUSES);

export const ASSIGNEE_ROLES = ['JUNIOR', 'PRINCIPAL'] as const;
export type AssigneeRole = (typeof ASSIGNEE_ROLES)[number];
export const assigneeRoleSchema = z.enum(ASSIGNEE_ROLES);

export const EVENT_KINDS = [
  'created',
  'claimed',
  'result',
  'blocked',
  'resumed',
  'cancelled',
  'closed',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const eventKindSchema = z.enum(EVENT_KINDS);

export const implementationPayloadSchema = z.object({
  goal: z.string().min(1),
  parent_intent: z.string().min(1),
  allowed_scope: z.array(z.string()),
  forbidden_scope: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  validation_requirements: z.array(z.string()),
  context_files: z.array(z.string()),
  knowledge_refs: z.array(z.string()),
  parent_risk: z.string().min(1),
});
export type ImplementationPayload = z.infer<typeof implementationPayloadSchema>;

export const diagnosisPayloadSchema = z.object({
  problem: z.string().min(1),
  desired_outcome: z.string().min(1),
  confirmed_facts: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  disproved_hypotheses: z.array(z.string()),
  open_questions: z.array(z.string()),
  constraints: z.array(z.string()),
  context_files: z.array(z.string()),
  knowledge_refs: z.array(z.string()),
  risk: z.string().min(1),
});
export type DiagnosisPayload = z.infer<typeof diagnosisPayloadSchema>;

export const taskPayloadSchema = z.union([implementationPayloadSchema, diagnosisPayloadSchema]);
export type TaskPayload = z.infer<typeof taskPayloadSchema>;

export const validationStatusSchema = z.enum(['passed', 'failed', 'not_run']);

export const validationEntrySchema = z.object({
  check: z.string().min(1),
  status: validationStatusSchema,
});

export const workingTreeStatusSchema = z.object({
  clean: z.boolean(),
  porcelain: z.string(),
});

export const implementationResultSchema = z.object({
  summary: z.string().min(1),
  changed_files: z.array(z.string()),
  validation: z.array(validationEntrySchema),
  existing_tests_changed: z.array(z.string()),
  scope_changes: z.array(z.string()),
  unverified: z.array(z.string()),
  working_tree_status: workingTreeStatusSchema,
});
export type ImplementationResult = z.infer<typeof implementationResultSchema>;

export const diagnosisVerdictSchema = z.enum(['CONFIRMED', 'MOST_LIKELY', 'INSUFFICIENT_EVIDENCE']);
export const diagnosisConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const implementationRecommendationSchema = z.enum([
  'RETURN_TO_GROK',
  'DELEGATE_TO_LUNA',
  'SOL_DIRECT',
]);

export const diagnosisResultSchema = z
  .object({
    verdict: diagnosisVerdictSchema,
    root_cause: z.string().min(1).optional(),
    violated_invariant: z.string().min(1).optional(),
    evidence_refs: z.array(z.string()),
    alternatives_ruled_out: z.array(z.string()),
    minimal_repair: z.string().min(1).optional(),
    files_to_change: z.array(z.string()).optional(),
    files_not_to_change: z.array(z.string()).optional(),
    required_validation: z.array(z.string()).optional(),
    implementation_recommendation: implementationRecommendationSchema,
    confidence: diagnosisConfidenceSchema,
    remaining_unknowns: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === 'INSUFFICIENT_EVIDENCE') {
      if (value.remaining_unknowns.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'INSUFFICIENT_EVIDENCE requires remaining_unknowns',
          path: ['remaining_unknowns'],
        });
      }
      return;
    }
    if (!value.root_cause) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.verdict} requires root_cause`,
        path: ['root_cause'],
      });
    }
    if (!value.minimal_repair) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.verdict} requires minimal_repair`,
        path: ['minimal_repair'],
      });
    }
  });
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

export const taskResultSchema = z.union([implementationResultSchema, diagnosisResultSchema]);
export type TaskResult = z.infer<typeof taskResultSchema>;

export const blockerReasonSchema = z.enum([
  'SCOPE_CONFLICT',
  'PLAN_CONFLICT',
  'DECISION_REQUIRED',
  'CONTEXT_STALE',
  'REPOSITORY_DIVERGED',
  'OTHER',
]);

export const blockerSchema = z.object({
  reason: blockerReasonSchema,
  summary: z.string().min(1),
  need_from_owner: z.string().min(1),
  evidence_refs: z.array(z.string()),
});
export type Blocker = z.infer<typeof blockerSchema>;

export const taskContractSchema = z.object({
  id: z.string().min(1),
  type: taskTypeSchema,
  status: taskStatusSchema,
  owner_role: z.literal('OWNER'),
  assignee_role: assigneeRoleSchema.nullable(),
  repo_root: z.string().min(1),
  base_commit: z.string().min(1),
  branch: z.string().min(1),
  payload: taskPayloadSchema,
  result: taskResultSchema.nullable(),
  blocker: blockerSchema.nullable(),
  revision: z.number().int().positive(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type TaskContract = z.infer<typeof taskContractSchema>;

export const createTaskInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('IMPLEMENTATION'),
      payload: implementationPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('DIAGNOSIS'),
      payload: diagnosisPayloadSchema,
    })
    .strict(),
]);
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const taskIdRevisionSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
});

export const getTaskInputSchema = z.object({
  task_id: z.string().min(1),
});

export const listActiveTasksInputSchema = z.object({
  type: taskTypeSchema.optional(),
});

export const claimTaskInputSchema = taskIdRevisionSchema;

export const reportResultInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  outcome: z.enum(['completed', 'failed']),
  result: taskResultSchema,
});
export type ReportResultInput = z.infer<typeof reportResultInputSchema>;

export const reportBlockedInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  blocker: blockerSchema,
});
export type ReportBlockedInput = z.infer<typeof reportBlockedInputSchema>;

export const resumeTaskInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  payload: taskPayloadSchema.optional(),
});
export type ResumeTaskInput = z.infer<typeof resumeTaskInputSchema>;

export const cancelTaskInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  reason: z.string().min(1).optional(),
});

export const closeTaskInputSchema = z.object({
  task_id: z.string().min(1),
  revision: z.number().int().positive(),
  decision: z.string().min(1).optional(),
});

export const domainErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const failureOutputSchema = z.object({
  ok: z.literal(false),
  error: domainErrorBodySchema,
});

export const taskSuccessOutputSchema = z.object({
  ok: z.literal(true),
  task: taskContractSchema,
});

export const taskToolOutputSchema = z.discriminatedUnion('ok', [
  taskSuccessOutputSchema,
  failureOutputSchema,
]);

export const listSuccessOutputSchema = z.object({
  ok: z.literal(true),
  tasks: z.array(taskContractSchema),
});

export const listToolOutputSchema = z.discriminatedUnion('ok', [
  listSuccessOutputSchema,
  failureOutputSchema,
]);

export type GitSnapshot = {
  repoRoot: string;
  branch: string;
  head: string;
  clean: boolean;
  porcelain: string;
};

export type TaskEvent = {
  id: number;
  task_id: string;
  at: string;
  actor_role: Role;
  kind: EventKind;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  revision: number;
  detail: Record<string, unknown> | null;
};

export function processRoleToRole(processRole: ProcessRole): Role {
  if (processRole === 'owner') {
    return 'OWNER';
  }
  if (processRole === 'junior') {
    return 'JUNIOR';
  }
  return 'PRINCIPAL';
}

export function assigneeForType(type: TaskType): AssigneeRole {
  return type === 'IMPLEMENTATION' ? 'JUNIOR' : 'PRINCIPAL';
}

export function nowIso(): string {
  return new Date().toISOString();
}
