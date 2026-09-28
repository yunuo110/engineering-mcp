import { DomainError } from '../errors.ts';
import type { ProcessRole } from '../types.ts';

export const WORK_PROTOCOL_VERSION = 'engineering-work/1';
export const WORK_PRIVATE_TOOLS = ['create_task_once', 'get_work_submission', 'cancel_work_task', 'resolve_work_decision'] as const;

export function assertWorkPrivateMode(
  role: ProcessRole,
  enabled: boolean | undefined,
  version: string | undefined,
  c2cEnabled: boolean | undefined,
  c2cPrivate: boolean | undefined,
): void {
  if (enabled === true) {
    if (role !== 'owner' || version !== WORK_PROTOCOL_VERSION || c2cEnabled === true || c2cPrivate === true) {
      throw new DomainError('USAGE', 'Private Work client requires OWNER, exact contract version, and no C2C mode');
    }
  } else if (version !== undefined) {
    throw new DomainError('USAGE', 'Work contract version requires private Work client mode');
  }
}
