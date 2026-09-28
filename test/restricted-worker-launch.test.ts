import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  bytes: Buffer.alloc(0), offset: 0, reads: [] as Buffer[],
  verifyError: false, spawnError: false, child: undefined as any,
}));
vi.mock('node:fs', () => ({
  closeSync: vi.fn(),
  readSync: vi.fn((_fd: number, target: Buffer, offset: number, length: number) => {
    state.reads.push(target);
    const count = Math.min(length, state.bytes.length - state.offset);
    state.bytes.copy(target, offset, state.offset, state.offset + count);
    state.offset += count; return count;
  }),
  readFileSync: vi.fn(() => Buffer.from('fixed fixture executable')),
  realpathSync: Object.assign(vi.fn((path: string) => path), { native: (path: string) => path }),
}));
vi.mock('../src/orchestration/trusted-runtime.ts', () => ({
  verifyTrustedRuntime: vi.fn(() => {
    if (state.verifyError) throw new Error('TRUSTED_RUNTIME_REFUSED');
    return { root: 'C:\\protected', workerLauncherPath: 'C:\\protected\\dist\\native\\execution-worker.exe',
      coreSid: 'S-1-5-21-1-2-3-1001', keeperSid: 'S-1-5-21-1-2-3-1002',
      workerSid: 'S-1-5-21-1-2-3-1003', operatorSid: 'S-1-5-21-1-2-3-1004' };
  }),
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => {
  if (state.spawnError) throw new Error('SPAWN_REFUSED');
  return state.child;
}) }));
import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { disposeRestrictedWorkerIdentity, initializeRestrictedWorkerIdentityFromStdin,
  spawnRestrictedWorker } from '../src/orchestration/restricted-worker-launch.ts';

const launch = () => spawnRestrictedWorker('C:\\fixture\\fake.exe', ['literal'], {
  cwd: 'C:\\fixture', shell: false, windowsHide: true,
});
function field(value: Buffer): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32LE(value.length);
  return Buffer.concat([header, value]);
}
function prepare(): void {
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n);
  state.bytes = Buffer.concat([handle, field(Buffer.from('disposableWorker')), field(Buffer.from('test-only-secret\0', 'utf16le'))]);
  state.offset = 0; state.reads = [];
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  state.child = child;
}
afterEach(() => {
  disposeRestrictedWorkerIdentity(); state.bytes.fill(0); state.verifyError = false;
  state.spawnError = false; vi.clearAllMocks();
});

describe('restricted Worker credential and process boundary', () => {
  it('refuses an unprovisioned launch without executing a process', () => {
    expect(launch).toThrow('WORKER_IDENTITY_REFUSED:not provisioned');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([1, 10, 35])('clears every allocated partial input and closes the channel at byte %i', (length) => {
    prepare(); state.bytes = state.bytes.subarray(0, length);
    expect(initializeRestrictedWorkerIdentityFromStdin).toThrow();
    expect(state.reads.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(closeSync).toHaveBeenCalledWith(0);
    expect(launch).toThrow('not provisioned');
  });
  it('consumes the identity on protected-runtime rejection and never falls back', () => {
    prepare(); initializeRestrictedWorkerIdentityFromStdin(); state.verifyError = true;
    expect(launch).toThrow('TRUSTED_RUNTIME_REFUSED');
    expect(launch).toThrow('not provisioned'); expect(spawn).not.toHaveBeenCalled();
  });
  it('consumes the identity on helper spawn failure and never retries', () => {
    prepare(); initializeRestrictedWorkerIdentityFromStdin(); state.spawnError = true;
    expect(launch).toThrow('SPAWN_REFUSED'); expect(launch).toThrow('not provisioned');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('uses the fixed helper, explicit bounded environment and pipe prefix without exposing credentials in argv', async () => {
    prepare(); const received: Buffer[] = [];
    state.child.stdin.on('data', (data: Buffer) => received.push(Buffer.from(data)));
    initializeRestrictedWorkerIdentityFromStdin(); const child = launch();
    child.stdin.end('task-protocol'); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawn).toHaveBeenCalledWith('C:\\protected\\dist\\native\\execution-worker.exe', ['--launch'], {
      cwd: 'C:\\protected', shell: false, windowsHide: true,
      env: {
        HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', PATH: '', SYSTEMDRIVE: '',
        SystemRoot: 'C:\\Windows', TEMP: '', TMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', WINDIR: '',
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(JSON.stringify(vi.mocked(spawn).mock.calls).includes('test-only-secret')).toBe(false);
    const wire = Buffer.concat(received); let offset = 0;
    for (let i = 0; i < 2; i++) offset += 4 + wire.readUInt32LE(offset);
    const size = wire.readUInt32LE(offset); offset += 4;
    const config = JSON.parse(wire.subarray(offset, offset + size).toString());
    expect(config).toMatchObject({ schema: 'engineering-restricted-worker-launch/1',
      workerSid: 'S-1-5-21-1-2-3-1003', runnerPid: process.pid, jobHandle: '123' });
    expect(wire.subarray(offset + size).toString()).toBe('task-protocol');
    expect(state.reads.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(launch).toThrow('not provisioned');
    wire.fill(0); received.forEach((buffer) => buffer.fill(0));
  });
});
