import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  connectInProcess,
  initGitRepo,
  openTempStore,
  removeDir,
  tempDir,
  type Connected,
} from './helpers.ts';
import { loadWorkerProfiles, type WorkerProfiles } from '../src/worker-profiles.ts';
import type { Store } from '../src/store.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const connections: Connected[] = [];
const originalStub = process.env.ENGINEERING_MCP_CODEX_STUB;

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  for (const store of stores.splice(0)) store.close();
  if (originalStub === undefined) delete process.env.ENGINEERING_MCP_CODEX_STUB;
  else process.env.ENGINEERING_MCP_CODEX_STUB = originalStub;
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf('object');
  return result.structuredContent as Record<string, unknown>;
}

function writeProfilesAndManifest(): { profiles: WorkerProfiles; manifest: string; profilesFile: string } {
  const dir = tempDir('eng-mcp-profile-delegation-');
  dirs.push(dir);
  const manifest = join(dir, 'generic.yaml');
  writeFileSync(
    manifest,
    `schema: engineering-cli-adapter/1
id: profile-generic
name: Profile Generic
adapter: generic-cli
command: ${JSON.stringify(process.execPath)}
arguments:
  - ${JSON.stringify(fileURLToPath(new URL('./fixtures/generic-harness.cjs', import.meta.url)))}
  - --mode
  - completed
working_directory: "\${repo_root}"
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes: [0]
protocol_mode: native
`,
    'utf8',
  );
  const profilesFile = join(dir, 'profiles.yaml');
  writeFileSync(
    profilesFile,
    `schema: engineering-worker-profiles/1
default_profile: codex-luna
profiles:
  codex-luna:
    adapter: codex-exec-luna
    description: Codex CLI worker
  generic-test:
    adapter: generic-cli
    manifest: ${JSON.stringify(manifest)}
    profile: headless
    model: fake-model
    description: Generic test worker
`,
    'utf8',
  );
  return { profiles: loadWorkerProfiles(profilesFile), manifest, profilesFile };
}

function writeMutationFixture(): {
  profiles: WorkerProfiles;
  manifest: string;
  profilesFile: string;
  scriptA: string;
  scriptB: string;
} {
  const dir = tempDir('eng-mcp-profile-mutation-');
  dirs.push(dir);
  const scriptA = join(dir, 'a.cjs');
  writeFileSync(
    scriptA,
    `const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), 'a.txt'), 'A' + String.fromCharCode(10));
  process.stdout.write(JSON.stringify({
    protocol: 'engineering-worker/1',
    outcome: 'completed',
    summary: 'A executed',
    changed_files: ['a.txt'],
    validation: [],
    known_limitations: [],
    exit_code: 0
  }));
});
`,
    'utf8',
  );
  const scriptB = join(dir, 'b.cjs');
  writeFileSync(
    scriptB,
    `const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), 'b.txt'), 'B' + String.fromCharCode(10));
  process.stdout.write(JSON.stringify({
    protocol: 'engineering-worker/1',
    outcome: 'completed',
    summary: 'B executed',
    changed_files: ['b.txt'],
    validation: [],
    known_limitations: [],
    exit_code: 0
  }));
});
`,
    'utf8',
  );
  const manifest = join(dir, 'generic.yaml');
  const writeManifest = (scriptPath: string): string => `schema: engineering-cli-adapter/1
id: profile-generic
name: Profile Generic
adapter: generic-cli
command: ${JSON.stringify(process.execPath)}
arguments:
  - ${JSON.stringify(scriptPath)}
working_directory: "\${repo_root}"
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes: [0]
protocol_mode: native
`;
  writeFileSync(manifest, writeManifest(scriptA), 'utf8');
  const profilesFile = join(dir, 'profiles.yaml');
  writeFileSync(
    profilesFile,
    `schema: engineering-worker-profiles/1
default_profile: codex-luna
profiles:
  codex-luna:
    adapter: codex-exec-luna
    description: Codex CLI worker
  generic-test:
    adapter: generic-cli
    manifest: ${JSON.stringify(manifest)}
    profile: headless
    model: fake-model
    description: Generic test worker
`,
    'utf8',
  );
  return {
    profiles: loadWorkerProfiles(profilesFile),
    manifest,
    profilesFile,
    scriptA,
    scriptB,
  };
}

async function ownerSession(profiles: WorkerProfiles): Promise<{ repo: string; db: Store; owner: Connected }> {
  const repo = initGitRepo();
  dirs.push(repo);
  const opened = openTempStore(repo);
  stores.push(opened.store);
  dirs.push(opened.dir);
  const owner = await connectInProcess('owner', repo, opened.store, undefined, profiles);
  connections.push(owner);
  return { repo, db: opened.store, owner };
}

