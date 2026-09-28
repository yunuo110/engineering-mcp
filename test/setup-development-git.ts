import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Test-only discovery. Core's staged runtime never reads this variable.
const whereExe = 'C:\\Windows\\System32\\where.exe';
const first = execFileSync(whereExe, ['git'], { encoding: 'utf8', windowsHide: true })
  .split(/\r?\n/).find(Boolean);
if (!first || !isAbsolute(first) || !existsSync(first))
  throw new Error('test Git executable not found');
process.env.ENGINEERING_MCP_DEVELOPMENT_GIT_EXE = first;
