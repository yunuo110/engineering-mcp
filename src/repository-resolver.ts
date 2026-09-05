import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { DomainError } from './errors.ts';

export type RepositorySource = 'explicit-arg' | 'environment' | 'cwd-git';

export type RepositoryResolution = {
  repoRoot: string;
  source: RepositorySource;
};

function gitTopLevel(candidate: string): string {
  try {
    const root = execFileSync('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return realpathSync(root);
  } catch {
    throw new DomainError(
      'REPOSITORY_NOT_FOUND',
      `Auto repository discovery failed. Launch cwd is not inside a Git worktree: ${candidate}. Provide --repo or ENGINEERING_MCP_REPO.`,
      { launch_cwd: candidate },
    );
  }
}

export function resolveRepository(options: {
  arg?: string;
  envRepo?: string;
  cwd?: string;
}): RepositoryResolution {
  if (options.arg) {
    return { repoRoot: gitTopLevel(options.arg), source: 'explicit-arg' };
  }
  if (options.envRepo) {
    return { repoRoot: gitTopLevel(options.envRepo), source: 'environment' };
  }
  const cwd = options.cwd ?? process.cwd();
  return { repoRoot: gitTopLevel(cwd), source: 'cwd-git' };
}
