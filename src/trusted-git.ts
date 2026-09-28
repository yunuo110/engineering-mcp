import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProtectedExecutionMode, verifyTrustedRuntime, type TrustedRuntimeBinding } from './orchestration/trusted-runtime.ts';
import { boundedControlEnvironment } from './orchestration/runtime-environment.ts';

let checkedBinding: TrustedRuntimeBinding | undefined;
let standardGit: string | undefined;

/** Core/Trusted Runner Git, never the Worker/Harness tool lookup. */
export function trustedGitExecutable(): string {
  if (isProtectedExecutionMode()) {
    checkedBinding = verifyTrustedRuntime();
    return checkedBinding.gitPath;
  }
  if (import.meta.url.endsWith('.ts')) {
    // Source-mode development/test only. The executable is still absolute;
    // test setup resolves it before any authority operation.
    const developmentPath = process.env.ENGINEERING_MCP_DEVELOPMENT_GIT_EXE;
    if (!developmentPath || !isAbsolute(developmentPath) || !existsSync(developmentPath))
      throw new Error('TRUSTED_GIT_REFUSED:development Git binding absent');
    return developmentPath;
  }
  // Standard package mode is not a protected execution deployment. Resolve once
  // at startup; every authority operation still uses the native config gate.
  if (!standardGit) {
    const locator = process.platform === 'win32' ? 'C:\\Windows\\System32\\where.exe' : '/usr/bin/which';
    const found = execFileSync(locator, ['git'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).find(Boolean);
    if (!found || !isAbsolute(found) || !existsSync(found)) throw new Error('TRUSTED_GIT_REFUSED:Git executable unavailable');
    standardGit = found;
  }
  return standardGit;
}

export function trustedGitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
  for (const key of AUTHORITY_ENV) if (extra?.[key] !== undefined) env[key] = extra[key];
  return env;
}

const AUTHORITY_ENV = ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'] as const;

/** Config parsing and Git execution share native read locks, not a check/use gap. */
export function runAuthorityGit(repo: string, args: readonly string[], extra?: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') throw new Error('AUTHORITY_GIT_REFUSED:Windows config boundary required');
  const git = trustedGitExecutable();
  const launcher = isProtectedExecutionMode() ? checkedBinding!.authorityGitPath
    : join(dirname(fileURLToPath(import.meta.url)), ...(import.meta.url.endsWith('.ts') ? ['..', 'dist'] : []),
      'native', 'authority-git.exe');
  if (!existsSync(launcher)) throw new Error('AUTHORITY_GIT_REFUSED:native configuration gate missing');
  const env: Record<string, string> = {};
  for (const key of AUTHORITY_ENV) if (extra?.[key] !== undefined) env[key] = extra[key]!;
  return execFileSync(launcher, [], { input: JSON.stringify({ git, repo, args, env }),
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 35000,
    env: boundedControlEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
}
