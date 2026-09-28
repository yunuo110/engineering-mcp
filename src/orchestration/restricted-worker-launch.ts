import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { verifyTrustedRuntime } from './trusted-runtime.ts';
import { boundedControlEnvironment } from './runtime-environment.ts';

// This source exists only inside the Core-token trusted Runner. It is never
// populated from task text, environment variables, argv credentials, or files.
let identity: { credential: Buffer; jobHandle: string } | undefined;

function readExact(length: number): Buffer {
  const value = Buffer.alloc(length);
  try {
    let offset = 0;
    while (offset < length) {
      const count = readSync(0, value, offset, length - offset, null);
      if (count === 0) throw new Error('WORKER_IDENTITY_REFUSED:incomplete channel');
      offset += count;
    }
    return value;
  } catch (error) { value.fill(0); throw error; }
}

function readField(maximum: number): Buffer {
  const header = readExact(4);
  try {
    const length = header.readUInt32LE(0);
    if (length < 1 || length > maximum) throw new Error('WORKER_IDENTITY_REFUSED:field length');
    const value = readExact(length);
    try { return Buffer.concat([header, value]); } finally { value.fill(0); }
  } finally { header.fill(0); }
}

export function initializeRestrictedWorkerIdentityFromStdin(): void {
  let handle: Buffer | undefined, username: Buffer | undefined, password: Buffer | undefined;
  try {
    if (identity) throw new Error('WORKER_IDENTITY_REFUSED:already provisioned');
    handle = readExact(8);
    const jobHandle = handle.readBigUInt64LE(0);
    if (jobHandle === 0n || jobHandle > 0x7fffffffffffffffn)
      throw new Error('WORKER_IDENTITY_REFUSED:Job handle');
    username = readField(256);
    password = readField(1024);
    const length = password.readUInt32LE(0);
    if (length < 4 || length % 2 !== 0 || password.readUInt16LE(password.length - 2) !== 0)
      throw new Error('WORKER_IDENTITY_REFUSED:password frame');
    identity = { credential: Buffer.concat([username, password]), jobHandle: jobHandle.toString() };
  } catch (error) { disposeRestrictedWorkerIdentity(); throw error; }
  finally {
    handle?.fill(0); username?.fill(0); password?.fill(0);
    try { closeSync(0); } catch { /* channel already closed */ }
  }
}

export function disposeRestrictedWorkerIdentity(): void {
  identity?.credential.fill(0);
  identity = undefined;
}

export function spawnRestrictedWorker(
  executable: string,
  args: string[],
  options: { cwd: string; shell: false; windowsHide: true; windowsVerbatimArguments?: true },
): ChildProcessWithoutNullStreams {
  const source = identity;
  identity = undefined; // The one-time channel cannot authorize a second root.
  if (!source) throw new Error('WORKER_IDENTITY_REFUSED:not provisioned');
  let header: Buffer | undefined, configuration: Buffer | undefined;
  try {
    const binding = verifyTrustedRuntime();
    if (!isAbsolute(executable) || !isAbsolute(options.cwd) || args.some((arg) => arg.includes('\0')))
      throw new Error('WORKER_IDENTITY_REFUSED:fixed absolute paths required');
    const canonical = realpathSync.native(executable);
    if (!/\.exe$/i.test(canonical)) throw new Error('WORKER_IDENTITY_REFUSED:native executable required');
    configuration = Buffer.from(JSON.stringify({
      schema: 'engineering-restricted-worker-launch/1',
      executable: canonical,
      executableSha256: createHash('sha256').update(readFileSync(canonical)).digest('hex'),
      args,
      verbatimArguments: options.windowsVerbatimArguments === true,
      cwd: realpathSync.native(options.cwd),
      coreSid: binding.coreSid, keeperSid: binding.keeperSid,
      workerSid: binding.workerSid, operatorSid: binding.operatorSid,
      runnerPid: process.pid, jobHandle: source.jobHandle,
    }), 'utf8');
    if (configuration.length > 65536) throw new Error('WORKER_IDENTITY_REFUSED:launch frame too large');
    header = Buffer.alloc(4); header.writeUInt32LE(configuration.length);
    const child = spawn(binding.workerLauncherPath, ['--launch'], {
      cwd: binding.root, shell: false, windowsHide: true,
      env: boundedControlEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const clear = () => source.credential.fill(0);
    child.once('error', clear); child.once('close', clear);
    child.stdin.once('error', clear); child.stdin.once('close', clear);
    child.stdin.write(source.credential, clear);
    child.stdin.write(header);
    child.stdin.write(configuration);
    // The adapter writes only its bounded task protocol after this prefix.
    return child;
  } catch (error) { source.credential.fill(0); throw error; }
  // Header/config contain no secret; Node owns queued copies until flushed.
}
