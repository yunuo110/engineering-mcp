import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import YAML from 'yaml';
import { validateManifest } from './adapters/manifest.ts';
import { DomainError } from './errors.ts';

export const WORKER_PROFILES_SCHEMA_ID = 'engineering-worker-profiles/1';
export const BUILTIN_PROFILE_ID = 'codex-luna';

const KNOWN_ADAPTERS = new Set(['codex', 'codex-exec-luna', 'generic-cli']);

export const workerProfileSchema = z
  .object({
    adapter: z.string().min(1),
    description: z.string().min(1).optional(),
    manifest: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const workerProfilesFileSchema = z
  .object({
    schema: z.literal(WORKER_PROFILES_SCHEMA_ID),
    default_profile: z.string().min(1).optional(),
    profiles: z.record(z.string(), workerProfileSchema),
  })
  .strict();

export type WorkerProfile = z.infer<typeof workerProfileSchema>;
export type WorkerProfilesFile = z.infer<typeof workerProfilesFileSchema>;

export type WorkerProfileEntry = WorkerProfile & {
  id: string;
  manifestSnapshot?: string;
};

export type WorkerProfiles = {
  defaultProfile: string;
  profiles: ReadonlyMap<string, WorkerProfileEntry>;
  sourcePath: string | null;
};

function validateManifestSnapshot(raw: string): string[] {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return ['manifest is not valid YAML'];
  }
  const validation = validateManifest(parsed);
  if (!validation.ok) {
    return validation.errors;
  }
  return errors;
}

function collectProfileErrors(file: WorkerProfilesFile, manifestSnapshots: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  const ids = Object.keys(file.profiles);

  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      errors.push(`invalid profile id: ${id}`);
    }
  }

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    errors.push('duplicate profile ids are not allowed');
  }

  for (const id of ids) {
    const profile = file.profiles[id]!;
    if (!KNOWN_ADAPTERS.has(profile.adapter)) {
      errors.push(`profile ${id}: unknown adapter ${profile.adapter}`);
    }
    if (profile.adapter === 'generic-cli') {
      if (!profile.manifest) {
        errors.push(`profile ${id}: generic-cli requires manifest`);
      } else if (!isAbsolute(profile.manifest)) {
        errors.push(`profile ${id}: manifest must be an absolute path`);
      } else {
        const snapshot = manifestSnapshots.get(id);
        if (snapshot === undefined) {
          errors.push(`profile ${id}: manifest snapshot could not be read`);
        } else {
          for (const error of validateManifestSnapshot(snapshot)) {
            errors.push(`profile ${id}: manifest validation failed: ${error}`);
          }
        }
      }
    }
  }

  const defaultProfile = file.default_profile ?? (file.profiles[BUILTIN_PROFILE_ID] ? BUILTIN_PROFILE_ID : undefined);
  if (!defaultProfile) {
    errors.push('default_profile is required when codex-luna is not present');
  } else if (!file.profiles[defaultProfile]) {
    errors.push(`default_profile references unknown profile: ${defaultProfile}`);
  }

  return errors;
}

export function loadWorkerProfiles(filePath: string): WorkerProfiles {
  if (!isAbsolute(filePath)) {
    throw new DomainError(
      'WORKER_PROFILES_PATH_REQUIRED',
      `Worker profiles path must be absolute: ${filePath}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new DomainError(
      'WORKER_PROFILES_INVALID',
      `Could not read worker profiles file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    throw new DomainError('WORKER_PROFILES_INVALID', `Invalid YAML in worker profiles file: ${filePath}`);
  }

  const result = workerProfilesFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new DomainError(
      'WORKER_PROFILES_INVALID',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }

  const manifestSnapshots = new Map<string, string>();
  for (const id of Object.keys(result.data.profiles)) {
    const profile = result.data.profiles[id]!;
    if (profile.adapter === 'generic-cli' && profile.manifest) {
      try {
        manifestSnapshots.set(id, readFileSync(profile.manifest, 'utf8'));
      } catch (error) {
        // Reported as a validation error below.
        manifestSnapshots.set(id, '');
      }
    }
  }

  const validationErrors = collectProfileErrors(result.data, manifestSnapshots);
  if (validationErrors.length > 0) {
    throw new DomainError('WORKER_PROFILES_INVALID', validationErrors.join('; '), {
      profile_file: filePath,
    });
  }

  const file = result.data;
  const defaultProfile = file.default_profile ?? (file.profiles[BUILTIN_PROFILE_ID] ? BUILTIN_PROFILE_ID : undefined)!;
  const profiles = new Map<string, WorkerProfileEntry>();
  for (const id of Object.keys(file.profiles)) {
    const profile = file.profiles[id]!;
    const entry: WorkerProfileEntry = { id, ...profile };
    if (profile.adapter === 'generic-cli' && profile.manifest) {
      entry.manifestSnapshot = manifestSnapshots.get(id);
    }
    profiles.set(id, entry);
  }

  return {
    defaultProfile,
    profiles,
    sourcePath: filePath,
  };
}

export function builtinWorkerProfiles(): WorkerProfiles {
  return {
    defaultProfile: BUILTIN_PROFILE_ID,
    profiles: new Map([
      [
        BUILTIN_PROFILE_ID,
        {
          id: BUILTIN_PROFILE_ID,
          adapter: 'codex-exec-luna',
          description: 'Codex CLI worker',
        },
      ],
    ]),
    sourcePath: null,
  };
}

export function resolveWorkerProfile(profiles: WorkerProfiles, profileId?: string): WorkerProfileEntry {
  const id = profileId ?? profiles.defaultProfile;
  const profile = profiles.profiles.get(id);
  if (!profile) {
    throw new DomainError(
      'WORKER_PROFILE_NOT_FOUND',
      `Unknown worker profile: ${id}`,
      { worker_profile: id },
    );
  }
  return profile;
}

export function listWorkerProfiles(profiles: WorkerProfiles): Array<{
  id: string;
  description?: string;
  adapter: string;
  default: boolean;
  profile?: string;
  model?: string;
}> {
  return [...profiles.profiles.values()].map((entry) => ({
    id: entry.id,
    description: entry.description,
    adapter: entry.adapter,
    default: entry.id === profiles.defaultProfile,
    profile: entry.profile,
    model: entry.model,
  }));
}
