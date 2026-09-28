import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../errors.ts';
import { verifyTrustedRuntime, isProtectedExecutionMode } from './trusted-runtime.ts';
import { witnessSecurity } from './witness-security.ts';
import { boundedControlEnvironment } from './runtime-environment.ts';

const VERSION = 1;
const HELPER_BUILD = 'engineering-execution-keeper/1';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WITNESS_ID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const helperRelative = import.meta.url.endsWith('.ts')
  ? '../../dist/native/execution-keeper.exe' : '../native/execution-keeper.exe';
export const EXECUTION_KEEPER_EXE = fileURLToPath(new URL(helperRelative, import.meta.url));

export type ExecutionGroupObservation =
  | { state: 'ALIVE'; active_processes: number; process_ids: number[] }
  | { state: 'DRAINED'; active_processes: 0; process_ids: [] }
  | { state: 'UNKNOWN' };

export type ExecutionWitness = {
  version: 1;
  state: 'RESUMED';
  execution_witness_id: string;
  dispatch_run_id: string;
  runner_instance_id: string;
  execution_instance_id: string;
  ledger_repo_binding_sha256: string;
  runner_pid: number;
  runner_creation_filetime: string;
  pipe_name: string;
  sealed_sha256: string;
  breakaway_allowed: false;
  kill_on_job_close: false;
  helper_build: string;
};

export function executionWitnessDirectory(storePath: string, dispatchRunId: string): string {
  if (!ID.test(dispatchRunId)) throw new Error('invalid internal dispatch identity');
  return join(dirname(storePath), 'execution-witnesses', dispatchRunId);
}

export function executionWitnessPath(storePath: string, dispatchRunId: string): string {
  return join(executionWitnessDirectory(storePath, dispatchRunId), 'control', 'bootstrap.json');
}

export function executionEvidencePath(
  storePath: string, dispatchRunId: string,
  name: 'runtime.sealed.json' | 'runtime.resumed.json' | 'drain-receipt.json',
): string {
  return join(executionWitnessDirectory(storePath, dispatchRunId), 'keeper', name);
}

export function executionValidationPath(storePath: string, dispatchRunId: string): string {
  return join(executionWitnessDirectory(storePath, dispatchRunId), 'control', 'validation.json');
}

