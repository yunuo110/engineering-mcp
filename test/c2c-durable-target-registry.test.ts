import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as exactCodex from '../src/adapters/engineering-codex-luna-v1-adapter.ts';
import * as registry from '../src/c2c/durable-target-registry.ts';
import {
  buildDurableTargetFromTrustedProfile,
  durableTargetSpecSchema,
  getDurableTargetRuntime,
} from '../src/c2c/durable-target-registry.ts';
import {
  c2cDelegationIntentReceiptSchema,
  createAcceptedDispatchIntentCommandSchema,
  normalizedC2CDelegationReceiptRowSchema,
} from '../src/commands/delegation-schema.ts';
import { createAcceptedDispatchIntent } from '../src/commands/delegation-intent.ts';
import { dispatchRunDir } from '../src/dispatch-run-dir.ts';
import * as frozenLaunch from '../src/commands/launch-spec.ts';
import { acceptEvaluatedPlan } from '../src/commands/plan-acceptance.ts';
import { createTask } from '../src/lifecycle.ts';
import { runC2CWorkerRunner } from '../src/orchestration/c2c-worker-runner.ts';
import { durableEvaluateC2CMessage } from '../src/receipts/c2c-evaluation.ts';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION, WRITER_PROTOCOL_GENERATION } from '../src/types.ts';
import { builtinWorkerProfiles, type WorkerProfiles } from '../src/worker-profiles.ts';
import {
  implPayload,
  initGitRepo,
  openTempStore,
  removeDir,
  snapshot,
  tempDir,
} from './helpers.ts';

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function nativeExe(): string {
  const dir = tempDir('eng-mcp-bridge-a-');
  dirs.push(dir);
  const exe = join(dir, 'codex.exe');
  writeFileSync(exe, 'historical-codex-artifact', 'utf8');
  return realpathSync(exe);
}

function buildOptions(exe: string): frozenLaunch.LaunchSpecBuildOptions {
  return {
    platform: 'win32',
    env: { OPENAI_FAKE_SECRET: 'bridge-a-secret-must-not-be-persisted' },
    resolveLauncher: () => ({ kind: 'native', executable: exe, displayPath: exe }),
  };
}

// This fixture is written in the pre-Bridge-A format, independently of either
// the new registry or the existing builder. It has no new required fields.
function historicalSpec(exe: string): frozenLaunch.SecretSafeLaunchSpecV1 {
  return {
    schema: 'engineering-launch/1',
    platform: 'win32',
    launcher: {
      kind: 'native',
      executable_path: exe,
      executable_sha256: createHash('sha256')
        .update('historical-codex-artifact')
        .digest('hex'),
    },
    argv_template: [
      'exec', '--model', 'gpt-5.6-luna', '-C', '${task_repo_root}',
      '-s', 'workspace-write', '--json', '--ephemeral',
      '--output-last-message', '${dispatch_run_dir}/last-message.txt', '-',
    ],
    working_directory_policy: 'task_repo_root',
    prompt_contract: 'engineering-codex-luna-prompt/1',
    prompt_transport: 'stdin',
    result_contract: 'engineering-codex-luna-last-message/1',
    credential_policy: 'inherit-trusted-runtime-environment',
  };
}

function profilesWithAdapter(adapter: string): WorkerProfiles {
  const profiles = builtinWorkerProfiles();
  return {
    ...profiles,
    profiles: new Map([
      ['codex-luna', { ...profiles.profiles.get('codex-luna')!, adapter }],
    ]),
  };
}

const command = {
  command_id: 'historical-delegate',
  acceptance_command_id: 'historical-accept',
  worker_profile_id: 'codex-luna',
};

function historicalRow(spec: frozenLaunch.SecretSafeLaunchSpecV1) {
  return {
    command_id: command.command_id,
    acceptance_command_id: command.acceptance_command_id,
    dispatch_run_id: 'historical-dispatch',
    launch_spec: spec,
    created_at: '2026-09-17T00:00:00.000Z',
  };
}

