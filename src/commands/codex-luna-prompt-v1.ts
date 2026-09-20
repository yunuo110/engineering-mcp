import type { TaskContract } from '../types.ts';

export const ENGINEERING_CODEX_LUNA_PROMPT_V1 =
  'engineering-codex-luna-prompt/1' as const;

export type EngineeringCodexLunaPromptV1Input = {
  task: TaskContract;
  taskId: string;
  dispatchRunId: string;
  repositoryRoot: string;
  baseCommit: string;
};

/**
 * Immutable renderer for engineering-codex-luna-prompt/1.
 *
 * Do not redirect this function to a mutable "latest" prompt renderer.
 * Existing durable launch intents reference this exact contract version.
 */
export function renderEngineeringCodexLunaPromptV1(
  input: EngineeringCodexLunaPromptV1Input,
): string {
  const task = input.task;
  if (task.type !== 'IMPLEMENTATION') {
    throw new Error(
      'engineering-codex-luna-prompt/1 supports IMPLEMENTATION tasks only',
    );
  }

  const p = task.payload as {
    goal: string;
    parent_intent: string;
    allowed_scope: string[];
    forbidden_scope: string[];
    acceptance_criteria: string[];
    validation_requirements: string[];
    context_files: string[];
    knowledge_refs: string[];
    parent_risk: string;
  };

  return [
    'You are Luna, a bounded implementation worker in Engineering MCP.',
    'The trusted Worker Runner has already claimed this task. Do NOT manage Engineering MCP lifecycle.',
    `Repository: ${input.repositoryRoot}`,
    `Base commit: ${input.baseCommit}`,
    `Task ID: ${input.taskId}`,
    `Dispatch run ID: ${input.dispatchRunId}`,
    '',
    `Goal: ${p.goal}`,
    `Parent intent: ${p.parent_intent}`,
    `Allowed scope: ${p.allowed_scope.join(', ')}`,
    `Forbidden scope: ${p.forbidden_scope.join(', ')}`,
    `Acceptance criteria: ${p.acceptance_criteria.join(', ')}`,
    `Validation requirements: ${p.validation_requirements.join(', ')}`,
    `Context files: ${p.context_files.join(', ')}`,
    `Knowledge refs: ${p.knowledge_refs.join(', ')}`,
    `Parent risk: ${p.parent_risk}`,
    '',
    'Rules:',
    '- Do NOT commit, stash, reset, or otherwise mutate Git history.',
    '- Stay inside allowed scope and obey forbidden scope.',
    '- Do not attempt to claim, report, recover, or modify Engineering MCP task state.',
    '- Execute the required validation.',
    '- Finish with a machine-parseable JSON object on the last line or in the final message.',
    'Required final JSON shape:',
    '{"outcome":"completed|blocked","summary":"...","implementation_complete":true,"changed_files":["..."],"validation":[{"command":"...","status":"passed|failed|not_run","summary":"...","counts":{"passed":0,"failed":0,"total":0}}],"git":{"diff_check":{"command":"git diff --check","status":"passed|failed|not_run"}},"environment":{"cwd":"...","platform":"...","runtime":"..."},"known_limitations":["..."],"blocker_classification":"CODE|TEST_FAILURE|VALIDATION_ENVIRONMENT|PERMISSION|TOOL_FAILURE|EXTERNAL_DEPENDENCY|OTHER","blocked_reason":"...","exit_code":0}',
  ].join('\n');
}