describe('OWNER worker profile delegation', () => {
  it('lists trusted worker profiles', async () => {
    const { owner } = await ownerSession(writeProfilesAndManifest().profiles);
    const result = await owner.client.callTool({ name: 'list_worker_profiles', arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = structured(result);
    const profiles = body.profiles as Array<{ id: string; adapter: string; default: boolean }>;
    expect(profiles.map((p) => p.id).sort()).toEqual(['codex-luna', 'generic-test']);
    expect(profiles.find((p) => p.id === 'codex-luna')?.default).toBe(true);
    expect(profiles.find((p) => p.id === 'generic-test')?.adapter).toBe('generic-cli');
  });

  it('delegates through an explicit generic worker profile to COMPLETED', async () => {
    const { owner } = await ownerSession(writeProfilesAndManifest().profiles);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: {
        type: 'IMPLEMENTATION',
        payload: {
          goal: 'Create hello.txt via generic profile',
          parent_intent: 'worker profile delegation',
          allowed_scope: ['hello.txt'],
          forbidden_scope: [],
          acceptance_criteria: [],
          validation_requirements: [],
          context_files: [],
          knowledge_refs: [],
          parent_risk: 'L1',
        },
      },
    });
    const task = structured(created).task as { id: string; revision: number; status: string };
    expect(task.status).toBe('READY');

    const delegated = await owner.client.callTool({
      name: 'delegate_task',
      arguments: { task_id: task.id, revision: task.revision, worker_profile: 'generic-test' },
    });
    expect(delegated.isError).toBeFalsy();
    const body = structured(delegated);
    expect(body.ok).toBe(true);
    const run = body.dispatch_run as { status: string; adapter_id: string; worker_profile_id: string };
    expect(run.status).toBe('completed');
    expect(run.adapter_id).toBe('generic-cli');
    expect(run.worker_profile_id).toBe('generic-test');
    expect((body.task as { status: string }).status).toBe('COMPLETED');
  });

  it('executes startup-captured manifest snapshot and ignores later manifest/profile mutation', async () => {
    const fixture = writeMutationFixture();
    const { owner, repo } = await ownerSession(fixture.profiles);

    // Mutate the original manifest to B and the profile YAML to a different
    // registry. Neither may affect the already-loaded immutable profile.
    writeFileSync(
      fixture.manifest,
      `schema: engineering-cli-adapter/1
id: profile-generic
name: Profile Generic Mutated
adapter: generic-cli
command: ${JSON.stringify(process.execPath)}
arguments:
  - ${JSON.stringify(fixture.scriptB)}
working_directory: "\${repo_root}"
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes: [0]
protocol_mode: native
`,
      'utf8',
    );
    writeFileSync(
      fixture.profilesFile,
      `schema: engineering-worker-profiles/1
default_profile: other
profiles:
  other:
    adapter: codex-exec-luna
`,
      'utf8',
    );

    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: {
        type: 'IMPLEMENTATION',
        payload: {
          goal: 'Prove manifest snapshot is immutable',
          parent_intent: 'TOCTOU regression',
          allowed_scope: ['a.txt', 'b.txt'],
          forbidden_scope: [],
          acceptance_criteria: [],
          validation_requirements: [],
          context_files: [],
          knowledge_refs: [],
          parent_risk: 'L1',
        },
      },
    });
    const task = structured(created).task as { id: string; revision: number; status: string };

    const listed = await owner.client.callTool({ name: 'list_worker_profiles', arguments: {} });
    expect(listed.isError).toBeFalsy();
    const listedBody = structured(listed);
    const listedProfiles = listedBody.profiles as Array<{ id: string }>;
    expect(listedProfiles.map((p) => p.id)).toContain('generic-test');

    const delegated = await owner.client.callTool({
      name: 'delegate_task',
      arguments: { task_id: task.id, revision: task.revision, worker_profile: 'generic-test' },
    });
    expect(delegated.isError).toBeFalsy();
    const body = structured(delegated);
    expect(body.ok).toBe(true);
    expect((body.task as { status: string }).status).toBe('COMPLETED');

    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('A');
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
  });

  it('preserves built-in codex-luna default when worker_profile is omitted', async () => {
    process.env.ENGINEERING_MCP_CODEX_STUB = '1';
    const { owner } = await ownerSession(writeProfilesAndManifest().profiles);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: {
        type: 'IMPLEMENTATION',
        payload: {
          goal: 'No-op codex stub',
          parent_intent: 'builtin default profile',
          allowed_scope: [],
          forbidden_scope: [],
          acceptance_criteria: [],
          validation_requirements: [],
          context_files: [],
          knowledge_refs: [],
          parent_risk: 'L1',
        },
      },
    });
    const task = structured(created).task as { id: string; revision: number; status: string };

    const delegated = await owner.client.callTool({
      name: 'delegate_task',
      arguments: { task_id: task.id, revision: task.revision },
    });
    expect(delegated.isError).toBeFalsy();
    const body = structured(delegated);
    const run = body.dispatch_run as { status: string; adapter_id: string; worker_profile_id: string };
    expect(run.status).toBe('completed');
    expect(run.adapter_id).toBe('codex-exec-luna');
    expect(run.worker_profile_id).toBe('codex-luna');
  });

  it('fails closed on unknown worker_profile before claim or dispatch', async () => {
    const { repo, db, owner } = await ownerSession(writeProfilesAndManifest().profiles);
    const created = await owner.client.callTool({
      name: 'create_task',
      arguments: {
        type: 'IMPLEMENTATION',
        payload: {
          goal: 'No-op unknown profile',
          parent_intent: 'unknown profile',
          allowed_scope: [],
          forbidden_scope: [],
          acceptance_criteria: [],
          validation_requirements: [],
          context_files: [],
          knowledge_refs: [],
          parent_risk: 'L1',
        },
      },
    });
    const task = structured(created).task as { id: string; revision: number; status: string };

    const delegated = await owner.client.callTool({
      name: 'delegate_task',
      arguments: { task_id: task.id, revision: task.revision, worker_profile: 'nonexistent' },
    });
    expect(delegated.isError).toBe(true);
    const body = structured(delegated);
    const error = body.error as { code: string };
    expect(error.code).toBe('WORKER_PROFILE_NOT_FOUND');
    expect(db.getTask(task.id)?.status).toBe('READY');
    expect(db.getTask(task.id)?.revision).toBe(task.revision);
    expect(db.getActiveDispatchForTask(task.id)).toBeUndefined();
    expect(repo).toBeTruthy();
  });
});
