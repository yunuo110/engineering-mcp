import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { DomainError } from './errors.ts';
import type { GitSnapshot } from './types.ts';

function runGit(repo: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const err = error as { status?: number; stderr?: string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    if (stderr.includes('not a git repository') || err.status === 128) {
      throw new DomainError('GIT_NOT_A_REPO', `Not a git repository: ${repo}`, { stderr });
    }
    throw new DomainError('GIT_COMMAND_FAILED', stderr || err.message || 'git command failed', {
      args: [...args],
      stderr,
    });
  }
}

export function inspectRepo(repoPath: string): GitSnapshot {
  let resolved: string;
  try {
    resolved = realpathSync(repoPath);
  } catch {
    throw new DomainError('GIT_NOT_A_REPO', `Repository path does not exist: ${repoPath}`);
  }

  const repoRoot = realpathSync(runGit(resolved, ['rev-parse', '--show-toplevel']));
  const head = runGit(resolved, ['rev-parse', 'HEAD']);
  const branch = runGit(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = runGit(resolved, ['status', '--porcelain=v1']);
  return {
    repoRoot,
    branch,
    head,
    clean: porcelain.length === 0,
    porcelain,
  };
}

export function requireCleanBaseline(git: GitSnapshot): void {
  if (git.branch === 'HEAD' || git.branch === '') {
    throw new DomainError('DETACHED_HEAD', 'Repository is not on a named branch', {
      branch: git.branch,
    });
  }
  if (!git.clean) {
    throw new DomainError('DIRTY_WORKTREE', 'Working tree is not clean', {
      porcelain: git.porcelain,
    });
  }
}

export function requireSameRepository(git: GitSnapshot, expectedRoot: string): void {
  if (git.repoRoot !== expectedRoot) {
    throw new DomainError(
      'REPOSITORY_MISMATCH',
      `Expected repository ${expectedRoot}, found ${git.repoRoot}`,
      { expected: expectedRoot, actual: git.repoRoot },
    );
  }
}

export function requireClaimBaseline(
  git: GitSnapshot,
  expected: { repo_root: string; branch: string; base_commit: string },
): void {
  requireSameRepository(git, expected.repo_root);
  requireCleanBaseline(git);
  if (git.branch !== expected.branch) {
    throw new DomainError(
      'BRANCH_MISMATCH',
      `Expected branch ${expected.branch}, found ${git.branch}`,
      { expected: expected.branch, actual: git.branch },
    );
  }
  if (git.head !== expected.base_commit) {
    throw new DomainError(
      'HEAD_MISMATCH',
      `Expected HEAD ${expected.base_commit}, found ${git.head}`,
      { expected: expected.base_commit, actual: git.head },
    );
  }
}

export function requireResumeBaseline(
  git: GitSnapshot,
  expected: { repo_root: string; branch: string },
): void {
  requireSameRepository(git, expected.repo_root);
  requireCleanBaseline(git);
  if (git.branch !== expected.branch) {
    throw new DomainError(
      'BRANCH_MISMATCH',
      `Expected branch ${expected.branch}, found ${git.branch}`,
      { expected: expected.branch, actual: git.branch },
    );
  }
}
