export const DOMAIN_ERROR_CODES = [
  'DIRTY_WORKTREE',
  'HEAD_MISMATCH',
  'BRANCH_MISMATCH',
  'REPOSITORY_MISMATCH',
  'DETACHED_HEAD',
  'REVISION_MISMATCH',
  'ILLEGAL_TRANSITION',
  'TASK_NOT_FOUND',
  'WRONG_TASK_TYPE',
  'ROLE_FORBIDDEN',
  'NOT_ASSIGNED',
  'TASK_ALREADY_RUNNING',
  'NO_PENDING_TASK',
  'EXECUTION_OWNER_MISMATCH',
  'REPOSITORY_BINDING_MISMATCH',
  'INVALID_RECOVERY_STATE',
  'LEGACY_RUNNING_TASK_PREVENTS_MIGRATION',
  'EXECUTION_STATE_INVARIANT_VIOLATION',
  'SCHEMA_FENCING_MISSING',
  'SCHEMA_MISMATCH',
  'PAYLOAD_TYPE_MISMATCH',
  'INVALID_PAYLOAD',
  'GIT_NOT_A_REPO',
  'GIT_COMMAND_FAILED',
  'USAGE',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
