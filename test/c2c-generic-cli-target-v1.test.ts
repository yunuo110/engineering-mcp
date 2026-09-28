import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineeringGenericCliV1Adapter } from '../src/adapters/engineering-generic-cli-v1-adapter.ts';
import { validateManifest } from '../src/adapters/manifest.ts';
import { buildDurableTargetFromTrustedProfile, durableTargetSpecSchema, getDurableTargetRuntime } from '../src/c2c/durable-target-registry.ts';
import { createAcceptedDispatchIntentCommandSchema } from '../src/commands/delegation-schema.ts';
import { buildGenericCliTargetV1, genericCliTargetV1Schema, verifyGenericCliTargetV1, GENERIC_CLI_ARGV_V1 } from '../src/commands/generic-cli-target-v1.ts';
import { parseEngineeringGenericCliResultV1, renderEngineeringGenericCliEwpNativeV1 } from '../src/commands/generic-cli-ewp-native-v1.ts';
import type { TaskContract } from '../src/types.ts';
import type { WorkerProfiles, WorkerProfileEntry } from '../src/worker-profiles.ts';
import { implPayload, removeDir, tempDir } from './helpers.ts';
import { genericManifest } from './fixtures/c2c-generic-support.ts';
import { materializeNativeGenericHarness, NATIVE_GENERIC_SHA256 } from './fixtures/generic-native-harness.ts';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) removeDir(dir); });
function exe() { const dir = tempDir('eng-mcp-b-target-'); dirs.push(dir); return materializeNativeGenericHarness(dir); }
function profiles(manifest: unknown, override: Partial<WorkerProfileEntry> = {}): WorkerProfiles {
  return {
    sourcePath: 'C:\\trusted\\profiles.yaml', defaultProfile: 'generic',
    profiles: new Map([['generic', { id: 'generic', adapter: 'generic-cli', manifest: 'C:\\never-reread.yaml', manifestSnapshot: JSON.stringify(manifest), ...override }]]),
  };
}
function target() {
  const path = exe();
  const result = buildGenericCliTargetV1(profiles(genericManifest(path)), 'generic');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return { path, spec: result.spec };
}
const terminal = {
  protocol: 'engineering-worker/1', outcome: 'completed', summary: 'reported completion {not another object}',
  implementation_complete: true, changed_files: [],
  validation: [{ command: 'npm test', status: 'passed', summary: 'reported', counts: { passed: 2, total: 2 } }],
  known_limitations: [], exit_code: 0,
};

