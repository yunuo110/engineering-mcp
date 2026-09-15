import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DomainError } from './errors.ts';
import { isPathAllowedByScope } from './scope.ts';
import type { GitSnapshot } from './types.ts';

function runGitRaw(
  repo: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; allowedStatuses?: readonly number[] },
): { output: string; status: number } {
  try {
    const output = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options?.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { output, status: 0 };
  } catch (error) {
    const err = error as { status?: number; stderr?: string; message?: string };
    if (err.status !== undefined && options?.allowedStatuses?.includes(err.status)) {
      return { output: '', status: err.status };
    }
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    if (stderr.includes('not a git repository')) {
      throw new DomainError('GIT_NOT_A_REPO', `Not a git repository: ${repo}`, { stderr });
    }
    throw new DomainError('GIT_COMMAND_FAILED', stderr || err.message || 'git command failed', {
      args: [...args],
      stderr,
    });
  }
}

function runGit(
  repo: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; allowedStatuses?: readonly number[] },
): string {
  return runGitRaw(repo, args, options).output.trim();
}

export function changedFilesFromRepo(repo: string): string[] {
  const porcelain = runGitRaw(repo, ['status', '--porcelain=v1', '-z', '-uall']).output;
  const records = porcelain.split('\0');
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    files.push(record.slice(3).replaceAll('\\', '/'));
    if (/[RC]/.test(record.slice(0, 2))) {
      const source = records[++index];
      if (source) files.push(source.replaceAll('\\', '/'));
    }
  }
  return [...new Set(files)].sort();
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
  const porcelain = runGitRaw(resolved, ['status', '--porcelain=v1']).output.trimEnd();
  return {
    repoRoot,
    branch,
    head,
    clean: porcelain.length === 0,
    porcelain,
  };
}

export type GitCheckpointPlan = {
  taskId: string;
  producerRevision: number;
  purpose: 'RESUME' | 'REVIEW';
  repoRoot: string;
  priorBaseCommit: string;
  branch: string;
  branchRef: string;
  checkpointRef: string;
  expectedTree: string;
  changedFiles: string[];
  scopeIdentity: string;
  requestIdentity: string;
  allowedScope: string[];
  forbiddenScope: string[];
  expectedChangedFiles?: string[];
  timestamp: string;
  message: string;
};

export type GitCheckpointIdentity = {
  taskId: string;
  producerRevision: number;
  repoRoot: string;
  priorBaseCommit: string;
  branch: string;
  checkpointRef: string;
  expectedTree: string;
  requestIdentity: string;
  checkpointCommit: string;
};

export type CheckpointGitStage = 'commit_object' | 'checkpoint_ref' | 'branch_cas';

export function checkpointRefFor(taskId: string, producerRevision: number): string {
  return `refs/engineering-mcp/checkpoints/${taskId}/${producerRevision}`;
}

function requireCheckpointScope(
  files: readonly string[],
  allowedScope: readonly string[],
  forbiddenScope: readonly string[],
): void {
  const rejected = files.filter((file) => {
    return !isPathAllowedByScope(file, allowedScope, forbiddenScope);
  });
  if (rejected.length > 0) {
    throw new DomainError(
      'CHECKPOINT_SCOPE_CONFLICT',
      'Working tree contains changes outside the task checkpoint scope',
      { changed_files: files, rejected_files: rejected },
    );
  }
}

function requireExpectedChangesCaptured(
  changedFiles: readonly string[],
  expectedChangedFiles: readonly string[] | undefined,
): void {
  if (!expectedChangedFiles) return;
  const captured = new Set(changedFiles.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')));
  const missing = [
    ...new Set(expectedChangedFiles.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, ''))),
  ]
    .filter((file) => !captured.has(file))
    .sort();
  if (missing.length > 0) {
    throw new DomainError(
      'CHECKPOINT_UNCAPTURED_CHANGES',
      'Reported task output is not fully represented by the checkpoint tree',
      { missing_files: missing, checkpoint_files: changedFiles },
    );
  }
}

function changedFilesBetweenObjects(
  repo: string,
  baseCommit: string,
  target: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  const output = runGitRaw(repo, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    baseCommit,
    target,
  ], { env }).output;
  return [...new Set(output.split('\0').filter(Boolean).map((file) => file.replaceAll('\\', '/')))].sort();
}

function gitlinksForObject(repo: string, object: string, env?: NodeJS.ProcessEnv): Map<string, string> {
  const output = runGitRaw(repo, ['ls-tree', '-r', '-z', object], { env }).output;
  const result = new Map<string, string>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(\d+)\s+\S+\s+([0-9a-f]+)\t(.*)$/s.exec(record);
    if (match?.[1] === '160000') result.set(match[3]!.replaceAll('\\', '/'), match[2]!);
  }
  return result;
}

function requireUnchangedGitlinks(repo: string, base: string, target: string, env?: NodeJS.ProcessEnv): void {
  const before = gitlinksForObject(repo, base, env);
  const after = gitlinksForObject(repo, target, env);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
  if (changed.length > 0) {
    throw new DomainError(
      'CHECKPOINT_UNSAFE_GITLINK',
      'checkpoint cannot safely preserve changed gitlink/submodule/nested repository output',
      { changed_gitlinks: changed },
    );
  }
}