export function reserveExecutionWitness(storePath: string, dispatchRunId: string, instanceId: string,
  repoRoot?: string): boolean {
  if (!ID.test(instanceId)) throw new Error('invalid internal execution identity');
  if (isProtectedExecutionMode() && !repoRoot) throw new Error('protected witness requires repository binding');
  const directory = executionWitnessDirectory(storePath, dispatchRunId);
  const path = executionWitnessPath(storePath, dispatchRunId);
  if (repoRoot) witnessSecurity('root', storePath, repoRoot, dispatchRunId);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  // An old one-file reservation must not coexist with a new execution root.
  if (existsSync(join(dirname(directory), `${dispatchRunId}.json`))) return false;
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  mkdirSync(dirname(path), { mode: 0o700 });
  mkdirSync(join(directory, 'keeper'), { mode: 0o700 });
  let descriptor: number;
  descriptor = openSync(path, 'wx', 0o600);
  try {
    writeSync(descriptor, JSON.stringify({ version: VERSION, state: 'BOOTSTRAPPING',
      dispatch_run_id: dispatchRunId, runner_instance_id: instanceId }), undefined, 'utf8');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  if (repoRoot) witnessSecurity('seal', storePath, repoRoot, dispatchRunId);
  return true;
}

export function releaseUnlaunchedExecutionWitness(
  storePath: string, dispatchRunId: string, instanceId: string,
): void {
  const path = executionWitnessPath(storePath, dispatchRunId);
  const bootstrap = readObject(path);
  if (!bootstrap || bootstrap.version !== VERSION || bootstrap.state !== 'BOOTSTRAPPING'
    || bootstrap.dispatch_run_id !== dispatchRunId || bootstrap.runner_instance_id !== instanceId) {
    throw new Error('bootstrap changed; refusing reservation release');
  }
  // rmdir only succeeds if no Keeper evidence or unexpected child exists.
  rmdirSync(join(executionWitnessDirectory(storePath, dispatchRunId), 'keeper'));
  unlinkSync(path);
  rmdirSync(dirname(path));
  rmdirSync(executionWitnessDirectory(storePath, dispatchRunId));
}

function bindingHash(storePath: string, repoRoot: string): string {
  return createHash('sha256').update(`${storePath}\0${repoRoot}`, 'utf8').digest('hex');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function readObject(path: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return undefined; }
}

function commonRuntimeFields(value: Record<string, unknown>, dispatchRunId: string,
  instanceId: string, expectedBinding: string): boolean {
  return value.version === VERSION
    && WITNESS_ID.test(String(value.execution_witness_id))
    && value.dispatch_run_id === dispatchRunId
    && value.runner_instance_id === instanceId
    && value.execution_instance_id === instanceId
    && value.ledger_repo_binding_sha256 === expectedBinding
    && Number.isSafeInteger(value.runner_pid) && (value.runner_pid as number) > 0
    && typeof value.runner_creation_filetime === 'string'
    && /^\d{15,20}$/.test(value.runner_creation_filetime)
    && value.pipe_name === `EngineeringMCP.Execution.${value.execution_witness_id}`
    && value.breakaway_allowed === false && value.kill_on_job_close === false
    && value.helper_build === HELPER_BUILD;
}

export function readExecutionWitness(
  storePath: string, repoRoot: string, dispatchRunId: string,
  expectedInstanceId?: string,
): ExecutionWitness | undefined {
  try { witnessSecurity('read', storePath, repoRoot, dispatchRunId); }
  catch { return undefined; }
  const bootstrap = readObject(executionWitnessPath(storePath, dispatchRunId));
  if (!bootstrap || bootstrap.version !== VERSION || bootstrap.state !== 'BOOTSTRAPPING'
    || bootstrap.dispatch_run_id !== dispatchRunId
    || !ID.test(String(bootstrap.runner_instance_id))
    || (expectedInstanceId && bootstrap.runner_instance_id !== expectedInstanceId)) return undefined;
  const instanceId = bootstrap.runner_instance_id as string;
  const sealedPath = executionEvidencePath(storePath, dispatchRunId, 'runtime.sealed.json');
  let sealedBytes: Buffer;
  try { sealedBytes = readFileSync(sealedPath); } catch { return undefined; }
  let sealed: Record<string, unknown> | undefined;
  try { sealed = object(JSON.parse(sealedBytes.toString('utf8'))); } catch { return undefined; }
  const value = readObject(executionEvidencePath(storePath, dispatchRunId, 'runtime.resumed.json'));
  const expectedBinding = bindingHash(storePath, repoRoot);
  if (!sealed || !value || sealed.state !== 'SEALED' || value.state !== 'RESUMED'
    || !commonRuntimeFields(sealed, dispatchRunId, instanceId, expectedBinding)
    || !commonRuntimeFields(value, dispatchRunId, instanceId, expectedBinding)
    || !SHA.test(String(value.sealed_sha256))
    || value.sealed_sha256 !== createHash('sha256').update(sealedBytes).digest('hex')) return undefined;
  for (const key of ['execution_witness_id', 'runner_pid', 'runner_creation_filetime', 'pipe_name']) {
    if (sealed[key] !== value[key]) return undefined;
  }
  return value as ExecutionWitness;
}

export function waitForExecutionWitness(
  storePath: string, repoRoot: string, dispatchRunId: string, instanceId: string,
  timeoutMs = 5000,
): ExecutionWitness | undefined {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const witness = readExecutionWitness(storePath, repoRoot, dispatchRunId, instanceId);
    if (witness) return witness;
    Atomics.wait(pause, 0, 0, 25);
  }
  return undefined;
}

function validDrainReceiptBytes(witness: ExecutionWitness, bytes: Buffer): boolean {
  let value: Record<string, unknown> | undefined;
  try { value = object(JSON.parse(bytes.toString('utf8'))); }
  catch { return false; }
  return !!value && value.version === VERSION
    && value.execution_witness_id === witness.execution_witness_id
    && value.dispatch_run_id === witness.dispatch_run_id
    && value.runner_instance_id === witness.runner_instance_id
    && value.execution_instance_id === witness.execution_instance_id
    && value.ledger_repo_binding_sha256 === witness.ledger_repo_binding_sha256
    && value.sealed_sha256 === witness.sealed_sha256
    && value.runner_pid === witness.runner_pid
    && value.runner_creation_filetime === witness.runner_creation_filetime
    && value.observed_active_processes === 0
    && typeof value.observed_at === 'string' && !Number.isNaN(Date.parse(value.observed_at))
    && value.helper_build === HELPER_BUILD;
}

