import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors.ts';
import {
  builtinWorkerProfiles,
  loadWorkerProfiles,
  resolveWorkerProfile,
  listWorkerProfiles,
} from '../src/worker-profiles.ts';
import { tempDir, removeDir } from './helpers.ts';

const dirs: string[] = [];
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function tempFile(name: string, content: string): string {
  const dir = tempDir('eng-mcp-profiles-');
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function genericManifestPath(): string {
  const dir = tempDir('eng-mcp-profile-manifest-');
  dirs.push(dir);
  const path = join(dir, 'generic.yaml');
  writeFileSync(
    path,
    `schema: engineering-cli-adapter/1
id: profile-generic
name: Profile Generic
adapter: generic-cli
command: node
arguments: []
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
  return path;
}

function validProfilesYaml(manifestPath: string): string {
  return `schema: engineering-worker-profiles/1
default_profile: codex-luna
profiles:
  codex-luna:
    adapter: codex-exec-luna
    description: Codex CLI worker
  generic-test:
    adapter: generic-cli
    manifest: ${JSON.stringify(manifestPath)}
    profile: headless
    model: fake-model
    description: Generic test worker
`;
}

describe('worker profile registry', () => {
  it('loads a valid registry and resolves explicit/default profiles', () => {
    const path = tempFile('profiles.yaml', validProfilesYaml(genericManifestPath()));
    const profiles = loadWorkerProfiles(path);
    expect(profiles.defaultProfile).toBe('codex-luna');
    expect(profiles.profiles.size).toBe(2);
    expect(profiles.sourcePath).toBe(path);
    expect(resolveWorkerProfile(profiles).id).toBe('codex-luna');
    expect(resolveWorkerProfile(profiles, 'generic-test').id).toBe('generic-test');
  });

  it('uses builtin codex-luna without an external file', () => {
    const profiles = builtinWorkerProfiles();
    expect(profiles.defaultProfile).toBe('codex-luna');
    expect(resolveWorkerProfile(profiles).adapter).toBe('codex-exec-luna');
    expect(listWorkerProfiles(profiles)).toHaveLength(1);
  });

  it('rejects invalid schema version', () => {
    const path = tempFile(
      'bad-schema.yaml',
      `schema: engineering-worker-profiles/999\ndefault_profile: codex-luna\nprofiles:\n  codex-luna:\n    adapter: codex-exec-luna\n`,
    );
    expect(() => loadWorkerProfiles(path)).toThrow(DomainError);
  });

  it('rejects invalid profile ids', () => {
    const path = tempFile(
      'bad-id.yaml',
      `schema: engineering-worker-profiles/1\ndefault_profile: bad id\nprofiles:\n  "bad id":\n    adapter: codex-exec-luna\n`,
    );
    expect(() => loadWorkerProfiles(path)).toThrow(/invalid profile id/);
  });

  it('rejects duplicate profile ids in YAML', () => {
    const path = tempFile(
      'duplicate.yaml',
      `schema: engineering-worker-profiles/1
default_profile: x
profiles:
  x:
    adapter: codex-exec-luna
  x:
    adapter: generic-cli
`,
    );
    expect(() => loadWorkerProfiles(path)).toThrow(DomainError);
  });

  it('rejects missing default profile', () => {
    const path = tempFile(
      'no-default.yaml',
      `schema: engineering-worker-profiles/1\nprofiles:\n  other:\n    adapter: codex-exec-luna\n`,
    );
    expect(() => loadWorkerProfiles(path)).toThrow(/default_profile is required/);
  });

  it('rejects unknown adapter', () => {
    const path = tempFile(
      'unknown-adapter.yaml',
      `schema: engineering-worker-profiles/1\ndefault_profile: x\nprofiles:\n  x:\n    adapter: no-such-adapter\n`,
    );
    expect(() => loadWorkerProfiles(path)).toThrow(/unknown adapter/);
  });

  it('rejects generic profile missing manifest', () => {
    const path = tempFile(
      'missing-manifest.yaml',
      `schema: engineering-worker-profiles/1\ndefault_profile: g\nprofiles:\n  g:\n    adapter: generic-cli\n`,
    );
    expect(() => loadWorkerProfiles(path)).toThrow(/generic-cli requires manifest/);
  });

  it('rejects relative profile file path', () => {
    expect(() => loadWorkerProfiles('relative/profiles.yaml')).toThrow(DomainError);
  });

  it('fails closed on invalid configured file', () => {
    const path = tempFile('invalid.yaml', 'not: [valid');
    expect(() => loadWorkerProfiles(path)).toThrow(DomainError);
  });

  it('loads registry once and does not observe later file mutation', () => {
    const manifestPath = genericManifestPath();
    const path = tempFile('mutable.yaml', validProfilesYaml(manifestPath));
    const profiles = loadWorkerProfiles(path);
    const before = listWorkerProfiles(profiles);
    expect(before).toHaveLength(2);

    writeFileSync(
      path,
      `schema: engineering-worker-profiles/1\ndefault_profile: changed\nprofiles:\n  changed:\n    adapter: codex-exec-luna\n`,
      'utf8',
    );

    expect(listWorkerProfiles(profiles)).toHaveLength(2);
    expect(resolveWorkerProfile(profiles, 'codex-luna')).toBeTruthy();
  });
});

describe('worker profile CLI precedence', () => {
  function runProfiles(args: string[], env: Record<string, string | undefined> = {}) {
    return spawnSync(process.execPath, [cliPath, 'profiles', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env as Record<string, string>, ...env },
      shell: false,
      windowsHide: true,
    });
  }

  it('--worker-profiles wins over ENGINEERING_MCP_WORKER_PROFILES', () => {
    const argPath = tempFile('arg.yaml', validProfilesYaml(genericManifestPath()));
    const envPath = tempFile('env.yaml', validProfilesYaml(genericManifestPath()));
    const result = runProfiles(['--worker-profiles', argPath], { ENGINEERING_MCP_WORKER_PROFILES: envPath });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('generic-test');
    expect(result.stdout).not.toContain('env-only');
  });

  it('invalid higher-priority --worker-profiles does not fall through to env', () => {
    const invalid = tempFile('invalid.yaml', 'bad: [');
    const envPath = tempFile('env.yaml', validProfilesYaml(genericManifestPath()));
    const result = runProfiles(['--worker-profiles', invalid], { ENGINEERING_MCP_WORKER_PROFILES: envPath });
    expect(result.status).not.toBe(0);
  });
});