function buildWorktreeTree(repo: string, baseCommit: string, isolateObjects: boolean): {
  tree: string;
  changedFiles: string[];
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'engineering-mcp-checkpoint-'));
  const indexPath = join(tempDir, 'index');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
  if (isolateObjects) {
    const objectDir = join(tempDir, 'objects');
    mkdirSync(join(objectDir, 'info'), { recursive: true });
    mkdirSync(join(objectDir, 'pack'), { recursive: true });
    const objectPath = runGit(repo, ['rev-parse', '--git-path', 'objects']);
    const repositoryObjects = realpathSync(isAbsolute(objectPath) ? objectPath : resolve(repo, objectPath));
    env.GIT_OBJECT_DIRECTORY = objectDir;
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = repositoryObjects;
  }
  try {
    runGit(repo, ['read-tree', baseCommit], { env });
    runGit(repo, ['add', '-A'], { env });
    const uncaptured = runGitRaw(repo, ['diff-files', '--quiet', '--ignore-submodules=none'], {
      env,
      allowedStatuses: [1],
    });
    if (uncaptured.status !== 0) {
      throw new DomainError(
        'CHECKPOINT_UNCAPTURED_CHANGES',
        'Git cannot represent every dirty worktree change in the checkpoint tree',
      );
    }
    const tree = runGit(repo, ['write-tree'], { env });
    requireUnchangedGitlinks(repo, baseCommit, tree, env);
    return { tree, changedFiles: changedFilesBetweenObjects(repo, baseCommit, tree, env) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function planGitCheckpoint(repo: string, input: {
  taskId: string;
  producerRevision: number;
  purpose: 'RESUME' | 'REVIEW';
  priorBaseCommit: string;
  branch: string;
  allowedScope: string[];
  forbiddenScope: string[];
  expectedChangedFiles?: string[];
  timestamp: string;
}): GitCheckpointPlan {
  const git = inspectRepo(repo);
  requireSameRepository(git, realpathSync(repo));
  const branchRef = runGit(repo, ['symbolic-ref', '-q', 'HEAD']);
  if (branchRef !== `refs/heads/${input.branch}`) {
    throw new DomainError('BRANCH_MISMATCH', `Expected branch ${input.branch}`, {
      expected: input.branch,
      actual_ref: branchRef,
    });
  }
  if (git.head !== input.priorBaseCommit) {
    throw new DomainError('HEAD_MISMATCH', `Expected HEAD ${input.priorBaseCommit}, found ${git.head}`, {
      expected: input.priorBaseCommit,
      actual: git.head,
    });
  }
  const worktree = buildWorktreeTree(repo, input.priorBaseCommit, true);
  if (worktree.changedFiles.length === 0) {
    throw new DomainError('CHECKPOINT_NOTHING_TO_SAVE', 'Working tree has no checkpointable changes');
  }
  requireCheckpointScope(worktree.changedFiles, input.allowedScope, input.forbiddenScope);
  requireExpectedChangesCaptured(worktree.changedFiles, input.expectedChangedFiles);
  const scopeIdentity = stableHash({
    allowed_scope: [...input.allowedScope].sort(),
    forbidden_scope: [...input.forbiddenScope].sort(),
    expected_changed_files: input.expectedChangedFiles ? [...input.expectedChangedFiles].sort() : null,
    changed_files: worktree.changedFiles,
  });
  const checkpointRef = checkpointRefFor(input.taskId, input.producerRevision);
  const requestIdentity = stableHash({
    task_id: input.taskId,
    producer_revision: input.producerRevision,
    purpose: input.purpose,
    repo_root: git.repoRoot,
    prior_base_commit: input.priorBaseCommit,
    branch: input.branch,
    checkpoint_ref: checkpointRef,
    expected_tree: worktree.tree,
    scope_identity: scopeIdentity,
  });
  return {
    ...input,
    repoRoot: git.repoRoot,
    branchRef,
    checkpointRef,
    expectedTree: worktree.tree,
    changedFiles: worktree.changedFiles,
    scopeIdentity,
    requestIdentity,
    message: `Engineering MCP checkpoint ${input.taskId} r${input.producerRevision} ${requestIdentity}`,
  };
}

function requirePlanMatches(expected: GitCheckpointPlan, actual: { tree: string; changedFiles: string[] }): void {
  if (actual.tree !== expected.expectedTree || JSON.stringify(actual.changedFiles) !== JSON.stringify(expected.changedFiles)) {
    throw new DomainError('CHECKPOINT_WORKTREE_CHANGED', 'Working tree no longer matches the prepared checkpoint intent', {
      expected_tree: expected.expectedTree,
      actual_tree: actual.tree,
      expected_changed_files: expected.changedFiles,
      actual_changed_files: actual.changedFiles,
    });
  }
}

export function applyGitCheckpoint(
  repo: string,
  plan: GitCheckpointPlan,
  onStage?: (stage: CheckpointGitStage, checkpointCommit: string) => void,
): string {
  const branchRef = runGit(repo, ['symbolic-ref', '-q', 'HEAD']);
  if (branchRef !== plan.branchRef || branchRef !== `refs/heads/${plan.branch}`) {
    throw new DomainError('BRANCH_MISMATCH', `Expected branch ${plan.branch}`, {
      expected: plan.branch,
      actual_ref: branchRef,
    });
  }
  const head = runGit(repo, ['rev-parse', 'HEAD']);
  const existingRef = runGitRaw(repo, ['rev-parse', '--verify', '--quiet', `${plan.checkpointRef}^{commit}`], {
    allowedStatuses: [1],
  });
  if (head !== plan.priorBaseCommit && existingRef.status !== 0) {
    throw new DomainError('HEAD_MISMATCH', 'Repository moved before checkpoint Git application', {
      expected: plan.priorBaseCommit,
      actual: head,
    });
  }
  const actual = buildWorktreeTree(repo, plan.priorBaseCommit, false);
  requirePlanMatches(plan, actual);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Engineering MCP',
    GIT_AUTHOR_EMAIL: 'engineering-mcp@local',
    GIT_COMMITTER_NAME: 'Engineering MCP',
    GIT_COMMITTER_EMAIL: 'engineering-mcp@local',
    GIT_AUTHOR_DATE: plan.timestamp,
    GIT_COMMITTER_DATE: plan.timestamp,
  };
  const checkpointCommit = runGit(
    repo,
    ['commit-tree', plan.expectedTree, '-p', plan.priorBaseCommit, '-m', plan.message],
    { env },
  );
  onStage?.('commit_object', checkpointCommit);
  if (existingRef.status === 0) {
    const actualRef = existingRef.output.trim();
    if (actualRef !== checkpointCommit) {
      throw new DomainError('CHECKPOINT_PROVENANCE_MISMATCH', 'Existing checkpoint ref has the wrong target', {
        checkpoint_ref: plan.checkpointRef,
        expected: checkpointCommit,
        actual: actualRef,
      });
    }
  } else {
    runGit(repo, ['update-ref', plan.checkpointRef, checkpointCommit, '0000000000000000000000000000000000000000']);
  }
  onStage?.('checkpoint_ref', checkpointCommit);
  const currentHead = runGit(repo, ['rev-parse', 'HEAD']);
  if (currentHead === plan.priorBaseCommit) {
    runGit(repo, ['update-ref', plan.branchRef, checkpointCommit, plan.priorBaseCommit]);
  } else if (currentHead !== checkpointCommit) {
    throw new DomainError('HEAD_MISMATCH', 'Repository branch moved away from the prepared checkpoint lineage', {
      expected: [plan.priorBaseCommit, checkpointCommit],
      actual: currentHead,
    });
  }
  onStage?.('branch_cas', checkpointCommit);
  runGit(repo, ['read-tree', checkpointCommit]);
  verifyGitCheckpointIdentity(repo, { ...plan, checkpointCommit });
  return checkpointCommit;
}

export function verifyGitCheckpointIdentity(repo: string, identity: GitCheckpointIdentity): void {
  const current = inspectRepo(repo);
  requireSameRepository(current, identity.repoRoot);
  if (current.branch !== identity.branch || current.head !== identity.checkpointCommit || !current.clean) {
    throw new DomainError('CHECKPOINT_PROVENANCE_MISMATCH', 'Repository no longer matches the finalized checkpoint', {
      expected_branch: identity.branch,
      actual_branch: current.branch,
      expected_head: identity.checkpointCommit,
      actual_head: current.head,
      porcelain: current.porcelain,
    });
  }
  const ref = runGitRaw(repo, ['rev-parse', '--verify', '--quiet', `${identity.checkpointRef}^{commit}`], {
    allowedStatuses: [1],
  });
  if (ref.status !== 0 || ref.output.trim() !== identity.checkpointCommit) {
    throw new DomainError('CHECKPOINT_PROVENANCE_MISMATCH', 'Checkpoint ref is missing or has the wrong target', {
      checkpoint_ref: identity.checkpointRef,
      expected: identity.checkpointCommit,
      actual: ref.status === 0 ? ref.output.trim() : null,
    });
  }
  const lineage = runGit(repo, ['rev-list', '--parents', '-n', '1', identity.checkpointCommit]).split(/\s+/);
  const tree = runGit(repo, ['rev-parse', `${identity.checkpointCommit}^{tree}`]);
  const message = runGit(repo, ['log', '-1', '--format=%B', identity.checkpointCommit]);
  const expectedMessage = `Engineering MCP checkpoint ${identity.taskId} r${identity.producerRevision} ${identity.requestIdentity}`;
  if (lineage.length !== 2 || lineage[1] !== identity.priorBaseCommit || tree !== identity.expectedTree || message !== expectedMessage) {
    throw new DomainError('CHECKPOINT_PROVENANCE_MISMATCH', 'Checkpoint commit identity does not match its durable intent', {
      checkpoint_commit: identity.checkpointCommit,
      expected_parent: identity.priorBaseCommit,
      actual_parents: lineage.slice(1),
      expected_tree: identity.expectedTree,
      actual_tree: tree,
    });
  }
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
