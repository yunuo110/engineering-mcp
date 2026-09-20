import { z } from 'zod/v4';
import {
  blockerReasonSchema, environmentEvidenceSchema, gitEvidenceSchema,
  validationCountsSchema, type ImplementationPayload,
} from '../types.ts';
import type { AdapterContext, WorkerResult } from '../orchestration/types.ts';

/** Frozen /1 serializer: independent of ordinary GenericCli prompt helpers. */
export function renderEngineeringGenericCliEwpNativeV1(context: AdapterContext): string {
  if (context.task.type !== 'IMPLEMENTATION') throw new Error('GenericCli EWP V1 requires IMPLEMENTATION');
  if (context.task.id !== context.taskId || context.task.repo_root !== context.repositoryRoot ||
      context.task.base_commit !== context.baseCommit) throw new Error('GenericCli EWP V1 context binding mismatch');
  const payload = context.task.payload as ImplementationPayload;
  return JSON.stringify({
    protocol: 'engineering-worker/1',
    request_id: context.dispatchRunId,
    task: {
      id: context.task.id,
      type: 'IMPLEMENTATION',
      goal: payload.goal,
      allowed_scope: payload.allowed_scope,
      forbidden_scope: payload.forbidden_scope,
      acceptance_criteria: payload.acceptance_criteria,
      validation_requirements: payload.validation_requirements,
      context_files: payload.context_files,
      knowledge_refs: payload.knowledge_refs,
    },
    repository: { root: context.repositoryRoot, base_commit: context.baseCommit },
    worker: { role: 'JUNIOR' },
  });
}

// Dedicated strict terminal envelope; ordinary result discovery cannot silently
// redefine this durable /1 contract. Shared S2 evidence schemas stay unchanged.
export const genericCliEwpResultV1Schema = z.object({
  protocol: z.literal('engineering-worker/1'),
  outcome: z.enum(['completed', 'blocked']),
  summary: z.string().min(1),
  changed_files: z.array(z.string()),
  validation: z.array(z.object({
    command: z.string().min(1),
    status: z.enum(['passed', 'failed', 'not_run']),
    summary: z.string().min(1).optional(),
    counts: validationCountsSchema.optional(),
  }).strict()),
  known_limitations: z.array(z.string()),
  blocked_reason: z.string().optional(),
  blocker_classification: blockerReasonSchema.optional(),
  implementation_complete: z.boolean().optional(),
  git: gitEvidenceSchema.optional(),
  environment: environmentEvidenceSchema.optional(),
  exit_code: z.number().int().nonnegative(),
}).strict();

/**
 * /1 last-object framing: allow progress text/objects before the final object,
 * including a multi-line final object. The last object must end stdout except
 * for whitespace. An invalid or unfinished final object never falls back to
 * an earlier success. Quotes and escaped braces are counted as string data.
 */
export function parseEngineeringGenericCliResultV1(stdout: string): WorkerResult | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = -1;
  let end = -1;
  let last = '';
  for (let i = 0; i < stdout.length; i++) {
    const char = stdout[i];
    if (depth === 0) {
      if (char === '{') { start = i; depth = 1; quoted = false; escaped = false; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      last = stdout.slice(start, i + 1);
      end = i + 1;
    }
  }
  if (depth !== 0 || end < 0 || stdout.slice(end).trim() !== '') return undefined;
  let raw: unknown;
  try { raw = JSON.parse(last); } catch { return undefined; }
  const parsed = genericCliEwpResultV1Schema.safeParse(raw);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  return {
    outcome: result.outcome,
    summary: result.summary,
    changed_files: result.changed_files,
    validation: result.validation.map((entry) => ({
      check: entry.command, command: entry.command, status: entry.status,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      ...(entry.counts === undefined ? {} : { counts: entry.counts }),
    })),
    known_limitations: result.known_limitations,
    blocked_reason: result.blocked_reason,
    blocker_classification: result.blocker_classification,
    implementation_complete: result.implementation_complete,
    git: result.git,
    environment: result.environment,
    exit_code: result.exit_code,
  };
}
