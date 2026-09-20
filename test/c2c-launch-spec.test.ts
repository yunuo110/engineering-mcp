import { createHash } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexLauncher } from '../src/adapters/codex-launcher.ts';
import {
  buildSecretSafeCodexLunaLaunchSpecV1,
  CODEX_LUNA_ADAPTER_ID,
  CODEX_LUNA_MODEL,
  CODEX_LUNA_PROFILE_ID,
  secretSafeLaunchSpecV1Schema,
} from '../src/commands/launch-spec.ts';
import {
  builtinWorkerProfiles,
  type WorkerProfiles,
} from '../src/worker-profiles.ts';
import { removeDir, tempDir } from './helpers.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function nativeExe(content = 'native-codex'): string {
  const dir = tempDir('eng-mcp-native-codex-');
  dirs.push(dir);
  const path = join(dir, 'codex.exe');
  writeFileSync(path, content, 'utf8');
  return path;
}

function externalProfiles(): WorkerProfiles {
  return {
    defaultProfile: CODEX_LUNA_PROFILE_ID,
    sourcePath: 'C:\\trusted\\profiles.yaml',
    profiles: new Map([
      [
        CODEX_LUNA_PROFILE_ID,
        {
          id: CODEX_LUNA_PROFILE_ID,
          adapter: CODEX_LUNA_ADAPTER_ID,
        },
      ],
    ]),
  };
}

describe('S3B2A SecretSafeLaunchSpecV1', () => {
  it('freezes an exact built-in native Codex executable artifact and invocation contract', () => {
    const exe = nativeExe('codex-binary-v1');
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const canonical = realpathSync(exe);
    const digest = createHash('sha256')
      .update('codex-binary-v1')
      .digest('hex');

    expect(result.spec).toEqual({
      schema: 'engineering-launch/1',
      platform: 'win32',
      launcher: {
        kind: 'native',
        executable_path: canonical,
        executable_sha256: digest,
      },
      argv_template: [
        'exec',
        '--model',
        CODEX_LUNA_MODEL,
        '-C',
        '${task_repo_root}',
        '-s',
        'workspace-write',
        '--json',
        '--ephemeral',
        '--output-last-message',
        '${dispatch_run_dir}/last-message.txt',
        '-',
      ],
      working_directory_policy: 'task_repo_root',
      prompt_contract: 'engineering-codex-luna-prompt/1',
      prompt_transport: 'stdin',
      result_contract: 'engineering-codex-luna-last-message/1',
      credential_policy: 'inherit-trusted-runtime-environment',
    });
  });

  it('does not snapshot secret-bearing environment values', () => {
    const exe = nativeExe();
    const secret = 'sentinel-do-not-persist-123';
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: {
          OPENAI_FAKE_SECRET: secret,
          CODEX_FAKE_SECRET: secret,
          HOME: 'C:\\mutable-home',
          USERPROFILE: 'C:\\mutable-user',
          PATH: 'C:\\mutable-path',
        },
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.spec);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('OPENAI_FAKE_SECRET');
    expect(serialized).not.toContain('CODEX_FAKE_SECRET');
    expect(serialized).not.toContain('mutable-home');
    expect(serialized).not.toContain('mutable-user');
    expect(serialized).not.toContain('mutable-path');
  });

  it('accepts ENGINEERING_MCP_CODEX_LAUNCHER only after it resolves to an exact native exe', () => {
    const exe = nativeExe();
    const resolved = resolveCodexLauncher({
      platform: 'win32',
      env: { ENGINEERING_MCP_CODEX_LAUNCHER: exe },
      where: () => [],
    });
    expect(resolved.kind).toBe('native');

    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: { ENGINEERING_MCP_CODEX_LAUNCHER: exe },
        resolveLauncher: () => resolved,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.launcher.executable_path).toBe(realpathSync(exe));
    }
  });

  it('defers cmd/script wrappers even when they are exact files', () => {
    const dir = tempDir('eng-mcp-cmd-wrapper-');
    dirs.push(dir);
    const wrapper = join(dir, 'codex.cmd');
    writeFileSync(wrapper, '@echo off', 'utf8');

    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'cmd',
          executable: wrapper,
          displayPath: wrapper,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
    });
  });

  it('defers unresolved non-Windows bare codex launch', () => {
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'linux',
        env: {},
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
    });
  });

  it('rejects external/custom profiles even when they reuse the built-in name and adapter', () => {
    const exe = nativeExe();
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      externalProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
    });
  });

  it('rejects generic/custom requested profiles in V1', () => {
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      'generic-cli',
      {
        platform: 'win32',
        env: {},
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
    });
  });

  it('rejects stub mode as a durable production launch target', () => {
    const exe = nativeExe();
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: { ENGINEERING_MCP_CODEX_STUB: '1' },
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
    });
  });

  it('requires a canonical native .exe artifact and a strict schema', () => {
    const dir = tempDir('eng-mcp-native-not-exe-');
    dirs.push(dir);
    const path = join(dir, 'codex-native');
    writeFileSync(path, 'native', 'utf8');
    const result = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'native',
          executable: path,
          displayPath: path,
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
    });

    const exe = nativeExe();
    const valid = buildSecretSafeCodexLunaLaunchSpecV1(
      builtinWorkerProfiles(),
      CODEX_LUNA_PROFILE_ID,
      {
        platform: 'win32',
        env: {},
        resolveLauncher: () => ({
          kind: 'native',
          executable: exe,
          displayPath: exe,
        }),
      },
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(
      secretSafeLaunchSpecV1Schema.safeParse({
        ...valid.spec,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
