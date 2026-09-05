import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRepoRoot, git, initGitRepo, removeDir, tempDir } from './helpers.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const fixture = fileURLToPath(new URL('./fixtures/repository-startup-fixture.ts', import.meta.url));

function runFixture(options: { cwd: string; arg?: string; envRepo?: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [fixture];
    if (options.arg) args.push('--repo', options.arg);
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.envRepo ? { ENGINEERING_MCP_REPO: options.envRepo } : {}) },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', () => resolve({ code: null, stdout, stderr }));
  });
}

describe('automatic repository binding child startup', () => {
  it('subdirectory cwd auto-resolves to same ledger as explicit root', async () => {
    const root = initGitRepo();
    dirs.push(root);
    mkdirSync(`${root}/engine`, { recursive: true });

    const explicit = await runFixture({ cwd: root, arg: root });
    expect(explicit.code).toBe(0);
    const explicitData = JSON.parse(explicit.stdout);
    expect(explicitData.repoRoot).toBe(root);

    const auto = await runFixture({ cwd: `${root}/engine` });
    expect(auto.code).toBe(0);
    const autoData = JSON.parse(auto.stdout);
    expect(autoData.repoRoot).toBe(root);
    expect(autoData.ledgerPath).toBe(explicitData.ledgerPath);
  });

  it('environment override wins over cwd', async () => {
    const envRepo = initGitRepo();
    const cwdRepo = initGitRepo();
    dirs.push(envRepo, cwdRepo);
    const result = await runFixture({ cwd: cwdRepo, envRepo });
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.repoRoot).toBe(envRepo);
    expect(data.source).toBe('environment');
  });

  it('linked worktree child startup resolves to worktree root', async () => {
    const primary = initGitRepo();
    dirs.push(primary);
    const wt = tempDir('eng-mcp-wt-child-');
    dirs.push(wt);
    git(primary, ['worktree', 'add', wt, '-b', 'wt-child']);
    const worktreeRoot = canonicalRepoRoot(wt);
    mkdirSync(`${worktreeRoot}/sub`, { recursive: true });

    const result = await runFixture({ cwd: `${worktreeRoot}/sub` });
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.repoRoot).toBe(worktreeRoot);
    expect(data.repoRoot).not.toBe(primary);
  });

  it('non-Git cwd fails closed in child startup', async () => {
    const outside = tempDir('eng-mcp-nonrepo-child-');
    dirs.push(outside);
    const result = await runFixture({ cwd: outside });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('REPOSITORY_NOT_FOUND');
  });
});
