import { createHash } from 'node:crypto';
import {
  C2C_PROTOCOL_VERSION,
  MAX_C2C_MESSAGE_BYTES,
  authoritativeSnapshotSchema,
  c2cMessageSchema,
  trustedActorContextSchema,
  type AuthoritativeSnapshot,
  type C2CMessage,
  type C2CReceipt,
  type C2CRejectCode,
  type TrustedActorContext,
} from './schema.ts';

export type GuardFailure = {
  code: C2CRejectCode;
  message: string;
};

export type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: GuardFailure };

export type DuplicateCheck =
  | { kind: 'none' }
  | { kind: 'noop'; receipt: C2CReceipt }
  | { kind: 'reject'; failure: GuardFailure };

function failure(code: C2CRejectCode, message: string): GuardResult<never> {
  return { ok: false, failure: { code, message } };
}

export function serializeForBoundedValidation(message: unknown): GuardResult<string> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(message);
  } catch {
    return failure('MESSAGE_NOT_SERIALIZABLE', 'C2C message must be JSON serializable');
  }

  if (serialized === undefined) {
    return failure('MESSAGE_NOT_SERIALIZABLE', 'C2C message must serialize to a JSON value');
  }

  if (Buffer.byteLength(serialized, 'utf8') > MAX_C2C_MESSAGE_BYTES) {
    return failure(
      'MESSAGE_TOO_LARGE',
      `C2C message exceeds ${MAX_C2C_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }

  return { ok: true, value: serialized };
}

function rawProtocolVersion(message: unknown): unknown {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return undefined;
  }
  return (message as Record<string, unknown>).protocol_version;
}

export function parseMessage(message: unknown): GuardResult<C2CMessage> {
  const version = rawProtocolVersion(message);
  if (version !== undefined && version !== C2C_PROTOCOL_VERSION) {
    return failure(
      'INVALID_PROTOCOL_VERSION',
      `Unsupported C2C protocol version: ${String(version)}`,
    );
  }

  const parsed = c2cMessageSchema.safeParse(message);
  if (!parsed.success) {
    return failure(
      'INVALID_MESSAGE',
      `Invalid C2C message: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  return { ok: true, value: parsed.data };
}

export function parseTrustedActorContext(
  context: unknown,
): GuardResult<TrustedActorContext> {
  const parsed = trustedActorContextSchema.safeParse(context);
  if (!parsed.success) {
    return failure(
      'INVALID_TRUSTED_CONTEXT',
      `Invalid trusted actor context: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return { ok: true, value: parsed.data };
}

export function parseAuthoritativeSnapshot(
  snapshot: unknown,
): GuardResult<AuthoritativeSnapshot> {
  const parsed = authoritativeSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return failure(
      'INVALID_AUTHORITATIVE_SNAPSHOT',
      `Invalid authoritative snapshot: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return { ok: true, value: parsed.data };
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }

  throw new TypeError('Canonical JSON supports JSON values only');
}

export function canonicalMessageDigest(message: C2CMessage): string {
  return createHash('sha256').update(canonicalJson(message), 'utf8').digest('hex');
}

export function requireTaskBinding(
  message: C2CMessage,
  snapshot: AuthoritativeSnapshot,
): GuardFailure | null {
  if (message.task_id !== snapshot.task.id) {
    return {
      code: 'TASK_MISMATCH',
      message: `Message task ${message.task_id} does not match authoritative task ${snapshot.task.id}`,
    };
  }
  return null;
}
export function requireRepositoryBinding(
  context: TrustedActorContext,
  snapshot: AuthoritativeSnapshot,
): GuardFailure | null {
  if (context.repo_root !== snapshot.task.repo_root) {
    return {
      code: 'REPOSITORY_MISMATCH',
      message: 'Trusted repository does not match the authoritative task repository',
    };
  }
  return null;
}

export function requireSenderConsistency(
  message: C2CMessage,
  context: TrustedActorContext,
): GuardFailure | null {
  if (message.sender_role !== context.actor_role) {
    return {
      code: 'SENDER_ROLE_MISMATCH',
      message:
        'sender_role is an untrusted claim and must match the trusted process actor role',
    };
  }
  return null;
}

export function checkDuplicateIdentity(
  message: C2CMessage,
  digest: string,
  snapshot: AuthoritativeSnapshot,
): DuplicateCheck {
  const receipt = snapshot.existing_receipt;
  if (!receipt || receipt.message_id !== message.message_id) {
    return { kind: 'none' };
  }

  if (receipt.task_id !== message.task_id) {
    return {
      kind: 'reject',
      failure: {
        code: 'RECEIPT_TASK_MISMATCH',
        message: 'Existing receipt with this message_id belongs to another task',
      },
    };
  }

  if (receipt.message_digest !== digest) {
    return {
      kind: 'reject',
      failure: {
        code: 'MESSAGE_ID_CONFLICT',
        message: 'message_id was already used for different message content',
      },
    };
  }

  return { kind: 'noop', receipt };
}

export function requireCurrentRevision(
  message: C2CMessage,
  snapshot: AuthoritativeSnapshot,
): GuardFailure | null {
  if (message.expected_revision !== snapshot.task.revision) {
    return {
      code: 'REVISION_MISMATCH',
      message:
        `Expected task revision ${message.expected_revision}, authoritative revision is ${snapshot.task.revision}`,
    };
  }
  return null;
}

export function requireExecutedReviewPrerequisites(
  context: TrustedActorContext,
  snapshot: AuthoritativeSnapshot,
): GuardFailure | null {
  const task = snapshot.task;

  // EXECUTED is only a notification after the existing lifecycle has already
  // accepted a result. It is never a substitute for report_result.
  if (
    task.type !== 'IMPLEMENTATION' ||
    task.status !== 'COMPLETED' ||
    task.result === null
  ) {
    return {
      code: 'EXECUTED_RESULT_NOT_ACCEPTED',
      message:
        'EXECUTED requires an authoritative COMPLETED implementation task with an accepted result',
    };
  }

  // Terminal tasks intentionally clear TaskContract.execution_instance_id.
  // Provenance, when supplied/available, comes from the authoritative dispatch
  // and runner identity instead.
  const dispatch = snapshot.dispatch;
  const provenanceRequested =
    context.dispatch_run_id !== undefined ||
    context.runner_instance_id !== undefined;

  if (!dispatch) {
    if (provenanceRequested) {
      return {
        code: 'EXECUTION_PROVENANCE_MISSING',
        message:
          'Trusted context requested dispatch/runner provenance but the authoritative snapshot has no dispatch',
      };
    }
    return null;
  }

  if (
    dispatch.task_id !== task.id ||
    dispatch.status !== 'completed'
  ) {
    return {
      code: 'EXECUTION_PROVENANCE_MISMATCH',
      message:
        'Authoritative dispatch is not a completed dispatch for the authoritative task',
    };
  }

  if (dispatch.runner_instance_id === null) {
    return {
      code: 'EXECUTION_PROVENANCE_MISSING',
      message: 'Completed authoritative dispatch has no runner_instance_id',
    };
  }

  if (
    context.dispatch_run_id !== undefined &&
    context.dispatch_run_id !== dispatch.id
  ) {
    return {
      code: 'EXECUTION_PROVENANCE_MISMATCH',
      message: 'Trusted dispatch_run_id does not match authoritative dispatch',
    };
  }

  if (
    context.runner_instance_id !== undefined &&
    context.runner_instance_id !== dispatch.runner_instance_id
  ) {
    return {
      code: 'EXECUTION_PROVENANCE_MISMATCH',
      message: 'Trusted runner_instance_id does not match authoritative dispatch',
    };
  }

  return null;
}
