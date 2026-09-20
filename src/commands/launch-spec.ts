import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import {
  resolveCodexLauncher,
  type CodexLaunch,
} from '../adapters/codex-launcher.ts';
import type { WorkerProfiles } from '../worker-profiles.ts';

export const ENGINEERING_LAUNCH_SCHEMA_V1 = 'engineering-launch/1' as const;
export const CODEX_LUNA_PROFILE_ID = 'codex-luna' as const;
export const CODEX_LUNA_ADAPTER_ID = 'codex-exec-luna' as const;
export const CODEX_LUNA_MODEL = 'gpt-5.6-luna' as const;
export const CODEX_LUNA_PROMPT_CONTRACT_V1 =
  'engineering-codex-luna-prompt/1' as const;
export const CODEX_LUNA_RESULT_CONTRACT_V1 =
  'engineering-codex-luna-last-message/1' as const;

export const codexLunaArgvTemplateV1 = [
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
] as const;

export const secretSafeLaunchSpecV1Schema = z
  .object({
    schema: z.literal(ENGINEERING_LAUNCH_SCHEMA_V1),
    platform: z.literal('win32'),
    launcher: z
      .object({
        kind: z.literal('native'),
        executable_path: z.string().min(1),
        executable_sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    argv_template: z.tuple([
      z.literal('exec'),
      z.literal('--model'),
      z.literal(CODEX_LUNA_MODEL),
      z.literal('-C'),
      z.literal('${task_repo_root}'),
      z.literal('-s'),
      z.literal('workspace-write'),
      z.literal('--json'),
      z.literal('--ephemeral'),
      z.literal('--output-last-message'),
      z.literal('${dispatch_run_dir}/last-message.txt'),
      z.literal('-'),
    ]),
    working_directory_policy: z.literal('task_repo_root'),
    prompt_contract: z.literal(CODEX_LUNA_PROMPT_CONTRACT_V1),
    prompt_transport: z.literal('stdin'),
    result_contract: z.literal(CODEX_LUNA_RESULT_CONTRACT_V1),
    credential_policy: z.literal('inherit-trusted-runtime-environment'),
  })
  .strict();

export type SecretSafeLaunchSpecV1 = z.infer<
  typeof secretSafeLaunchSpecV1Schema
>;

export type LaunchSpecBuildResult =
  | { ok: true; spec: SecretSafeLaunchSpecV1 }
  | {
      ok: false;
      code:
        | 'LAUNCH_TARGET_UNSUPPORTED'
        | 'LAUNCH_TARGET_INVALID';
      message: string;
    };

export type LaunchSpecBuildOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveLauncher?: () => CodexLaunch;
};

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function realBuiltinCodexLunaProfile(
  profiles: WorkerProfiles,
  workerProfileId: string,
): boolean {
  if (profiles.sourcePath !== null) return false;
  if (workerProfileId !== CODEX_LUNA_PROFILE_ID) return false;
  if (profiles.defaultProfile !== CODEX_LUNA_PROFILE_ID) return false;
  if (profiles.profiles.size !== 1) return false;

  const profile = profiles.profiles.get(CODEX_LUNA_PROFILE_ID);
  return Boolean(
    profile &&
      profile.id === CODEX_LUNA_PROFILE_ID &&
      profile.adapter === CODEX_LUNA_ADAPTER_ID &&
      profile.manifest === undefined &&
      profile.model === undefined &&
      profile.profile === undefined,
  );
}

/**
 * Build the non-secret process target for a first S3B2A attempt.
 *
 * This deliberately performs mutable launcher discovery, canonicalization, and
 * artifact hashing before any SQLite write transaction. The resulting object
 * becomes authoritative only after it is committed with a dispatch + delegation
 * receipt. Exact replay must use the durable stored spec and never call this
 * builder again.
 *
 * The prompt contract label identifies the required future versioned renderer;
 * the label alone does not freeze an implementation. S3B2B must dispatch to
 * the immutable V1 renderer rather than whichever generic taskPrompt happens
 * to be current at that time.
 */
export function buildSecretSafeCodexLunaLaunchSpecV1(
  profiles: WorkerProfiles,
  workerProfileId: string,
  options: LaunchSpecBuildOptions = {},
): LaunchSpecBuildResult {
  if (!realBuiltinCodexLunaProfile(profiles, workerProfileId)) {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
      message:
        'S3B2A V1 supports only the real built-in codex-luna profile',
    };
  }

  const env = options.env ?? process.env;
  if (env.ENGINEERING_MCP_CODEX_STUB === '1') {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
      message: 'Codex stub mode is not a durable production launch target',
    };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
      message:
        'S3B2A V1 requires an exact native Windows Codex executable; unresolved non-Windows codex launch is deferred',
    };
  }

  let launch: CodexLaunch;
  try {
    launch =
      options.resolveLauncher?.() ??
      resolveCodexLauncher({ platform, env });
  } catch (error) {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_INVALID',
      message:
        error instanceof Error
          ? error.message
          : 'Codex launcher resolution failed',
    };
  }

  if (launch.kind !== 'native') {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
      message:
        'S3B2A V1 supports only a native Codex executable; cmd/script wrappers are deferred',
    };
  }

  let canonical: string;
  try {
    canonical = realpathSync(launch.executable);
  } catch (error) {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_INVALID',
      message: `Could not canonicalize Codex executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!isAbsolute(canonical) || !/\.exe$/i.test(canonical)) {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
      message:
        'S3B2A V1 requires a canonical absolute native .exe Codex executable',
    };
  }

  try {
    if (!statSync(canonical).isFile()) {
      return {
        ok: false,
        code: 'LAUNCH_TARGET_INVALID',
        message: 'Resolved Codex executable is not a regular file',
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_INVALID',
      message: `Could not stat Codex executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let digest: string;
  try {
    digest = sha256File(canonical);
  } catch (error) {
    return {
      ok: false,
      code: 'LAUNCH_TARGET_INVALID',
      message: `Could not hash Codex executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    ok: true,
    spec: secretSafeLaunchSpecV1Schema.parse({
      schema: ENGINEERING_LAUNCH_SCHEMA_V1,
      platform: 'win32',
      launcher: {
        kind: 'native',
        executable_path: canonical,
        executable_sha256: digest,
      },
      argv_template: [...codexLunaArgvTemplateV1],
      working_directory_policy: 'task_repo_root',
      prompt_contract: CODEX_LUNA_PROMPT_CONTRACT_V1,
      prompt_transport: 'stdin',
      result_contract: CODEX_LUNA_RESULT_CONTRACT_V1,
      credential_policy: 'inherit-trusted-runtime-environment',
    }),
  };
}
