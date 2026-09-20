import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { z } from 'zod/v4';
import YAML from 'yaml';
import { cliAdapterManifestSchema, validateManifest } from '../adapters/manifest.ts';
import type { WorkerProfiles } from '../worker-profiles.ts';

export const GENERIC_CLI_TARGET_V1 = 'engineering-generic-cli-target/1' as const;
export const GENERIC_CLI_PROMPT_V1 = 'engineering-generic-cli-ewp-native/1' as const;
export const GENERIC_CLI_RESULT_V1 = 'engineering-generic-cli-ewp-stdout-json-last-object/1' as const;
export const GENERIC_CLI_ARGV_V1 = [
  '${repo_root}', '${run_dir}', '${task_id}', '${dispatch_run_id}',
] as const;

export const genericCliTargetV1Schema = z.object({
  schema: z.literal(GENERIC_CLI_TARGET_V1),
  platform: z.literal('win32'),
  launcher: z.object({
    kind: z.literal('native-exe'),
    executable_path: z.string().min(1).refine(
      (path) => win32.isAbsolute(path) && /\.exe$/i.test(path) && !path.includes('\0'),
      'An absolute native .exe path is required',
    ),
    executable_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  argv_template: z.array(z.enum(GENERIC_CLI_ARGV_V1)),
  working_directory_policy: z.literal('task_repo_root'),
  prompt_contract: z.literal(GENERIC_CLI_PROMPT_V1),
  prompt_transport: z.literal('stdin'),
  result_contract: z.literal(GENERIC_CLI_RESULT_V1),
  success_exit_codes: z.array(z.number().int()),
  credential_policy: z.literal('harness-owned-runtime-credentials'),
}).strict();

export type GenericCliTargetV1 = z.infer<typeof genericCliTargetV1Schema>;
export type GenericCliTargetBuildOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  // Trusted build-time test seam, never a wire field or a durable selector.
  resolveExecutable?: (command: string, env: NodeJS.ProcessEnv) => string;
};
export type GenericCliTargetBuildResult =
  | { ok: true; spec: GenericCliTargetV1 }
  | { ok: false; code: 'DURABLE_TARGET_UNSUPPORTED' | 'LAUNCH_TARGET_INVALID'; message: string };

function unsupported(): GenericCliTargetBuildResult {
  // Do not echo a manifest, argument, profile override, or parser exception.
  return {
    ok: false,
    code: 'DURABLE_TARGET_UNSUPPORTED',
    message: 'GenericCli durable V1 requires a captured native/stdin/stdout-JSON manifest with only approved runtime placeholders and no profile/model overrides',
  };
}

function resolveNativeCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (win32.isAbsolute(command)) return command;
  // Relative paths, shell syntax, wildcards, extensions other than .exe and
  // command-line fragments are not discovery inputs in this target version.
  if (!/^[A-Za-z0-9_-]+(?:\.exe)?$/i.test(command)) {
    throw new Error('unsupported discovery input');
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows';
  const lines = execFileSync(win32.join(systemRoot, 'System32', 'where.exe'), [command], {
    env, encoding: 'utf8', windowsHide: true, shell: false,
  }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Freeze the first discovered native .exe once; no discovery at runtime.
  const selected = lines.find((path) => win32.isAbsolute(path) && /\.exe$/i.test(path));
  if (!selected) throw new Error('no native target');
  return selected;
}

export function buildGenericCliTargetV1(
  profiles: WorkerProfiles,
  workerProfileId: string,
  options: GenericCliTargetBuildOptions = {},
): GenericCliTargetBuildResult {
  const profile = profiles.profiles.get(workerProfileId);
  if (
    !profile || profile.id !== workerProfileId || profile.adapter !== 'generic-cli' ||
    profile.profile !== undefined || profile.model !== undefined ||
    typeof profile.manifestSnapshot !== 'string' || profile.manifestSnapshot.length === 0 ||
    (options.platform ?? process.platform) !== 'win32'
  ) return unsupported();

  let raw: unknown;
  try { raw = YAML.parse(profile.manifestSnapshot); }
  catch { return unsupported(); }
  const parsed = cliAdapterManifestSchema.safeParse(raw);
  if (!parsed.success || !validateManifest(raw).ok) return unsupported();
  const manifest = parsed.data;
  if (
    manifest.adapter !== 'generic-cli' || manifest.process.shell !== false ||
    manifest.working_directory !== '${repo_root}' ||
    manifest.protocol_mode !== 'native' ||
    manifest.prompt.transport !== 'stdin' || manifest.prompt.argument !== undefined ||
    manifest.result.source !== 'stdout' || manifest.result.format !== 'json' ||
    manifest.result.strategy !== 'last-json-object' ||
    manifest.result.path !== undefined || manifest.result.final_event !== undefined ||
    !manifest.arguments.every((arg) => (GENERIC_CLI_ARGV_V1 as readonly string[]).includes(arg))
  ) return unsupported();

  const command = manifest.command;
  if (
    command.includes('\0') ||
    (win32.isAbsolute(command) ? !/\.exe$/i.test(command) : !/^[A-Za-z0-9_-]+(?:\.exe)?$/i.test(command))
  ) return unsupported();

  try {
    const env = options.env ?? process.env;
    const resolved = win32.isAbsolute(command)
      ? command
      : (options.resolveExecutable ?? resolveNativeCommand)(command, env);
    if (!win32.isAbsolute(resolved) || !/\.exe$/i.test(resolved)) return unsupported();
    // Native Windows canonicalization expands 8.3 aliases consistently with
    // build-time executable discovery; legacy realpath may retain short names.
    const canonical = realpathSync.native(resolved);
    if (!statSync(canonical).isFile()) throw new Error('not a regular file');
    const digest = createHash('sha256').update(readFileSync(canonical)).digest('hex');
    // Explicit allowlist projection, not a manifest spread or a secret detector.
    // Metadata, capabilities, environment, names and overrides cannot enter it.
    return { ok: true, spec: genericCliTargetV1Schema.parse({
      schema: GENERIC_CLI_TARGET_V1,
      platform: 'win32',
      launcher: { kind: 'native-exe', executable_path: canonical, executable_sha256: digest },
      argv_template: [...manifest.arguments],
      working_directory_policy: 'task_repo_root',
      prompt_contract: GENERIC_CLI_PROMPT_V1,
      prompt_transport: 'stdin',
      result_contract: GENERIC_CLI_RESULT_V1,
      success_exit_codes: [...manifest.process.success_exit_codes],
      credential_policy: 'harness-owned-runtime-credentials',
    }) };
  } catch {
    return { ok: false, code: 'LAUNCH_TARGET_INVALID', message: 'GenericCli native executable could not be resolved, canonicalized, or hashed' };
  }
}
export function verifyGenericCliTargetV1(
  raw: unknown,
  options: { platform?: NodeJS.Platform } = {},
): { ok: true } | { ok: false; code: 'WORKER_PROCESS_FAILED'; message: string } {
  const fail = (message: string) => ({ ok: false as const, code: 'WORKER_PROCESS_FAILED' as const, message });
  const parsed = genericCliTargetV1Schema.safeParse(raw);
  if (!parsed.success) return fail('Invalid GenericCli durable V1 target');
  const spec = parsed.data;
  if ((options.platform ?? process.platform) !== spec.platform) return fail('GenericCli target platform mismatch');
  try {
    const canonical = realpathSync.native(spec.launcher.executable_path);
    if (canonical !== spec.launcher.executable_path) return fail('GenericCli target canonical path mismatch');
    if (!statSync(canonical).isFile()) return fail('GenericCli target is not a regular file');
    const digest = createHash('sha256').update(readFileSync(canonical)).digest('hex');
    if (digest !== spec.launcher.executable_sha256) return fail('GenericCli target SHA-256 mismatch');
    return { ok: true };
  } catch {
    return fail('GenericCli target artifact is unavailable');
  }
}
