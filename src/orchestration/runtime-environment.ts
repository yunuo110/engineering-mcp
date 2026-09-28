/** libuv on Windows supplies these variables when omitted. Empty is intentional. */
export function boundedControlEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32' && process.versions.uv !== '1.51.0') {
    throw new Error('CONTROL_ENVIRONMENT_REFUSED:unreviewed Windows libuv environment contract');
  }
  return {
    HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', PATH: '', SYSTEMDRIVE: '',
    SystemRoot: 'C:\\Windows', TEMP: '', TMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', WINDIR: '',
  };
}
