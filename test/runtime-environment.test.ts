import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
import {
  assertSupportedControlNode,
  boundedControlEnvironment,
  verifyWindowsControlEnvironment,
} from '../src/orchestration/runtime-environment.ts';

describe('bounded Windows control environment', () => {
  it('accepts supported Node versions without pinning a libuv release', () => {
    expect(() => assertSupportedControlNode('24.13.1')).not.toThrow();
    expect(() => assertSupportedControlNode('24.21.0')).not.toThrow();
    expect(() => assertSupportedControlNode('25.0.0')).not.toThrow();
    for (const version of ['23.9.0', '24', 'malformed']) {
      expect(() => assertSupportedControlNode(version)).toThrow('CONTROL_ENVIRONMENT_REFUSED');
    }
  });

  it.skipIf(process.platform !== 'win32')('proves the effective environment of a real Windows Node child', () => {
    const sentinel = 'ENGINEERING_CONTROL_ENV_PROBE_SENTINEL';
    const previous = process.env[sentinel];
    process.env[sentinel] = 'must-not-reach-child';
    try {
      const environment = boundedControlEnvironment();
      expect(environment).toEqual({
        HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', PATH: '', SYSTEMDRIVE: '',
        SystemRoot: 'C:\\Windows', TEMP: '', TMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', WINDIR: '',
      });
    } finally {
      if (previous === undefined) delete process.env[sentinel];
      else process.env[sentinel] = previous;
    }
  });

  it.skipIf(process.platform !== 'win32')('rejects extra, missing, or changed environment fields', () => {
    const environment = boundedControlEnvironment();
    expect(() => verifyWindowsControlEnvironment({ ...environment, EXTRA_CONTROL_VALUE: 'sentinel' }))
      .toThrow('CONTROL_ENVIRONMENT_REFUSED');
    const { PATH: _removed, ...missingPath } = environment;
    expect(() => verifyWindowsControlEnvironment(missingPath)).toThrow('CONTROL_ENVIRONMENT_REFUSED');
    expect(() => verifyWindowsControlEnvironment({ ...environment, PATH: 'untrusted' }))
      .toThrow('CONTROL_ENVIRONMENT_REFUSED');
  });

  it.skipIf(process.platform !== 'win32')('proves once per module/process, returns fresh copies, and explicitly revalidates', async () => {
    vi.resetModules();
    const runtime = await import('../src/orchestration/runtime-environment.ts');
    const probe = vi.mocked(spawnSync);
    probe.mockClear();
    const first = runtime.boundedControlEnvironment();
    const second = runtime.boundedControlEnvironment();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    second.PATH = 'untrusted';
    expect(runtime.boundedControlEnvironment().PATH).toBe('');
    expect(() => runtime.verifyWindowsControlEnvironment(second)).toThrow('CONTROL_ENVIRONMENT_REFUSED');
    expect(probe).toHaveBeenCalledTimes(1);
    runtime.verifyWindowsControlEnvironment(first);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform !== 'win32')('does not cache a failed child proof', async () => {
    vi.resetModules();
    const runtime = await import('../src/orchestration/runtime-environment.ts');
    const probe = vi.mocked(spawnSync);
    probe.mockClear();
    probe.mockImplementationOnce(() => { throw new Error('unit probe failure'); });
    expect(() => runtime.boundedControlEnvironment()).toThrow('CONTROL_ENVIRONMENT_REFUSED');
    expect(() => runtime.boundedControlEnvironment()).not.toThrow();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
