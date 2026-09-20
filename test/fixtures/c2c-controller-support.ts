import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createEngineeringServer } from '../../src/server.ts';
import type { ServerConfig } from '../../src/tools.ts';
import { createTask } from '../../src/lifecycle.ts';
import { loadWorkerProfiles } from '../../src/worker-profiles.ts';
import type { Store } from '../../src/store.ts';
import type { C2CControllerContext, ExecuteC2CPlanInput } from '../../src/c2c/controller.ts';
import { implPayload, initGitRepo, openTempStore, snapshot, tempDir, git } from '../helpers.ts';
import { genericManifest } from './c2c-generic-support.ts';
import { materializeNativeGenericHarness } from './generic-native-harness.ts';

/** Fresh task: no evaluation, acceptance or dispatch has been pre-created. */
export function controllerFixture(dirs: string[], stores: Store[]) {
  const repo = initGitRepo();
  dirs.push(repo);
  writeFileSync(join(repo, 'bridge-mode.txt'), 'edit');
  git(repo, ['add', 'bridge-mode.txt']);
  git(repo, ['commit', '-m', 'deterministic controller fixture']);
  const assets = tempDir('eng-mcp-controller-assets-');
  dirs.push(assets);
  const exe = materializeNativeGenericHarness(assets);
  const manifestPath = join(assets, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(genericManifest(exe)));
  const profilesPath = join(assets, 'profiles.json');
  writeFileSync(profilesPath, JSON.stringify({
    schema: 'engineering-worker-profiles/1', default_profile: 'native-test',
    profiles: { 'native-test': { adapter: 'generic-cli', manifest: manifestPath } },
  }));
  const profiles = loadWorkerProfiles(profilesPath);
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  const task = createTask(opened.store, snapshot(repo), {
    type: 'IMPLEMENTATION', payload: { ...implPayload, allowed_scope: ['README.md'] },
  });
  const request: ExecuteC2CPlanInput = {
    plan_message: {
      protocol_version: 'engineering-c2c/1', state: 'PLAN', sender_role: 'OWNER',
      message_id: 'controller-plan-' + task.id, task_id: task.id,
      expected_revision: task.revision, goal: 'Run deterministic controller fixture',
    },
    acceptance_command_id: 'controller-accept-' + task.id,
    delegation_command_id: 'controller-delegate-' + task.id,
    worker_profile_id: 'native-test',
  };
  const context: C2CControllerContext = {
    processRole: 'owner', enableC2CController: true, repoPath: repo,
    store: opened.store, workerProfiles: profiles,
  };
  return { repo, assets, exe, profilesPath, manifestPath, task, request, context, store: opened.store };
}

export async function controllerConnection(
  context: C2CControllerContext &
    Pick<ServerConfig, 'c2cPrivateClient' | 'c2cContractVersion'>,
) {
  const config: ServerConfig = { ...context, executionInstanceId: randomUUID() };
  const server = createEngineeringServer(config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c2c-controller-test', version: '0.0.0' });
  await server.connect(st);
  await client.connect(ct);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}
