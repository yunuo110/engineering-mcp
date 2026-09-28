import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepo } from '../src/git.ts';
import { runAuthorityGit, trustedGitEnvironment } from '../src/trusted-git.ts';
import { git, initGitRepo, removeDir } from './helpers.ts';

const repos: string[] = [];
afterEach(() => { for (const repo of repos.splice(0)) removeDir(repo); });
function repo(): string { const path = initGitRepo(); repos.push(path); return path; }

describe('authority Git configuration boundary', () => {
  it('runs real authority inspection with ordinary inert repository config', () => {
    const path = repo();
    expect(inspectRepo(path).clean).toBe(true);
    expect(runAuthorityGit(path, ['rev-parse', 'HEAD']).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
  it.each(['core.fsmonitor', 'filter.sentinel.clean', 'filter.sentinel.smudge',
    'filter.sentinel.process', 'diff.external', 'include.path', 'includeIf.gitdir:/.path',
    'core.hooksPath', 'extensions.worktreeConfig'])(
    'refuses repository executable/configuration key %s before an authority operation', (key) => {
      const path = repo(), sentinel = join(path, 'SENTINEL-MUST-NOT-EXIST');
      const hook = join(path, 'sentinel.cmd');
      writeFileSync(hook, `@echo forbidden>${JSON.stringify(sentinel)}\r\n`);
      git(path, ['config', key, key === 'extensions.worktreeConfig' ? 'true' : hook]);
      expect(() => inspectRepo(path)).toThrow(/outside authority schema/);
      expect(existsSync(sentinel)).toBe(false);
    });
  it('does not inherit ambient GIT configuration, executable selection or global hooks', () => {
    const path = repo(), sentinel = join(path, 'sentinel');
    const config = join(path, 'evil.gitconfig');
    writeFileSync(config, `[core]\n fsmonitor = cmd /c echo forbidden>${sentinel}\n`);
    const old = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      expect(runAuthorityGit(path, ['rev-parse', 'HEAD']).trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(sentinel)).toBe(false);
      expect(trustedGitEnvironment({ GIT_CONFIG_GLOBAL: config, NODE_OPTIONS: '--inspect', PATH: 'bad' }))
        .not.toHaveProperty('GIT_CONFIG_GLOBAL');
    } finally { if (old === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = old; }
  });
  it('disables repository reference-transaction hook during actual checkpoint ref update', () => {
    const path = repo(), sentinel = join(path, 'sentinel');
    const hooks = join(path, '.git', 'hooks'); mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\nprintf forbidden > '${sentinel.replaceAll('\\', '/')}'\n`);
    const head = git(path, ['rev-parse', 'HEAD']);
    runAuthorityGit(path, ['update-ref', 'refs/engineering-mcp/test-boundary', head]);
    expect(existsSync(sentinel)).toBe(false);
    expect(git(path, ['rev-parse', 'refs/engineering-mcp/test-boundary'])).toBe(head);
  });
  it('refuses an indexed gitlink without entering its independently controlled config', () => {
    const path = repo(), nested = join(path, 'nested'); mkdirSync(nested);
    git(nested, ['init']); git(nested, ['config', 'user.email', 'fixture@example.invalid']);
    git(nested, ['config', 'user.name', 'Fixture']); git(nested, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(nested, 'file.txt'), 'fixture'); git(nested, ['add', 'file.txt']);
    git(nested, ['commit', '-m', 'fixture']);
    git(path, ['update-index', '--add', '--cacheinfo', `160000,${git(nested, ['rev-parse', 'HEAD'])},nested`]);
    const sentinel = join(path, 'SUBMODULE-SENTINEL-MUST-NOT-EXIST');
    const hook = join(path, 'submodule-sentinel.cmd');
    writeFileSync(hook, `@echo forbidden>${JSON.stringify(sentinel)}\r\n`);
    git(nested, ['config', 'core.fsmonitor', hook]);
    expect(() => inspectRepo(path)).toThrow(/submodule authority configuration unsupported/);
    expect(existsSync(sentinel)).toBe(false);
  });
});
