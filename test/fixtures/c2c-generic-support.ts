import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTask } from '../../src/lifecycle.ts';
import { createAcceptedDispatchIntent } from '../../src/commands/delegation-intent.ts';
import { acceptEvaluatedPlan } from '../../src/commands/plan-acceptance.ts';
import { durableEvaluateC2CMessage } from '../../src/receipts/c2c-evaluation.ts';
import { loadWorkerProfiles } from '../../src/worker-profiles.ts';
import { dispatchRunDir } from '../../src/dispatch-run-dir.ts';
import type { Store } from '../../src/store.ts';
import { git, implPayload, initGitRepo, openTempStore, snapshot, tempDir } from '../helpers.ts';
import { materializeNativeGenericHarness } from './generic-native-harness.ts';

export function genericManifest(exe: string) {
  return {
    schema: 'engineering-cli-adapter/1', id: 'native-test', name: 'Native test harness',
    adapter: 'generic-cli', command: exe,
    arguments: ['${repo_root}', '${run_dir}', '${task_id}', '${dispatch_run_id}'],
    working_directory: '${repo_root}',
    prompt: { transport: 'stdin', format: 'engineering-worker/1' },
    result: { source: 'stdout', format: 'json', strategy: 'last-json-object' },
    process: { shell: false, success_exit_codes: [0] },
    protocol_mode: 'native',
    metadata: { arbitrary: 'metadata-private-sentinel' },
    capabilities: { arbitrary: 'capabilities-private-sentinel' },
  };
}

export function genericFixture(
  dirs: string[], stores: Store[], mode = 'edit', successCodes = [0],
) {
  const repo = initGitRepo();
  dirs.push(repo);
  const originalHead = snapshot(repo).head;
  writeFileSync(join(repo, 'bridge-mode.txt'), mode);
  writeFileSync(join(repo, '.gitignore'), '.cache/\n');
  if (mode === 'head') writeFileSync(join(repo, 'bridge-head.txt'), originalHead);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'native harness controls']);
  const assets = tempDir('eng-mcp-native-b-');
  dirs.push(assets);
  const exe = materializeNativeGenericHarness(assets);
  const manifest = genericManifest(exe);
  manifest.process.success_exit_codes = [...successCodes];
  const manifestPath = join(assets, 'manifest.json');
  const profilesPath = join(assets, 'profiles.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(profilesPath, JSON.stringify({
    schema: 'engineering-worker-profiles/1', default_profile: 'native-test',
    profiles: { 'native-test': { adapter: 'generic-cli', manifest: manifestPath } },
  }));
  const profiles = loadWorkerProfiles(profilesPath);
  const opened = openTempStore(repo);
  dirs.push(opened.dir);
  stores.push(opened.store);
  const store = opened.store;
  const before = snapshot(repo);
  const task = createTask(store, before, {
    type: 'IMPLEMENTATION',
    payload: { ...implPayload, goal: 'Exercise the native harness', allowed_scope: ['README.md'], forbidden_scope: ['AGENTS.md', '.cache'] },
  });
  const owner = { actor_role: 'OWNER' as const, repo_root: repo };
  const plan = {
    protocol_version: 'engineering-c2c/1' as const, message_id: 'native-plan-' + task.id,
    task_id: task.id, sender_role: 'OWNER' as const, state: 'PLAN' as const,
    expected_revision: task.revision, goal: 'native harness proof',
  };
  if (durableEvaluateC2CMessage(store, plan, owner).decision !== 'REQUIRES_OWNER_ACTION') throw new Error('PLAN failed');
  const acceptance = { command_id: 'native-accept-' + task.id, plan_message: plan };
  if (acceptEvaluatedPlan(store, acceptance, owner).decision !== 'ACCEPTED') throw new Error('acceptance failed');
  const command = {
    command_id: 'native-dispatch-' + task.id,
    acceptance_command_id: acceptance.command_id,
    worker_profile_id: 'native-test',
  };
  const built = createAcceptedDispatchIntent(store, command, owner, profiles);
  if (built.decision !== 'CREATED') throw new Error(JSON.stringify(built));
  const receipt = built.receipt;
  const runDir = dispatchRunDir(receipt.dispatch_run_id);
  dirs.push(runDir);
  return { repo, assets, exe, manifest, manifestPath, profilesPath, profiles, store, before, task, owner, command, receipt, runDir };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('native C2C test timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function executionCount(runDir: string): number {
  try { return readFileSync(join(runDir, 'executions.txt'), 'utf8').split(/\r?\n/).filter(Boolean).length; }
  catch { return 0; }
}
