import type { ProcessRole, Role, TaskType } from './types.ts';

export const OWNER_TOOLS = [
  'create_task',
  'get_task',
  'list_active_tasks',
  'delegate_task',
  'await_delegation',
  'recover_task',
  'resume_task',
  'cancel_task',
  'close_task',
] as const;

export const WORKER_TOOLS = [
  'claim_task',
  'claim_next_task',
  'get_task',
  'report_result',
  'report_blocked',
] as const;

export type ToolName =
  | (typeof OWNER_TOOLS)[number]
  | (typeof WORKER_TOOLS)[number];

export function toolsForProcessRole(processRole: ProcessRole): readonly ToolName[] {
  if (processRole === 'owner') {
    return OWNER_TOOLS;
  }
  return WORKER_TOOLS;
}

export function canClaimTaskType(role: Role, type: TaskType): boolean {
  if (role === 'JUNIOR') {
    return type === 'IMPLEMENTATION';
  }
  if (role === 'PRINCIPAL') {
    return type === 'DIAGNOSIS';
  }
  return false;
}

export function isWorkerRole(role: Role): boolean {
  return role === 'JUNIOR' || role === 'PRINCIPAL';
}
