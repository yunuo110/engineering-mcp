import { z } from 'zod/v4';
import { EngineeringGenericCliV1Adapter } from '../adapters/engineering-generic-cli-v1-adapter.ts';
import {
  buildGenericCliTargetV1, genericCliTargetV1Schema, verifyGenericCliTargetV1,
  GENERIC_CLI_TARGET_V1, type GenericCliTargetV1, type GenericCliTargetBuildOptions,
} from '../commands/generic-cli-target-v1.ts';
import {
  EngineeringCodexLunaV1Adapter,
  verifyEngineeringLaunchV1Artifact,
  type ExactCodexV1AdapterOptions,
} from '../adapters/engineering-codex-luna-v1-adapter.ts';
import {
  buildSecretSafeCodexLunaLaunchSpecV1,
  CODEX_LUNA_ADAPTER_ID,
  ENGINEERING_LAUNCH_SCHEMA_V1,
  secretSafeLaunchSpecV1Schema,
  type LaunchSpecBuildOptions,
  type SecretSafeLaunchSpecV1,
} from '../commands/launch-spec.ts';
import type { WorkerAdapter } from '../orchestration/types.ts';
import type { WorkerProfiles } from '../worker-profiles.ts';

// Bridge B adds a separate strict variant; the original Codex schema and
// stored bytes are reused unchanged, with no normalization or migration.
export const durableTargetSpecSchema = z.discriminatedUnion('schema', [
  secretSafeLaunchSpecV1Schema,
  genericCliTargetV1Schema,
]);
export type DurableTargetSpec = z.infer<typeof durableTargetSpecSchema>;

// Preserve the existing trusted build/runtime test hooks. These options are
// never read from a C2C command or a persisted target, nor used as registry keys.
export type DurableTargetBuildOptions = LaunchSpecBuildOptions & GenericCliTargetBuildOptions;
export type DurableTargetRuntimeOptions = ExactCodexV1AdapterOptions;

export type BuiltDurableTarget = {
  adapterId: string;
  spec: DurableTargetSpec;
};

type DurableTargetBuildFailure = {
  ok: false;
  code: 'LAUNCH_TARGET_UNSUPPORTED' | 'LAUNCH_TARGET_INVALID' | 'DURABLE_TARGET_UNSUPPORTED';
  message: string;
};

export type DurableTargetBuildResult =
  | ({ ok: true } & BuiltDurableTarget)
  | DurableTargetBuildFailure;

type DurableTargetBuilder = Readonly<{
  adapterId: string;
  buildFromTrustedProfile(
    profiles: WorkerProfiles,
    workerProfileId: string,
    options?: DurableTargetBuildOptions,
  ): { ok: true; spec: DurableTargetSpec } | DurableTargetBuildFailure;
}>;

export type DurableTargetVerificationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type DurableTargetRuntime<TSpec extends DurableTargetSpec = DurableTargetSpec> = Readonly<{
  schema: TSpec['schema'];
  parse(raw: unknown): TSpec;
  preclaimVerify(
    spec: TSpec,
    options?: DurableTargetRuntimeOptions,
  ): DurableTargetVerificationResult;
  createExactAdapter(
    spec: TSpec,
    options?: DurableTargetRuntimeOptions,
  ): WorkerAdapter;
}>;

const codexLunaBuilder = Object.freeze<DurableTargetBuilder>({
  adapterId: CODEX_LUNA_ADAPTER_ID,
  buildFromTrustedProfile(profiles, workerProfileId, options) {
    // Keep all existing built-in-profile, platform, launcher, and secret rules.
    return buildSecretSafeCodexLunaLaunchSpecV1(
      profiles,
      workerProfileId,
      options,
    );
  },
});

const codexLunaRuntime = Object.freeze<DurableTargetRuntime<SecretSafeLaunchSpecV1>>({
  schema: ENGINEERING_LAUNCH_SCHEMA_V1,
  parse(raw) {
    return secretSafeLaunchSpecV1Schema.parse(raw);
  },
  preclaimVerify(spec, options) {
    const verified = verifyEngineeringLaunchV1Artifact(spec, options);
    return verified.ok
      ? verified
      : {
          ok: false,
          code: 'CODEX_ARTIFACT_MISMATCH',
          message: verified.message,
        };
  },
  createExactAdapter(spec, options) {
    return new EngineeringCodexLunaV1Adapter(spec, options);
  },
});

// Private, compiled, frozen mappings. No registration API, dynamic import,
// wire-selected module, or ordinary adapter-registry fallback is permitted.
// The ordinary 'codex' alias is deliberately NOT a durable build target: the
// frozen builder accepts only the real built-in codex-luna profile.
const genericCliBuilder = Object.freeze<DurableTargetBuilder>({
  adapterId: 'generic-cli',
  buildFromTrustedProfile: buildGenericCliTargetV1,
});

const genericCliRuntime = Object.freeze<DurableTargetRuntime<GenericCliTargetV1>>({
  schema: GENERIC_CLI_TARGET_V1,
  parse(raw) { return genericCliTargetV1Schema.parse(raw); },
  preclaimVerify: verifyGenericCliTargetV1,
  createExactAdapter(spec, options) { return new EngineeringGenericCliV1Adapter(spec, options); },
});

const buildHandlers = Object.freeze({
  [CODEX_LUNA_ADAPTER_ID]: codexLunaBuilder,
  'generic-cli': genericCliBuilder,
});

const runtimeHandlers = Object.freeze({
  [ENGINEERING_LAUNCH_SCHEMA_V1]: codexLunaRuntime,
  [GENERIC_CLI_TARGET_V1]: genericCliRuntime,
} satisfies {
  [Schema in DurableTargetSpec['schema']]: DurableTargetRuntime<
    Extract<DurableTargetSpec, { schema: Schema }>
  >;
});

/** Select only from the startup-loaded, trusted profile's adapter. */
export function buildDurableTargetFromTrustedProfile(
  profiles: WorkerProfiles,
  workerProfileId: string,
  options: DurableTargetBuildOptions = {},
): DurableTargetBuildResult {
  const profile = profiles.profiles.get(workerProfileId);
  if (!profile || !Object.hasOwn(buildHandlers, profile.adapter)) {
    // Preserve the frozen unsupported-profile result, including its message.
    return {
      ok: false,
      code: 'LAUNCH_TARGET_UNSUPPORTED',
      message: 'S3B2A V1 supports only the real built-in codex-luna profile',
    };
  }
  const handler = buildHandlers[profile.adapter as keyof typeof buildHandlers];
  const built = handler.buildFromTrustedProfile(profiles, workerProfileId, options);
  return built.ok ? { ...built, adapterId: handler.adapterId } : built;
}

/** Select only from the durable schema; never consult current profiles. */
export function getDurableTargetRuntime(schema: string): DurableTargetRuntime {
  if (!Object.hasOwn(runtimeHandlers, schema)) {
    throw new Error(`Unsupported C2C durable target schema: ${schema}`);
  }
  return runtimeHandlers[schema as keyof typeof runtimeHandlers];
}
