import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { boundedControlEnvironment } from './runtime-environment.ts';
import { validateIdentityFrame } from './development-identity-channel.ts';
import type { TrustedRuntimeBinding } from './trusted-runtime.ts';

const MAX_ENVELOPE = 16 * 1024;

function refused(): never { throw new Error('PRODUCTION_CREDENTIAL_REFUSED'); }

/** Reads only the configured ciphertext object; never creates or repairs it. */
function readEnvelope(path: string): Buffer {
  let descriptor: number | undefined;
  let envelope: Buffer | undefined;
  try {
    const beforePath = lstatSync(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink()
      || realpathSync.native(path).toLowerCase() !== resolve(path).toLowerCase()) refused();
    descriptor = openSync(path, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 17 || before.size > MAX_ENVELOPE
      || before.dev !== beforePath.dev || before.ino !== beforePath.ino) refused();
    envelope = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < envelope.length) {
      const count = readSync(descriptor, envelope, offset, envelope.length - offset, null);
      if (count === 0) refused();
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) refused();
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || afterPath.dev !== before.dev
      || afterPath.ino !== before.ino || afterPath.isSymbolicLink()) refused();
    return envelope;
  } catch {
    envelope?.fill(0);
    return refused();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The caller owns and must zero the returned one-execution plaintext frame. */
export function acquireProductionIdentityFrame(binding: TrustedRuntimeBinding): Buffer {
  const envelope = readEnvelope(binding.credentialBlobPath);
  let frame: Buffer | undefined;
  try {
    const result = spawnSync(binding.credentialHelperPath, ['unseal'], {
      cwd: binding.root, shell: false, windowsHide: true,
      env: boundedControlEnvironment(), input: envelope, encoding: 'buffer',
      maxBuffer: MAX_ENVELOPE, timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      frame = result.stdout;
      if (result.error || result.status !== 0 || result.signal !== null || !Buffer.isBuffer(frame))
        refused();
      validateIdentityFrame(frame);
      return frame;
    } finally { if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0); }
  } catch {
    frame?.fill(0);
    return refused();
  } finally {
    envelope.fill(0);
  }
}
