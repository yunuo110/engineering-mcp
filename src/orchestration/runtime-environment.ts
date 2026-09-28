import { spawnSync } from 'node:child_process';

/** libuv on Windows may supply omitted variables. Empty values are intentional. */
const CONTROL_ENVIRONMENT: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', PATH: '', SYSTEMDRIVE: '',
  SystemRoot: 'C:\\Windows', TEMP: '', TMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', WINDIR: '',
});
const PROBE_OK = 'CONTROL_ENVIRONMENT_OK';
const PROBE_SCRIPT = `
const expected = ${JSON.stringify(CONTROL_ENVIRONMENT)};
const actual = process.env;
const keys = Object.keys(actual);
if (keys.length !== Object.keys(expected).length) process.exit(41);
for (const [key, value] of Object.entries(expected)) {
  const matches = keys.filter((actualKey) => actualKey.toUpperCase() === key.toUpperCase());
  if (matches.length !== 1 || actual[matches[0]] !== value) process.exit(42);
}
process.stdout.write('${PROBE_OK}');`;

function refuse(): never {
  throw new Error('CONTROL_ENVIRONMENT_REFUSED:unreviewed Windows environment behavior');
}

export function assertSupportedControlNode(version: string): void {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (!match || Number(match[1]) < 24) refuse();
}

/** Prove the effective child environment, not a particular libuv build number. */
export function verifyWindowsControlEnvironment(environment: NodeJS.ProcessEnv): void {
  const expectedKeys = Object.keys(CONTROL_ENVIRONMENT);
  const keys = Object.keys(environment);
  if (keys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(environment, key) || environment[key] !== CONTROL_ENVIRONMENT[key])) {
    refuse();
  }
  try {
    const probe = spawnSync(process.execPath, ['-e', PROBE_SCRIPT], {
      env: environment, encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 256,
    });
    if (probe.error || probe.signal || probe.status !== 0 || probe.stdout !== PROBE_OK || probe.stderr !== '') {
      refuse();
    }
  } catch {
    refuse();
  }
}

export function boundedControlEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    assertSupportedControlNode(process.versions.node);
    verifyWindowsControlEnvironment(CONTROL_ENVIRONMENT);
  }
  return { ...CONTROL_ENVIRONMENT };
}