function readDrainReceipt(witness: ExecutionWitness, storePath: string): boolean {
  try {
    return validDrainReceiptBytes(witness,
      readFileSync(executionEvidencePath(storePath, witness.dispatch_run_id, 'drain-receipt.json')));
  } catch { return false; }
}

function queryKeeper(witness: ExecutionWitness): unknown {
  try {
    const keeperPath = import.meta.url.endsWith('.ts')
      ? EXECUTION_KEEPER_EXE : verifyTrustedRuntime().keeperPath;
    const raw = execFileSync(keeperPath, ['status', witness.execution_witness_id],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 8192, windowsHide: true,
        env: boundedControlEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch { return undefined; }
}

export function observeExecutionGroup(
  storePath: string, repoRoot: string, dispatchRunId: string, expectedInstanceId?: string,
): ExecutionGroupObservation {
  if (process.platform !== 'win32') return { state: 'UNKNOWN' };
  const witness = readExecutionWitness(storePath, repoRoot, dispatchRunId, expectedInstanceId);
  if (!witness) return { state: 'UNKNOWN' };
  const response = object(queryKeeper(witness));
  if (response && response.version === VERSION
    && response.execution_witness_id === witness.execution_witness_id
    && response.dispatch_run_id === witness.dispatch_run_id
    && response.runner_instance_id === witness.runner_instance_id) {
    if (response.state === 'ALIVE' && Number.isSafeInteger(response.active_processes)
      && (response.active_processes as number) > 0 && Array.isArray(response.process_ids)
      && response.process_ids.length === response.active_processes
      && response.process_ids.every((pid: unknown) => Number.isSafeInteger(pid) && (pid as number) > 0)) {
      return { state: 'ALIVE', active_processes: response.active_processes as number,
        process_ids: response.process_ids as number[] };
    }
    if (response.state === 'DRAINED' && response.active_processes === 0
      && Array.isArray(response.process_ids) && response.process_ids.length === 0
      && readDrainReceipt(witness, storePath)) {
      return { state: 'DRAINED', active_processes: 0, process_ids: [] };
    }
  }
  return readDrainReceipt(witness, storePath)
    ? { state: 'DRAINED', active_processes: 0, process_ids: [] }
    : { state: 'UNKNOWN' };
}

export function assertExecutionWritersDrained(
  storePath: string, repoRoot: string, dispatchRunId: string, instanceId: string,
): void {
  const observation = observeExecutionGroup(storePath, repoRoot, dispatchRunId, instanceId);
  if (observation.state !== 'DRAINED') {
    throw new DomainError('INVALID_RECOVERY_STATE', `Execution writers are ${observation.state}; recovery denied`,
      { dispatch_run_id: dispatchRunId, execution_group_state: observation.state });
  }
}

export function recordExecutionValidation(
  storePath: string, repoRoot: string, dispatchRunId: string, instanceId: string,
): void {
  assertExecutionWritersDrained(storePath, repoRoot, dispatchRunId, instanceId);
  const witness = readExecutionWitness(storePath, repoRoot, dispatchRunId, instanceId);
  if (!witness) {
    throw new Error('execution evidence changed during validation');
  }
  const receiptBytes = readFileSync(executionEvidencePath(storePath, dispatchRunId, 'drain-receipt.json'));
  if (!validDrainReceiptBytes(witness, receiptBytes)) {
    throw new Error('execution evidence changed during validation');
  }
  const record = {
    version: VERSION, state: 'DRAINED', dispatch_run_id: dispatchRunId,
    runner_instance_id: instanceId, execution_witness_id: witness.execution_witness_id,
    ledger_repo_binding_sha256: witness.ledger_repo_binding_sha256,
    sealed_sha256: witness.sealed_sha256,
    drain_receipt_sha256: createHash('sha256').update(receiptBytes).digest('hex'),
  };
  const path = executionValidationPath(storePath, dispatchRunId);
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST'
      && JSON.stringify(readObject(path)) === JSON.stringify(record)) return;
    throw error;
  }
  try {
    writeSync(descriptor, JSON.stringify(record), undefined, 'utf8');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}
