import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProductionIdentityFrame } from '../src/orchestration/production-credential.ts';
import type { TrustedRuntimeBinding } from '../src/orchestration/trusted-runtime.ts';

const suite = process.platform === 'win32' ? describe : describe.skip;
const helper = resolve('dist/native/execution-credential.exe');
const roots: string[] = [];
function frame(label: string): Buffer {
  const fields = [Buffer.from(`keeper-${label}`), Buffer.from(`unit-${label}\0`, 'utf16le'),
    Buffer.from(`worker-${label}`), Buffer.from(`unit-${label}\0`, 'utf16le')];
  return Buffer.concat(fields.flatMap((field) => {
    const length = Buffer.alloc(4); length.writeUInt32LE(field.length); return [length, field];
  }));
}
function seal(plaintext: Buffer): Buffer {
  const result = spawnSync(helper, ['seal'], { input: plaintext, encoding: 'buffer',
    windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 });
  expect(result.status).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(16);
  return result.stdout;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'engineering-credential-r4-')); roots.push(root);
  const credentialBlobPath = join(root, 'bundle.blob');
  return { root, credentialBlobPath, credentialHelperPath: helper } as TrustedRuntimeBinding;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'engineering-credential-r4-')))
      throw new Error('TEST_TEMP_ROOT_GUARD');
    rmSync(root, { recursive: true, force: true });
  }
});

suite('one-execution production credential acquisition', () => {
  it('fails on absent, malformed and oversized ciphertext before a frame is returned', () => {
    const binding = fixture();
    expect(() => acquireProductionIdentityFrame(binding)).toThrow('PRODUCTION_CREDENTIAL_REFUSED');
    writeFileSync(binding.credentialBlobPath, Buffer.alloc(4));
    expect(() => acquireProductionIdentityFrame(binding)).toThrow('PRODUCTION_CREDENTIAL_REFUSED');
    writeFileSync(binding.credentialBlobPath, Buffer.alloc(16 * 1024 + 1));
    expect(() => acquireProductionIdentityFrame(binding)).toThrow('PRODUCTION_CREDENTIAL_REFUSED');
  });
  it('rotates ciphertext independently of runtime bytes and returns exact fresh frames', () => {
    const binding = fixture();
    for (const label of ['A', 'B']) {
      const expected = frame(label);
      const envelope = seal(expected);
      try {
        writeFileSync(binding.credentialBlobPath, envelope);
        const actual = acquireProductionIdentityFrame(binding);
        try { expect(actual.equals(expected)).toBe(true); }
        finally { actual.fill(0); }
      } finally { expected.fill(0); envelope.fill(0); }
    }
  });
  it('refuses a modified DPAPI envelope without returning plaintext', () => {
    const binding = fixture(); const expected = frame('C'); const envelope = seal(expected);
    try {
      envelope[envelope.length - 1] = envelope[envelope.length - 1]! ^ 1;
      writeFileSync(binding.credentialBlobPath, envelope);
      expect(() => acquireProductionIdentityFrame(binding)).toThrow('PRODUCTION_CREDENTIAL_REFUSED');
    } finally { expected.fill(0); envelope.fill(0); }
  });
  it('refuses an absent helper without falling back to a supplied identity', () => {
    const binding = fixture(); const expected = frame('D'); const envelope = seal(expected);
    try {
      writeFileSync(binding.credentialBlobPath, envelope);
      binding.credentialHelperPath = join(binding.root, 'missing-credential-helper.exe');
      expect(() => acquireProductionIdentityFrame(binding)).toThrow('PRODUCTION_CREDENTIAL_REFUSED');
    } finally { expected.fill(0); envelope.fill(0); }
  });
});