function historicalProjection(spec: frozenLaunch.SecretSafeLaunchSpecV1) {
  return {
    ...historicalRow(spec),
    task_id: 'historical-task',
    accepted_revision: 1,
    worker_profile_id: 'codex-luna',
    adapter_id: 'codex-exec-luna',
    dispatch_status: 'launching' as const,
  };
}

describe('Harness Bridge A compiled durable-target seam', () => {
  it('strictly parses the historical engineering-launch/1 and receipt projections unchanged', () => {
    const spec = historicalSpec(nativeExe());
    const raw = JSON.parse(JSON.stringify(spec)) as unknown;
    const frozen = frozenLaunch.secretSafeLaunchSpecV1Schema.parse(raw);
    expect(durableTargetSpecSchema.parse(raw)).toEqual(frozen);
    expect(getDurableTargetRuntime(spec.schema).parse(raw)).toEqual(frozen);
    expect(JSON.stringify(durableTargetSpecSchema.parse(raw))).toBe(JSON.stringify(spec));
    expect(normalizedC2CDelegationReceiptRowSchema.parse(historicalRow(spec)))
      .toEqual(historicalRow(spec));
    expect(c2cDelegationIntentReceiptSchema.parse(historicalProjection(spec)))
      .toEqual(historicalProjection(spec));
    // Bridge B adds a distinct second variant; the frozen Codex schema remains identical.
    expect(durableTargetSpecSchema.options).toHaveLength(2);
    expect(durableTargetSpecSchema.options[0]).toBe(frozenLaunch.secretSafeLaunchSpecV1Schema);
  });

  it.each([
    'engineering-launch/2', 'engineering-generic-cli-target/1',
    'codex-exec-luna', 'codex', 'generic-cli', 'grok', 'deepseek',
    '__proto__', 'constructor', 'toString', '../untrusted-target.ts', '',
  ])('fails closed for the unregistered durable schema %j', (schema) => {
    const spec = { ...historicalSpec(nativeExe()), schema };
    expect(durableTargetSpecSchema.safeParse(spec).success).toBe(false);
    expect(normalizedC2CDelegationReceiptRowSchema.safeParse(historicalRow(spec as never)).success)
      .toBe(false);
    expect(c2cDelegationIntentReceiptSchema.safeParse(historicalProjection(spec as never)).success)
      .toBe(false);
    if (schema === 'engineering-generic-cli-target/1') {
      // Now registered by B, but relabelling a Codex record is still invalid.
      expect(() => getDurableTargetRuntime(schema).parse(spec)).toThrow();
    } else {
      expect(() => getDurableTargetRuntime(schema)).toThrow(/Unsupported C2C durable target schema/);
    }
  });

  it('keeps frozen strictness for extra fields and changed argv/prompt/launcher contracts', () => {
    const spec = historicalSpec(nativeExe());
    const runtime = getDurableTargetRuntime(spec.schema);
    for (const raw of [
      { ...spec, module: './untrusted.ts' },
      { ...spec, launcher: { ...spec.launcher, shell: true } },
      { ...spec, argv_template: ['exec', '--model', 'other-model'] },
      { ...spec, prompt_contract: 'mutable-prompt/2' },
      { ...spec, platform: 'linux' },
      { ...spec, credential_policy: 'secret_ref' },
      { ...spec, launcher: { ...spec.launcher, executable_sha256: 'bad-hash' } },
      { ...spec, schema: undefined },
      null,
    ]) {
      expect(frozenLaunch.secretSafeLaunchSpecV1Schema.safeParse(raw).success).toBe(false);
      expect(durableTargetSpecSchema.safeParse(raw).success).toBe(false);
      expect(() => runtime.parse(raw)).toThrow();
    }
  });

  it('delegates the trusted build mapping to the existing builder without changing its spec', () => {
    const exe = nativeExe();
    const profiles = builtinWorkerProfiles();
    const options = buildOptions(exe);
    const expected = frozenLaunch.buildSecretSafeCodexLunaLaunchSpecV1(profiles, 'codex-luna', options);
    const builder = vi.spyOn(frozenLaunch, 'buildSecretSafeCodexLunaLaunchSpecV1');
    const built = buildDurableTargetFromTrustedProfile(profiles, 'codex-luna', options);
    expect(builder).toHaveBeenCalledExactlyOnceWith(profiles, 'codex-luna', options);
    expect(built).toEqual({ ...expected, adapterId: 'codex-exec-luna' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected the frozen built-in target');
    expect(built.spec).toEqual(historicalSpec(exe));
    expect(JSON.stringify(built.spec)).not.toContain('bridge-a-secret-must-not-be-persisted');
  });

  it.each(['codex', 'generic-cli', 'grok', 'deepseek', '__proto__', 'constructor', 'toString'])
    ('does not register or discover an ordinary/untrusted adapter %j', (adapter) => {
      const profiles = profilesWithAdapter(adapter);
      const resolveLauncher = vi.fn(() => { throw new Error('must not discover'); });
      const options = { platform: 'win32' as const, env: {}, resolveLauncher };
      const expected = frozenLaunch.buildSecretSafeCodexLunaLaunchSpecV1(profiles, 'codex-luna', options);
      const builder = vi.spyOn(frozenLaunch, 'buildSecretSafeCodexLunaLaunchSpecV1');
      const actual = buildDurableTargetFromTrustedProfile(profiles, 'codex-luna', options);
      if (adapter === 'generic-cli') {
        // B registration never makes a profile without a captured manifest executable.
        expect(actual).toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
      } else expect(actual).toEqual(expected);
      expect(builder).not.toHaveBeenCalled();
      expect(resolveLauncher).not.toHaveBeenCalled();
    });

  it('preserves rejection of missing, external, overridden, and non-built-in profiles', () => {
    const builtin = builtinWorkerProfiles();
    const original = builtin.profiles.get('codex-luna')!;
    const cases: WorkerProfiles[] = [
      { ...builtin, profiles: new Map() },
      { ...builtin, sourcePath: 'C:\\trusted\\profiles.yaml' },
      { ...builtin, defaultProfile: 'other' },
      { ...builtin, profiles: new Map([...builtin.profiles, ['other', { id: 'other', adapter: 'codex' }]]) },
      ...[
        { model: 'other-model' }, { profile: 'custom' },
        { manifest: 'C:\\trusted\\manifest.yaml' }, { id: 'other' },
      ].map((override) => ({
        ...builtin,
        profiles: new Map([['codex-luna', { ...original, ...override }]]),
      })),
    ];
    const resolveLauncher = vi.fn(() => { throw new Error('must not discover'); });
    const options = { platform: 'win32' as const, env: {}, resolveLauncher };
    for (const profiles of cases) {
      expect(buildDurableTargetFromTrustedProfile(profiles, 'codex-luna', options)).toEqual(
        frozenLaunch.buildSecretSafeCodexLunaLaunchSpecV1(profiles, 'codex-luna', options),
      );
    }
    expect(buildDurableTargetFromTrustedProfile(builtin, 'unknown-profile', options)).toMatchObject({
      ok: false, code: 'LAUNCH_TARGET_UNSUPPORTED',
    });
    expect(resolveLauncher).not.toHaveBeenCalled();
  });

  it('preserves unsupported/invalid build results from the frozen handler', () => {
    const profiles = builtinWorkerProfiles();
    const exe = nativeExe();
    const options = buildOptions(exe);
    for (const launchOptions of [
      { ...options, platform: 'linux' as const },
      { ...options, env: { ENGINEERING_MCP_CODEX_STUB: '1' } },
      { ...options, resolveLauncher: () => { throw new Error('exact resolution failure'); } },
      { ...options, resolveLauncher: () => ({ kind: 'cmd' as const, executable: exe, displayPath: exe }) },
    ]) {
      expect(buildDurableTargetFromTrustedProfile(profiles, 'codex-luna', launchOptions)).toEqual(
        frozenLaunch.buildSecretSafeCodexLunaLaunchSpecV1(profiles, 'codex-luna', launchOptions),
      );
    }
  });

  it('calls the existing verifier and preserves the Codex artifact failure code and message', () => {
    const exe = nativeExe();
    const spec = historicalSpec(exe);
    const options = { platform: 'win32' as const };
    const runtime = getDurableTargetRuntime(spec.schema);
    const verify = vi.spyOn(exactCodex, 'verifyEngineeringLaunchV1Artifact');
    expect(runtime.preclaimVerify(spec, options)).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledExactlyOnceWith(spec, options);
    writeFileSync(exe, 'replaced-artifact', 'utf8');
    const frozen = exactCodex.verifyEngineeringLaunchV1Artifact(spec, options);
    expect(runtime.preclaimVerify(spec, options)).toEqual({ ...frozen, code: 'CODEX_ARTIFACT_MISMATCH' });
    expect(runtime.preclaimVerify(spec, { platform: 'linux' })).toMatchObject({
      ok: false, code: 'CODEX_ARTIFACT_MISMATCH', message: expect.stringContaining('platform mismatch'),
    });
  });

  it('constructs the original exact adapter and exposes no mutable registry or lifecycle capability', () => {
    const spec = historicalSpec(nativeExe());
    const runtime = getDurableTargetRuntime(spec.schema);
    expect(runtime.createExactAdapter(spec, { platform: 'win32' }))
      .toBeInstanceOf(exactCodex.EngineeringCodexLunaV1Adapter);
    expect(runtime.createExactAdapter(spec).id).toBe('engineering-codex-luna-v1');
    expect(Object.keys(runtime).sort()).toEqual(['createExactAdapter', 'parse', 'preclaimVerify', 'schema']);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Reflect.set(runtime, 'schema', 'untrusted/1')).toBe(false);
    expect(getDurableTargetRuntime(spec.schema)).toBe(runtime);
    expect('register' in registry).toBe(false);
  });

  it.each([
    'schema', 'target_schema', 'adapter_id', 'module', 'module_name',
    'executable', 'argv', 'manifest', 'cwd', 'environment', 'launch_spec',
  ])('does not allow C2C delegation commands to inject %s', (key) => {
    expect(createAcceptedDispatchIntentCommandSchema.safeParse(command).success).toBe(true);
    expect(createAcceptedDispatchIntentCommandSchema.safeParse({
      ...command, [key]: 'untrusted-selector',
    }).success).toBe(false);
  });

  it('reopens, projects, replays, and executes a historical durable row without rewriting its JSON or schema', async () => {
    const repo = initGitRepo();
    const opened = openTempStore(repo);
    dirs.push(repo, opened.dir);
    stores.push(opened.store);
    const store = opened.store;
    const git = snapshot(repo);
    const owner = { actor_role: 'OWNER' as const, repo_root: repo };
    const task = createTask(store, git, { type: 'IMPLEMENTATION', payload: implPayload });
    const plan = {
      protocol_version: 'engineering-c2c/1' as const,
      message_id: 'historical-plan', task_id: task.id, sender_role: 'OWNER' as const,
      state: 'PLAN' as const, expected_revision: task.revision, goal: 'historical target replay',
    };
    expect(durableEvaluateC2CMessage(store, plan, owner).decision).toBe('REQUIRES_OWNER_ACTION');
    expect(acceptEvaluatedPlan(store, {
      command_id: command.acceptance_command_id, plan_message: plan,
    }, owner).decision).toBe('ACCEPTED');

    const spec = historicalSpec(nativeExe());
    // Keep independent test processes out of the same durable execution directory.
    const row = { ...historicalRow(spec), dispatch_run_id: 'historical-' + task.id };
    dirs.push(dispatchRunDir(row.dispatch_run_id));
    const rawJson = JSON.stringify(spec, null, 2) + '\n';
    store.transact(() => store.insertDispatchRun({
      id: row.dispatch_run_id, task_id: task.id, worker_role: 'JUNIOR',
      adapter_id: 'codex-exec-luna', worker_profile_id: 'codex-luna',
      runner_instance_id: null, pid: null, status: 'launching', started_at: null,
      finished_at: null, exit_code: null, error_code: null, error_detail: null,
      created_at: row.created_at, updated_at: row.created_at,
    }));

    // Seed pre-Bridge-A bytes directly in this temporary test database. Neither
    // new builder nor receipt serializer participates in the historical fixture.
    const db = new DatabaseSync(store.path);
    try {
      db.prepare(`INSERT INTO c2c_delegation_receipts
        (command_id, acceptance_command_id, dispatch_run_id, launch_spec_json, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(
        row.command_id, row.acceptance_command_id, row.dispatch_run_id, rawJson, row.created_at,
      );
      const storageBefore = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all();
      const savedJson = () => (db.prepare(
        'SELECT launch_spec_json FROM c2c_delegation_receipts WHERE command_id = ?',
      ).get(command.command_id) as { launch_spec_json: string }).launch_spec_json;
      expect(SCHEMA_VERSION).toBe(12);
      expect(WRITER_PROTOCOL_GENERATION).toBe(4);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });

      const reopened = Store.open(store.path, { repoRoot: repo });
      stores.push(reopened);
      const expected = {
        ...historicalProjection(spec), task_id: task.id, accepted_revision: task.revision,
        dispatch_run_id: row.dispatch_run_id,
      };
      expect(reopened.getC2CDelegationIntentReceipt(command.command_id)).toEqual(expected);
      expect(reopened.getC2CDelegationIntentForDispatch(row.dispatch_run_id)).toEqual(expected);
      expect(reopened.getC2CDelegationIntentForAcceptance(command.acceptance_command_id)).toEqual(expected);

      const build = vi.spyOn(registry, 'buildDurableTargetFromTrustedProfile');
      const discover = vi.fn(() => { throw new Error('replay must not rediscover'); });
      expect(createAcceptedDispatchIntent(reopened, command, owner, {
        defaultProfile: 'changed', sourcePath: 'C:\\changed\\profiles.yaml', profiles: new Map(),
      }, { launchSpecBuildOptions: { platform: 'linux', env: {}, resolveLauncher: discover } }))
        .toEqual({ decision: 'NOOP_WITH_EXISTING_DELEGATION', receipt: expected });
      expect(build).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(savedJson()).toBe(rawJson);

      const selectRuntime = vi.spyOn(registry, 'getDurableTargetRuntime');
      const spawnProcess = vi.fn((executable: string, args: string[], options: {
        cwd: string; shell: false; windowsHide: true;
      }): ChildProcessWithoutNullStreams => {
        expect(executable).toBe(spec.launcher.executable_path);
        expect(options).toEqual({ cwd: repo, shell: false, windowsHide: true });
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242,
        }) as unknown as ChildProcessWithoutNullStreams;
        writeFileSync(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify({
          outcome: 'completed', summary: 'historical target executed', implementation_complete: true,
          changed_files: [], validation: [], known_limitations: [], exit_code: 0,
        }), 'utf8');
        setTimeout(() => child.emit('close', 0, null), 10);
        return child;
      });
      const terminal = await runC2CWorkerRunner({
        store: reopened, git, dispatchRunId: row.dispatch_run_id,
        executionInstanceId: 'historical-exact-runner',
        adapterOptions: { platform: 'win32', spawnProcess },
      });
      expect(selectRuntime).toHaveBeenCalledExactlyOnceWith('engineering-launch/1');
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(terminal).toMatchObject({ status: 'COMPLETED', execution_instance_id: null });
      expect(reopened.getDispatchRun(row.dispatch_run_id)).toMatchObject({
        status: 'completed', runner_instance_id: 'historical-exact-runner',
      });
      expect(savedJson()).toBe(rawJson);
      expect(db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all())
        .toEqual(storageBefore);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
    } finally {
      db.close();
    }
  });
});
