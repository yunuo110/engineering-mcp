import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export type CodexLaunchKind = 'native' | 'cmd' | 'direct';

export type CodexLaunch = {
  kind: CodexLaunchKind;
  executable: string;
  displayPath: string;
};

export type CodexLauncherOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  where?: (name: string) => string[];
};

function defaultWhere(name: string): string[] {
  try {
    const output = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function resolveCodexLauncher(options: CodexLauncherOptions = {}): CodexLaunch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const where = options.where ?? defaultWhere;

  if (platform !== 'win32') {
    return { kind: 'direct', executable: 'codex', displayPath: 'codex' };
  }

  const exePaths = where('codex.exe');
  if (exePaths.length > 0 && existsSync(exePaths[0]!)) {
    return { kind: 'native', executable: exePaths[0]!, displayPath: exePaths[0]! };
  }

  const cmdPaths = where('codex.cmd');
  if (cmdPaths.length > 0 && existsSync(cmdPaths[0]!)) {
    return { kind: 'cmd', executable: cmdPaths[0]!, displayPath: cmdPaths[0]! };
  }

  const configured = env.ENGINEERING_MCP_CODEX_LAUNCHER;
  if (configured && existsSync(configured)) {
    return configured.toLowerCase().endsWith('.cmd')
      ? { kind: 'cmd', executable: configured, displayPath: configured }
      : { kind: 'native', executable: configured, displayPath: configured };
  }

  throw new Error(
    'No launchable Windows Codex wrapper found. Expected codex.exe, codex.cmd, or ENGINEERING_MCP_CODEX_LAUNCHER.',
  );
}
