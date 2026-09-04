import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.ts';
import {
  inspectRepo,
  requireClaimBaseline,
  requireCleanBaseline,
  requireResumeBaseline,
} from '../src/git.ts';
import { cloneRepo, extraCommit, git, initGitRepo, makeDirty, removeDir, snapshot } from './helpers.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    removeDir(dir);
  }
});

describe('git baseline', () => {
  it('captures root, branch, HEAD, and cleanliness without mutating Git', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const before = git(repo, ['rev-parse', 'HEAD']);
    const snap = inspectRepo(repo);
    expect(snap.head).toBe(before);
    expect(snap.clean).toBe(true);
    expect(snap.branch).not.toBe('HEAD');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(repo, ['status', '--porcelain=v1'])).toBe('');
  });

  it('detects a dirty tree and does not clean it', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    makeDirty(repo);
    const snap = inspectRepo(repo);
    expect(snap.clean).toBe(false);
    expect(snap.porcelain).toContain('dirty.txt');
    expect(() => requireCleanBaseline(snap)).toThrow(DomainError);
    try {
      requireCleanBaseline(snap);
    } catch (error) {
      expect((error as DomainError).code).toBe('DIRTY_WORKTREE');
    }
    expect(inspectRepo(repo).clean).toBe(false);
  });

  it('requires matching branch and HEAD on claim', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    const original = snapshot(repo);
    extraCommit(repo);
    const moved = snapshot(repo);
    let headError: unknown;
    try {
      requireClaimBaseline(moved, {
        repo_root: original.repoRoot,
        branch: original.branch,
        base_commit: original.head,
      });
    } catch (error) {
      headError = error;
    }
    expect(headError).toBeInstanceOf(DomainError);
    expect((headError as DomainError).code).toBe('HEAD_MISMATCH');
    git(repo, ['checkout', '-b', 'other']);
    const branched = snapshot(repo);
    let branchError: unknown;
    try {
      requireClaimBaseline(branched, {
        repo_root: original.repoRoot,
        branch: original.branch,
        base_commit: moved.head,
      });
    } catch (error) {
      branchError = error;
    }
    expect(branchError).toBeInstanceOf(DomainError);
    expect((branchError as DomainError).code).toBe('BRANCH_MISMATCH');
  });

  it('rejects a path that is not a git repository', () => {
    const repo = initGitRepo();
    dirs.push(repo);
    expect(() => inspectRepo(repo + '-missing')).toThrow(DomainError);
  });

  it('rejects claim and resume baselines when the canonical repository root differs', () => {
    const repoA = initGitRepo();
    const repoB = cloneRepo(repoA);
    dirs.push(repoA, repoB);
    const gitA = snapshot(repoA);
    const gitB = snapshot(repoB);
    expect(gitA.head).toBe(gitB.head);
    expect(gitA.branch).toBe(gitB.branch);
    expect(gitA.repoRoot).not.toBe(gitB.repoRoot);
    let claimRepoError: unknown;
    try {
      requireClaimBaseline(gitB, {
        repo_root: gitA.repoRoot,
        branch: gitA.branch,
        base_commit: gitA.head,
      });
    } catch (error) {
      claimRepoError = error;
    }
    expect(claimRepoError).toBeInstanceOf(DomainError);
    expect((claimRepoError as DomainError).code).toBe('REPOSITORY_MISMATCH');
    let resumeRepoError: unknown;
    try {
      requireResumeBaseline(gitB, { repo_root: gitA.repoRoot, branch: gitA.branch });
    } catch (error) {
      resumeRepoError = error;
    }
    expect(resumeRepoError).toBeInstanceOf(DomainError);
    expect((resumeRepoError as DomainError).code).toBe('REPOSITORY_MISMATCH');
  });
});
