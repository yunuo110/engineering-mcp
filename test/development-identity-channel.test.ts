import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { oneTimeIdentityFrame, validateIdentityFrame } from '../src/orchestration/development-identity-channel.ts';

const moduleUrl = new URL('../src/orchestration/development-identity-channel.ts', import.meta.url).href;
function syntheticFrame(): Buffer {
  return Buffer.concat([Buffer.from('keeper-fixture'), Buffer.from('not-a-real-secret\0', 'utf16le'),
    Buffer.from('worker-fixture'), Buffer.from('also-synthetic\0', 'utf16le')].flatMap((value) => {
      const header = Buffer.alloc(4); header.writeUInt32LE(value.length); return [header, value];
    }));
}
async function channel(bytes: Buffer): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {consumeDevelopmentIdentityChannel} from ${JSON.stringify(moduleUrl)};
     try {const frame=consumeDevelopmentIdentityChannel(3); console.log('FRAME_LENGTH='+frame.length);frame.fill(0);}
     catch { console.error('FRAME_REFUSED');process.exitCode=1;}`],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout!.on('data', (b) => { stdout += String(b); });
  child.stderr!.on('data', (b) => { stderr += String(b); });
  const pipe = child.stdio[3] as import('node:stream').Writable;
  pipe.on('error', () => {}); pipe.end(bytes);
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
describe('dedicated development identity pipe', () => {
  it('preserves the existing valid frame bytes and refuses invalid encoding and trailing bytes', () => {
    const valid = syntheticFrame();
    const before = Buffer.from(valid);
    expect(() => validateIdentityFrame(valid)).not.toThrow();
    expect(valid.equals(before)).toBe(true);
    const truncated = valid.subarray(0, valid.length - 1);
    const trailing = Buffer.concat([valid, Buffer.from([0])]);
    const empty = Buffer.from(valid); empty.writeUInt32LE(0, 0);
    const oversized = Buffer.from(valid); oversized.writeUInt32LE(257, 0);
    for (const frame of [truncated, trailing, empty, oversized])
      expect(() => validateIdentityFrame(frame)).toThrow('IDENTITY_FRAME_REFUSED');
    valid.fill(0); before.fill(0); empty.fill(0); oversized.fill(0);
  });
  it('accepts the four-field bounded pipe, not MCP stdin', async () => {
    const bytes = syntheticFrame(); const result = await channel(bytes);
    expect(result.code).toBe(0); expect(result.stdout.trim()).toBe(`FRAME_LENGTH=${bytes.length}`);
    expect(result.stderr).not.toContain('not-a-real-secret');
  });
  it('rejects partial and trailing frames', async () => {
    const frame = syntheticFrame();
    for (const bytes of [frame.subarray(0, frame.length - 1), Buffer.concat([frame, Buffer.from([1])])]) {
      const result = await channel(bytes); expect(result.code).toBe(1); expect(result.stdout).toBe('');
    }
  });
  it('rejects a regular file supplied as descriptor 3 without reading it as credentials', () => {
    const fd = openSync(new URL(import.meta.url), 'r');
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {consumeDevelopmentIdentityChannel} from ${JSON.stringify(moduleUrl)};
         try { consumeDevelopmentIdentityChannel(3); process.exitCode=2; }
         catch(e) { if(e.message!=='DEVELOPMENT_IDENTITY_REFUSED:pipe required')process.exitCode=3; }`],
        { stdio: ['ignore', 'pipe', 'pipe', fd], windowsHide: true, timeout: 5000 });
      expect(result.status).toBe(0);
      expect(String(result.stdout)).toBe('');
    } finally { closeSync(fd); }
  });
  it('consumes once and zeroes the retained frame on unused-session disposal', () => {
    const first = Buffer.from([1,2,3]); const source = oneTimeIdentityFrame(first);
    expect(source.take()).toBe(first); expect(source.take()).toBeUndefined(); first.fill(0);
    const unused = Buffer.from([4,5,6]); oneTimeIdentityFrame(unused).dispose();
    expect([...unused]).toEqual([0,0,0]);
  });
});
