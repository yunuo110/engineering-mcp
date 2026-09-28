import { describe, expect, it } from 'vitest';
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
});