describe('Harness Bridge B strict GenericCli durable target V1', () => {
  it('builds only the compiled GenericCli target and preserves canonical native artifact identity', () => {
    const path = exe();
    const built = buildDurableTargetFromTrustedProfile(profiles(genericManifest(path)), 'generic');
    expect(built).toMatchObject({ ok: true, adapterId: 'generic-cli', spec: {
      schema: 'engineering-generic-cli-target/1', platform: 'win32',
      launcher: { kind: 'native-exe', executable_path: realpathSync.native(path), executable_sha256: NATIVE_GENERIC_SHA256 },
      argv_template: [...GENERIC_CLI_ARGV_V1], success_exit_codes: [0],
      credential_policy: 'harness-owned-runtime-credentials',
    } });
    if (!built.ok) throw new Error('build failed');
    expect(durableTargetSpecSchema.parse(built.spec)).toEqual(built.spec);
    const runtime = getDurableTargetRuntime(built.spec.schema);
    expect(runtime.parse(built.spec)).toEqual(built.spec);
    expect(runtime.preclaimVerify(built.spec)).toEqual({ ok: true });
    expect(runtime.createExactAdapter(built.spec)).toBeInstanceOf(EngineeringGenericCliV1Adapter);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.keys(runtime).sort()).toEqual(['createExactAdapter', 'parse', 'preclaimVerify', 'schema']);
  });

  it('supports empty argv and durably freezes explicit integer success codes', () => {
    const m = { ...genericManifest(exe()), arguments: [], process: { shell: false, success_exit_codes: [0, 7] } };
    const result = buildGenericCliTargetV1(profiles(m), 'generic');
    expect(result).toMatchObject({ ok: true, spec: { argv_template: [], success_exit_codes: [0, 7] } });
    m.process.success_exit_codes.push(8);
    expect(result).toMatchObject({ spec: { success_exit_codes: [0, 7] } });
  });

  type Manifest = ReturnType<typeof genericManifest>;
  const invalid: Array<[string, (m: Manifest) => unknown]> = [
    ['literal argv', (m) => ({ ...m, arguments: ['--token=literal-secret'] })],
    ['embedded placeholder', (m) => ({ ...m, arguments: ['--repo=${repo_root}'] })],
    ['model placeholder', (m) => ({ ...m, arguments: ['${model}'] })],
    ['profile placeholder', (m) => ({ ...m, arguments: ['${profile}'] })],
    ['literal cwd', (m) => ({ ...m, working_directory: 'C:\\arbitrary' })],
    ['relative cwd', (m) => ({ ...m, working_directory: '.' })],
    ['shell', (m) => ({ ...m, process: { ...m.process, shell: true } })],
    ['implicit success codes', (m) => ({ ...m, process: { shell: false } })],
    ['fractional success code', (m) => ({ ...m, process: { shell: false, success_exit_codes: [0.5] } })],
    ['prompt file', (m) => ({ ...m, prompt: { ...m.prompt, transport: 'file', argument: '--file' } })],
    ['unused prompt argument', (m) => ({ ...m, prompt: { ...m.prompt, argument: 'secret' } })],
    ['wrapper', (m) => ({ ...m, protocol_mode: 'prompt-wrapper' })],
    ['JSONL', (m) => ({ ...m, result: { source: 'stdout', format: 'jsonl', final_event: { field: 'type', equals: 'result' } } })],
    ['result file', (m) => ({ ...m, result: { ...m.result, source: 'file', path: 'result.json' } })],
    ['unused result path', (m) => ({ ...m, result: { ...m.result, path: 'secret' } })],
    ['unused final event', (m) => ({ ...m, result: { ...m.result, final_event: { field: 'x', equals: 'secret' } } })],
    ['cmd', (m) => ({ ...m, command: 'C:\\test.cmd' })],
    ['bat', (m) => ({ ...m, command: 'test.bat' })],
    ['PowerShell', (m) => ({ ...m, command: 'test.ps1' })],
    ['Node script', (m) => ({ ...m, command: 'test.js' })],
    ['Python script', (m) => ({ ...m, command: 'test.py' })],
    ['relative path', (m) => ({ ...m, command: '.\\test.exe' })],
    ['command line', (m) => ({ ...m, command: 'test.exe --credential=secret' })],
    ['environment', (m) => ({ ...m, environment: { SECRET: 'private' } })],
    ['secret_ref', (m) => ({ ...m, secret_ref: 'private' })],
  ];
  it.each(invalid)('rejects unsupported manifest shape: %s without echoing secret data', (_label, transform) => {
    const p = profiles(transform(genericManifest(exe())));
    const result = buildGenericCliTargetV1(p, 'generic');
    expect(result).toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
    expect(JSON.stringify(result)).not.toContain('literal-secret');
  });

  it.each([{ profile: 'opaque-profile' }, { model: 'opaque-model' }, { manifestSnapshot: undefined }, { manifestSnapshot: '{broken' }, { id: 'wrong' }])
    ('rejects missing/invalid captured state and opaque profile overrides %j', (override) => {
      expect(buildGenericCliTargetV1(profiles(genericManifest(exe()), override), 'generic'))
        .toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
    });

  it('excludes metadata/capabilities, profile descriptions and the entire environment by structural projection', () => {
    const m = genericManifest(exe());
    const result = buildGenericCliTargetV1(profiles(m, { description: 'private-description' }), 'generic', {
      env: { OPENAI_FAKE_SECRET: 'private-openai', GROK_FAKE_SECRET: 'private-grok', DEEPSEEK_FAKE_SECRET: 'private-deepseek', OTHER: 'private-entire-environment' },
    });
    expect(result.ok).toBe(true);
    const json = JSON.stringify(result);
    for (const value of ['metadata-private-sentinel', 'capabilities-private-sentinel', 'private-description', 'private-openai', 'private-grok', 'private-deepseek', 'private-entire-environment', 'OPENAI_FAKE_SECRET', 'GROK_FAKE_SECRET', 'DEEPSEEK_FAKE_SECRET', 'never-reread.yaml']) expect(json).not.toContain(value);
    if (!result.ok) throw new Error('build failed');
    expect(Object.keys(result.spec).sort()).toEqual(['schema', 'platform', 'launcher', 'argv_template', 'working_directory_policy', 'prompt_contract', 'prompt_transport', 'result_contract', 'success_exit_codes', 'credential_policy'].sort());
  });

  it('resolves a bare command exactly once and performs no discovery during verification', () => {
    const path = exe();
    const resolveExecutable = vi.fn(() => path);
    const result = buildGenericCliTargetV1(profiles({ ...genericManifest(path), command: 'trusted-harness' }), 'generic', { resolveExecutable, env: { PATH: 'first' } });
    expect(resolveExecutable).toHaveBeenCalledExactlyOnceWith('trusted-harness', { PATH: 'first' });
    if (!result.ok) throw new Error('build failed');
    expect(result.spec.launcher.executable_sha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
    resolveExecutable.mockImplementation(() => { throw new Error('no rediscovery'); });
    expect(verifyGenericCliTargetV1(result.spec)).toEqual({ ok: true });
    expect(resolveExecutable).toHaveBeenCalledTimes(1);
  });

  it('uses real Windows build-time discovery once for a bare native command', () => {
    const path = exe();
    const separator = path.lastIndexOf('\\');
    const env = { ...process.env, PATH: path.slice(0, separator) + ';' + (process.env.PATH ?? '') };
    const result = buildGenericCliTargetV1(profiles({ ...genericManifest(path), command: 'generic-native' }), 'generic', { env });
    expect(result).toMatchObject({ ok: true, spec: { launcher: { executable_path: realpathSync.native(path), executable_sha256: NATIVE_GENERIC_SHA256 } } });
    const direct = buildGenericCliTargetV1(profiles(genericManifest(path)), 'generic');
    expect(result).toEqual(direct);
    if (!result.ok) throw new Error('native discovery failed');
    expect(verifyGenericCliTargetV1(result.spec)).toEqual({ ok: true });
  });

  it('does not turn unavailable executables or unsupported platforms into executable targets', () => {
    const path = exe();
    expect(buildGenericCliTargetV1(profiles(genericManifest(path)), 'generic', { platform: 'linux' }))
      .toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
    rmSync(path);
    expect(buildGenericCliTargetV1(profiles(genericManifest(path)), 'generic'))
      .toMatchObject({ ok: false, code: 'LAUNCH_TARGET_INVALID' });
  });

  it.each(['engineering-generic-cli-target/2', '__proto__', 'constructor', './evil.ts'])('rejects unregistered schema %s', (schema) => {
    const { spec } = target();
    expect(durableTargetSpecSchema.safeParse({ ...spec, schema }).success).toBe(false);
    expect(() => getDurableTargetRuntime(schema)).toThrow();
  });

  it('rejects extra fields and altered frozen contracts in the persisted target', () => {
    const { spec } = target();
    for (const raw of [
      { ...spec, environment: {} }, { ...spec, worker_profile_id: 'generic' },
      { ...spec, launcher: { ...spec.launcher, shell: true } },
      { ...spec, launcher: { ...spec.launcher, executable_path: 'relative.exe' } },
      { ...spec, launcher: { ...spec.launcher, executable_sha256: 'ABC' } },
      { ...spec, argv_template: ['--token=secret'] },
      { ...spec, prompt_contract: 'mutable/2' }, { ...spec, result_contract: 'mutable/2' },
      { ...spec, credential_policy: 'secret_ref' }, { ...spec, platform: 'linux' },
    ]) expect(genericCliTargetV1Schema.safeParse(raw).success).toBe(false);
  });

  it('rejects changed, missing, noncanonical and wrong-platform artifacts without fallback', () => {
    const { path, spec } = target();
    expect(verifyGenericCliTargetV1(spec, { platform: 'linux' }).ok).toBe(false);
    expect(verifyGenericCliTargetV1({ ...spec, launcher: { ...spec.launcher, executable_path: join(path, '..', '.', 'generic-native.exe').replace('generic-native.exe', '.\\generic-native.exe') } }).ok).toBe(false);
    writeFileSync(path, 'changed');
    expect(verifyGenericCliTargetV1(spec)).toMatchObject({ ok: false, code: 'WORKER_PROCESS_FAILED', message: expect.stringContaining('SHA-256') });
    rmSync(path);
    expect(verifyGenericCliTargetV1(spec)).toMatchObject({ ok: false, message: expect.stringContaining('unavailable') });
  });

  it('keeps ordinary manifests legal even when literal arguments are not durable V1-compatible', () => {
    const m = { ...genericManifest(exe()), arguments: ['--ordinary-flag'] };
    expect(validateManifest(m).ok).toBe(true);
    expect(buildGenericCliTargetV1(profiles(m), 'generic')).toMatchObject({ ok: false, code: 'DURABLE_TARGET_UNSUPPORTED' });
  });

  it.each(['module', 'target_schema', 'schema', 'adapter_id', 'executable', 'argv', 'manifest', 'cwd', 'environment', 'credential', 'endpoint', 'profile', 'model'])
    ('keeps %s outside C2C wire authority', (key) => {
      expect(createAcceptedDispatchIntentCommandSchema.safeParse({ command_id: 'c', acceptance_command_id: 'a', worker_profile_id: 'generic', [key]: 'untrusted' }).success).toBe(false);
    });

  it('freezes exact EWP V1 JSON bytes, property order and exclusion of lifecycle/provider identities', () => {
    const task = { id: 'task-1', type: 'IMPLEMENTATION', repo_root: 'C:\\repo', base_commit: 'abc', execution_instance_id: 'private-runner', payload: implPayload } as TaskContract;
    const rendered = renderEngineeringGenericCliEwpNativeV1({ task, taskId: task.id, dispatchRunId: 'dispatch-1', repositoryRoot: task.repo_root, baseCommit: 'abc' });
    expect(rendered).toBe('{"protocol":"engineering-worker/1","request_id":"dispatch-1","task":{"id":"task-1","type":"IMPLEMENTATION","goal":"Add the ledger store","allowed_scope":["src/store.ts"],"forbidden_scope":["AGENTS.md"],"acceptance_criteria":["store tests pass"],"validation_requirements":["npm test"],"context_files":["src/store.ts"],"knowledge_refs":["AGENTS.md"]},"repository":{"root":"C:\\\\repo","base_commit":"abc"},"worker":{"role":"JUNIOR"}}');
    for (const word of ['private-runner', 'execution_instance_id', 'profile', 'model', 'credential', 'adapter', 'pid']) expect(rendered).not.toContain(word);
  });

  it('parses final multiline JSON and preserves reported S2 evidence without importing ordinary helpers', () => {
    const parsed = parseEngineeringGenericCliResultV1('progress\n{"progress":1}\n' + JSON.stringify(terminal, null, 2) + '\n');
    expect(parsed).toMatchObject({ outcome: 'completed', validation: [{ check: 'npm test', command: 'npm test', summary: 'reported', counts: { passed: 2, total: 2 } }] });
    expect(parsed).not.toHaveProperty('runner_error_code');
  });

  it.each([
    JSON.stringify({ ...terminal, request_id: 'echo' }), JSON.stringify({ ...terminal, runner_error_code: 'CODEX_PROCESS_FAILED' }),
    JSON.stringify(terminal) + '\n{"broken":', JSON.stringify(terminal) + '\n{"outcome":"completed"}',
    JSON.stringify([terminal]), JSON.stringify(terminal) + '\nnot-terminal',
    JSON.stringify({ ...terminal, validation: [{ command: 'x', status: 'passed', verified: true }] }),
  ])('rejects malformed, echoed, extra-authority or nonterminal output %s', (output) => {
    expect(parseEngineeringGenericCliResultV1(output)).toBeUndefined();
  });
});
