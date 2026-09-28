import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Reproducible freestanding PE from the adjacent C source, built with clang 17
// and lld-link 17, timestamp=0. It imports only Kernel32 + CommandLineToArgvW;
// no runtime/interpreter, network/provider dependency, or compiler is needed
// on the test host. The executable is materialized only in test-owned temp dirs.
export const NATIVE_GENERIC_SHA256 = '0d82130051a8adf5527c1054e7fd25b3131d4b8e453abe5bec35bf35f3d5d3c7';
const SOURCE_SHA256 = 'b301f578bb06dcc46b77622ce35269f66a1b8161fc91821eb50c6bdee234ba5b';
const image = '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';

export function materializeNativeGenericHarness(dir: string): string {
  const source = readFileSync(new URL('./generic-native-harness.c', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (createHash('sha256').update(source).digest('hex') !== SOURCE_SHA256) {
    throw new Error('Native fixture source changed: regenerate its pinned image');
  }
  const bytes = gunzipSync(Buffer.from(image, 'base64'));
  if (createHash('sha256').update(bytes).digest('hex') !== NATIVE_GENERIC_SHA256 ||
      bytes.toString('ascii', 0, 2) !== 'MZ' ||
      bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) {
    throw new Error('Native fixture is not the pinned Windows x64 PE');
  }
  const exe = join(dir, 'generic-native.exe');
  writeFileSync(exe, bytes, { flag: 'wx' });
  return exe;
}
