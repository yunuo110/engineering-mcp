import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const executable = resolve('dist/native/execution-credential.exe');
const nativeSource = resolve('src/native/execution-credential.cs');
const suite = process.platform === 'win32' ? describe : describe.skip;

function call(args: string[], input: Buffer = Buffer.alloc(0)) {
  return spawnSync(executable, args, { input, windowsHide: true, timeout: 10_000,
    maxBuffer: 20_000, encoding: null });
}
function field(value: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(value.length);
  return Buffer.concat([header, value]);
}
function frame(password = Buffer.from('a\0', 'utf16le')) {
  return Buffer.concat([
    field(Buffer.from('KeeperCredentialTest', 'utf8')), field(password),
    field(Buffer.from('WorkerCredentialTest', 'utf8')), field(Buffer.from('b\0', 'utf16le')),
  ]);
}
function envelope(magic = 'EMCPCRED', version = 1, blob = Buffer.from([1, 2, 3]),
  declaredLength = blob.length) {
  const header = Buffer.alloc(16);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(version, 8);
  header.writeUInt32LE(declaredLength, 12);
  return Buffer.concat([header, blob]);
}
function refuses(args: string[], input: Buffer, kind: string) {
  const result = call(args, input);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout?.length).toBe(0);
  expect(result.stderr?.toString('utf8').trim()).toBe(`CREDENTIAL_FAILED:${kind}`);
}

suite('execution-credential native primitive', () => {
  it('has one exact build identity and a closed command surface', () => {
    const version = call(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout?.toString('utf8')).toBe('engineering-execution-credential/1\r\n');
    expect(version.stderr?.length).toBe(0);
    for (const args of [[], ['unknown'], ['seal', 'extra'], ['unseal', 'blob'],
      ['--version', 'extra']]) refuses(args, Buffer.alloc(0), 'ARGUMENTS');
  });

  it('rejects truncated, oversized, empty, malformed and trailing plaintext fields', () => {
    refuses(['seal'], frame().subarray(0, 7), 'FRAME');
    const oversized = frame();
    oversized.writeUInt32LE(257, 0);
    refuses(['seal'], oversized, 'FRAME');
    const empty = frame();
    empty.writeUInt32LE(0, 0);
    refuses(['seal'], empty, 'FRAME');
    refuses(['seal'], frame(Buffer.from([0x00, 0xd8, 0x00, 0x00])), 'FRAME');
    refuses(['seal'], Buffer.concat([frame(), Buffer.from([0])]), 'FRAME');
  });

  it('rejects invalid, future, oversized and truncated envelope formats before DPAPI', () => {
    refuses(['unseal'], envelope('BADMAGIC'), 'ENVELOPE');
    refuses(['unseal'], envelope('EMCPCRED', 2), 'ENVELOPE');
    refuses(['unseal'], envelope('EMCPCRED', 1, Buffer.from([1, 2]), 3), 'ENVELOPE');
    refuses(['unseal'], envelope('EMCPCRED', 1, Buffer.from([1]), 16_369), 'ENVELOPE');
    refuses(['unseal'], Buffer.alloc(16_385), 'ENVELOPE');
  });

  it('uses CurrentUser DPAPI with no machine-scope, entropy, or UI prompt', () => {
    const source = readFileSync(nativeSource, 'utf8');
    expect(source).toContain('CRYPTPROTECT_UI_FORBIDDEN');
    expect(source).toContain('CryptProtectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,');
    expect(source).toContain('CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,');
    expect(source).not.toContain('CRYPTPROTECT_LOCAL_MACHINE');
    expect(source).not.toContain('NCryptProtectSecret');
  });
});
