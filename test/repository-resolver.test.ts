import { afterEach, describe, expect, it } from 'vitest';
import { resolveRepository } from '../src/repository-resolver.ts';
import { DomainError } from '../src/errors.ts';
import { git, initGitRepo, removeDir, tempDir } from './helpers.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function repoWithSubdir(): { root: string; subdir: string } {
  const root = initGitRepo();
  dirs.push(root);
  const subdir = `${root}/src/foo`;
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(subdir, { recursive: true });
  return { root, subdir };
}

function linkedWorktree(): { primary: string; worktree: string; worktreeSub: string } {
  const primary = initGitRepo();
  dirs.push(primary);
  const wt = tempDir('eng-mcp-wt-');
  dirs.push(wt);
  git(primary, ['worktree', 'add', wt, '-b', 'wt-branch']);
  const sub = `${wt}/subdir`;
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(sub, { recursive: true });
  return { primary, worktree: wt, worktreeSub: sub };
}

describe('repository resolver precedence', () => {
  it('explicit arg wins over env and cwd', () => {
    const a = initGitRepo();
    const b = initGitRepo();
    const c = initGitRepo();
    dirs.push(a, b, c);
    const result = resolveRepository({ arg: a, envRepo: b, cwd: c });
    expect(result.source).toBe('explicit-arg');
    expect(result.repoRoot).toBe(a);
  });

  it('environment wins over cwd', () => {
    const a = initGitRepo();
    const b = initGitRepo();
    dirs.push(a, b);
    const result = resolveRepository({ envRepo: a, cwd: b });
    expect(result.source).toBe('environment');
    expect(result.repoRoot).toBe(a);
  });

  it('cwd repo root resolves to same root', () => {
    const { root } = repoWithSubdir();
    const result = resolveRepository({ cwd: root });
    expect(result.source).toBe('cwd-git');
    expect(result.repoRoot).toBe(root);
  });

  it('cwd subdirectory resolves to repo root', () => {
    const { root, subdir } = repoWithSubdir();
    const result = resolveRepository({ cwd: subdir });
    expect(result.repoRoot).toBe(root);
  });

  it('linked worktree resolves to worktree root, not primary checkout', () => {
    const { primary, worktree, worktreeSub } = linkedWorktree();
    const result = resolveRepository({ cwd: worktreeSub });
    expect(result.repoRoot).toBe(worktree);
    expect(result.repoRoot).not.toBe(primary);
  });

  it('non-Git cwd fails closed', () => {
    const outside = tempDir('eng-mcp-nonrepo-');
    dirs.push(outside);
    let error: unknown;
    try {
      resolveRepository({ cwd: outside });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('REPOSITORY_NOT_FOUND');
  });

  it('explicit subdirectory normalizes to toplevel', () => {
    const { root, subdir } = repoWithSubdir();
    const result = resolveRepository({ arg: subdir });
    expect(result.repoRoot).toBe(root);
  });
});
