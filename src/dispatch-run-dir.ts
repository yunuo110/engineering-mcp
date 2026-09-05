import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dispatchRunDir(dispatchRunId: string): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dir = join(base, 'engineering-mcp', 'runs', dispatchRunId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
