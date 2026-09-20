import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPreparedConfigure,
  ConfigureError,
  prepareConfigure,
  type ConfigureErrorCode,
} from '../src/configure.ts';
import { initGitRepo, tempDir } from './helpers.ts';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { repo: string; home: string; config: string } {
  const repo = initGitRepo();
  const home = tempDir('eng-mcp-config-home-');
  const hostDir = join(home, '.codex');
  mkdirSync(hostDir);
  const config = join(hostDir, 'config.toml');
  cleanup.push(repo, home);
  return { repo, home, config };
}

function expectConfigureError(run: () => unknown, code: ConfigureErrorCode): ConfigureError {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigureError);
    expect((error as ConfigureError).code).toBe(code);
    return error as ConfigureError;
  }
}

function ownedEntry(path: string): { command: string; args: string[]; enabled?: boolean } {
  const document = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const servers = document.mcp_servers as Record<string, unknown>;
  return servers['engineering-mcp'] as { command: string; args: string[]; enabled?: boolean };
}

function backups(path: string): string[] {
  const prefix = `${path.split(/[\\/]/).at(-1)}.engineering-mcp.`;
  return readdirSync(dirname(path)).filter((name) => name.startsWith(prefix) && name.includes('.bak'));
}

function installedLauncher(root: string, name = 'engineering-mcp-cli'): string {
  const packageRoot = join(root, `package-${Math.random().toString(16).slice(2)}`);
  const dist = join(packageRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name, bin: { 'engineering-mcp': 'dist/cli.js' } })}\n`,
  );
  const script = join(dist, 'cli.js');
  writeFileSync(script, '#!/usr/bin/env node\n');
  return script;
}

describe('Safe Configure planning and application', () => {
  it('previews an exact add without mutating a missing configuration', () => {
    const item = fixture();
    const prepared = prepareConfigure({ host: 'codex', home: item.home, repo: item.repo, cwd: item.repo });

    expect(existsSync(item.config)).toBe(false);
    expect(prepared.plan.operations).toEqual({
      add: [
        {
          path: 'mcp_servers.engineering-mcp',
          after: {
            command: 'engineering-mcp',
            args: ['--role', 'owner', '--repo', item.repo],
          },
        },
      ],
      change: [],
      remove: [],
    });
    expect(prepared.plan.no_change).toBe(false);
    expect(readdirSync(dirname(item.config))).toEqual([]);
  });

  it('creates and verifies a backup before mutation while preserving unrelated bytes and unknown owned keys', () => {
    const item = fixture();
    const original = `theme = "night"\r\n\r\n[mcp_servers.other]\r\ncommand = "other-server"\r\nargs = ["--keep"]\r\n\r\n[mcp_servers.engineering-mcp]\r\n# operator comment\r\ncommand = "legacy-engineering-mcp" # old command\r\nargs = ["--role", "junior"] # old args\r\nenabled = true\r\n\r\n[ui]\r\naccent = "blue"\r\n`;
    writeFileSync(item.config, original, 'utf8');
    const prepared = prepareConfigure({
      host: 'codex',
      configPath: item.config,
      repo: item.repo,
      cwd: item.repo,
      command: 'engineering-mcp',
      now: new Date('2026-09-15T01:02:03.000Z'),
    });
    expect(prepared.plan.stale_or_test_entries.map((finding) => finding.kind)).toContain('STALE');

    let backupObserved = false;
    const applied = applyPreparedConfigure(prepared, {
      afterCapture: ({ configPath, backupPath }) => {
        backupObserved = true;
        expect(existsSync(configPath)).toBe(false);
        expect(readFileSync(backupPath, 'utf8')).toBe(original);
      },
    });

    expect(backupObserved).toBe(true);
    expect(applied.mode).toBe('APPLIED');
    expect(applied.backup_path).not.toBeNull();
    expect(readFileSync(applied.backup_path!, 'utf8')).toBe(original);
    const updated = readFileSync(item.config, 'utf8');
    expect(updated).toContain('theme = "night"\r\n');
    expect(updated).toContain('[mcp_servers.other]\r\ncommand = "other-server"\r\nargs = ["--keep"]');
    expect(updated).toContain('# operator comment\r\n');
    expect(updated).toContain('enabled = true\r\n');
    expect(updated).toContain('[ui]\r\naccent = "blue"\r\n');
    expect(updated).toContain('# old command');
    expect(updated).toContain('# old args');
    expect(ownedEntry(item.config)).toMatchObject({
      command: 'engineering-mcp',
      args: ['--role', 'owner', '--repo', item.repo],
      enabled: true,
    });
  });

  it('updates an existing simple entry without regenerating the full TOML document', () => {
    const item = fixture();
    const profiles = 'operator-profiles.yaml';
    const customCommand = 'engineering-mcp-custom';
    const original = `[mcp_servers.engineering-mcp]\ncommand = ${JSON.stringify(customCommand)}\nargs = ["--role", "owner", "--worker-profiles", ${JSON.stringify(profiles)}]\ncustom = { nested = "preserve me" }\n`;
    writeFileSync(item.config, original);

    const prepared = prepareConfigure({
      host: 'codex',
      configPath: item.config,
      repo: item.repo,
      cwd: item.repo,
    });
    expect(prepared.plan.operations.add).toEqual([]);
    expect(prepared.plan.operations.change.map((change) => change.path)).toEqual([
      'mcp_servers.engineering-mcp.args',
    ]);
    applyPreparedConfigure(prepared);

    expect(readFileSync(item.config, 'utf8')).toContain('custom = { nested = "preserve me" }');
    expect(ownedEntry(item.config).command).toBe(customCommand);
    expect(ownedEntry(item.config).args).toEqual([
      '--role',
      'owner',
      '--repo',
      item.repo,
      '--worker-profiles',
      profiles,
    ]);
  });

  it('distinguishes a smoke/test binding and refuses to apply it as production configuration', () => {
    const item = fixture();
    const original = `[mcp_servers.engineering-mcp]\ncommand = "engineering-mcp-smoke"\nargs = ["--role", "owner", "--repo", ${JSON.stringify(item.repo)}, "--db", "smoke.sqlite"]\n`;
    writeFileSync(item.config, original);

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(prepared.plan.stale_or_test_entries.map((finding) => finding.kind)).toContain('TEST');
    expect(prepared.plan.safe_to_apply).toBe(false);
    expectConfigureError(() => applyPreparedConfigure(prepared), 'CONFIGURE_STALE_TEST');
    expect(readFileSync(item.config, 'utf8')).toBe(original);
    expect(backups(item.config)).toEqual([]);
  });

  it('detects an obsolete repository binding without treating it as current', () => {
    const item = fixture();
    const other = initGitRepo();
    cleanup.push(other);
    writeFileSync(
      item.config,
      `[mcp_servers.engineering-mcp]\ncommand = "engineering-mcp"\nargs = ["--role", "owner", "--repo", ${JSON.stringify(other)}]\n`,
    );

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(prepared.plan.stale_or_test_entries).toContainEqual({
      kind: 'STALE',
      server: 'engineering-mcp',
      reason: 'Existing entry is bound to a different or invalid repository',
    });
    expect(prepared.plan.operations.change[0]?.after).toEqual(['--role', 'owner', '--repo', item.repo]);
  });

  it('fails closed on malformed TOML and leaves it byte-for-byte unchanged', () => {
    const item = fixture();
    const malformed = '[mcp_servers.engineering-mcp\ncommand = "broken"\n';
    writeFileSync(item.config, malformed);

    expectConfigureError(
      () => prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo }),
      'CONFIGURE_MALFORMED',
    );
    expect(readFileSync(item.config, 'utf8')).toBe(malformed);
    expect(backups(item.config)).toEqual([]);
  });

  it('fails closed on an additional stale/test Engineering MCP entry', () => {
    const item = fixture();
    const original = `[mcp_servers.engineering-mcp-smoke]\ncommand = "engineering-mcp"\nargs = ["--role", "owner"]\n`;
    writeFileSync(item.config, original);

    const error = expectConfigureError(
      () => prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo }),
      'CONFIGURE_AMBIGUOUS',
    );
    expect(error.details).toEqual({ entries: ['engineering-mcp-smoke'] });
    expect(readFileSync(item.config, 'utf8')).toBe(original);
  });

  it('fails closed on a semantically owned inline entry that cannot be edited surgically', () => {
    const item = fixture();
    const original = `mcp_servers = { engineering-mcp = { command = "engineering-mcp", args = ["--role", "owner"] } }\n`;
    writeFileSync(item.config, original);

    expectConfigureError(
      () => prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo }),
      'CONFIGURE_UNSUPPORTED',
    );
    expect(readFileSync(item.config, 'utf8')).toBe(original);
  });

  it('surfaces a host-cwd versus bound-repository mismatch and pins the bound repository', () => {
    const item = fixture();
    const hostRepo = initGitRepo();
    cleanup.push(hostRepo);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: hostRepo });

    expect(prepared.plan.repository_binding).toMatchObject({
      invocation_cwd: hostRepo,
      host_cwd_repository: hostRepo,
      bound_repository: item.repo,
      binding_source: 'explicit-arg',
      matches_host_cwd: false,
    });
    expect(prepared.plan.repository_binding.warning).toContain('Repository-binding mismatch');
    expect(prepared.plan.intended_entry.args).toEqual(['--role', 'owner', '--repo', item.repo]);
  });

  it('makes repeated apply deterministic and creates no backup for the no-op', () => {
    const item = fixture();
    writeFileSync(item.config, 'setting = "keep"\n');
    const first = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    applyPreparedConfigure(first);
    expect(backups(item.config)).toHaveLength(1);

    const second = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(second.plan.no_change).toBe(true);
    const result = applyPreparedConfigure(second);
    expect(result).toMatchObject({ mode: 'NO_CHANGE', changed: false, backup_path: null });
    expect(backups(item.config)).toHaveLength(1);
  });

  it('detects source races after preview without creating a backup', () => {
    const item = fixture();
    writeFileSync(item.config, 'setting = "before"\n');
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    writeFileSync(item.config, 'setting = "external"\n');

    expectConfigureError(() => applyPreparedConfigure(prepared), 'CONFIGURE_PLAN_INVALIDATED');
    expect(readFileSync(item.config, 'utf8')).toBe('setting = "external"\n');
    expect(backups(item.config)).toEqual([]);
  });

  it('retains the captured source for exact retry when failure occurs before installation', () => {
    const item = fixture();
    const original = 'setting = "safe"\n';
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    expectConfigureError(
      () => applyPreparedConfigure(prepared, { beforeInstall: () => { throw new Error('injected write failure'); } }),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(existsSync(item.config)).toBe(false);
    expect(backups(item.config)).toHaveLength(1);
  });

  it('does not automatically roll back after installation', () => {
    const item = fixture();
    const original = 'setting = "safe"\n';
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    expectConfigureError(
      () => applyPreparedConfigure(prepared, { afterInstall: () => { throw new Error('injected verification failure'); } }),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(readFileSync(item.config, 'utf8')).toBe(prepared.proposedContent);
    expect(backups(item.config)).toHaveLength(1);
  });

  it('refuses rollback after a third-party post-replacement edit and preserves both edit and backup', () => {
    const item = fixture();
    const original = Buffer.from('setting = "safe"\n', 'utf8');
    const external = Buffer.from('setting = "third-party"\n', 'utf8');
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    const error = expectConfigureError(
      () =>
        applyPreparedConfigure(prepared, {
          afterInstall: ({ configPath }) => {
            writeFileSync(configPath, external);
            throw new Error('injected post-replacement failure');
          },
        }),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(readFileSync(item.config)).toEqual(external);
    expect(backups(item.config)).toHaveLength(1);
    const backup = join(dirname(item.config), backups(item.config)[0]!);
    expect(readFileSync(backup)).toEqual(original);
    expect(error.details).toMatchObject({ config_path: item.config, backup_path: backup });
  });

  it('never reuses a pre-existing backup pathname', () => {
    const item = fixture();
    const original = Buffer.from('setting = "original"\n', 'utf8');
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    const result = applyPreparedConfigure(prepared);
    expect(result.backup_path).not.toBeNull();
    expect(readFileSync(result.backup_path!)).toEqual(original);
    expect(backups(item.config)).toEqual([result.backup_path!.split(/[\\/]/).at(-1)]);
  });

  it('does not replace the target or delete a backup changed by another writer', () => {
    const item = fixture();
    const original = Buffer.from('setting = "original"\n', 'utf8');
    const externalBackup = Buffer.from('backup changed by another writer\n', 'utf8');
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    let backupPath = '';

    expectConfigureError(
      () =>
        applyPreparedConfigure(prepared, {
          afterCapture: ({ backupPath: path }) => {
            backupPath = path;
            writeFileSync(path, externalBackup);
          },
        }),
      'CONFIGURE_PLAN_INVALIDATED',
    );
    expect(readFileSync(item.config)).toEqual(externalBackup);
    expect(readFileSync(backupPath)).toEqual(externalBackup);
  });

  it('recognizes the supported node dist/cli.js launcher and surfaces its stale repository', () => {
    const item = fixture();
    const other = initGitRepo();
    cleanup.push(other);
    const script = installedLauncher(item.home);
    writeFileSync(
      item.config,
      `[mcp_servers.engineering-mcp]\ncommand = "node"\nargs = [${JSON.stringify(script)}, "--role", "owner", "--repo", ${JSON.stringify(other)}]\n`,
    );
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(prepared.plan.stale_or_test_entries).toContainEqual({
      kind: 'STALE',
      server: 'engineering-mcp',
      reason: 'Existing entry is bound to a different or invalid repository',
    });
    expect(prepared.plan.intended_entry).toMatchObject({
      command: 'node',
      args: [script, '--role', 'owner', '--repo', item.repo],
    });
  });

  it('recognizes the same Windows Node launcher by filesystem identity across path casing', () => {
    const item = fixture();
    const script = installedLauncher(item.home);
    const differentlyCased = script
      .split('')
      .map((character) => /[a-z]/.test(character) ? character.toUpperCase() : /[A-Z]/.test(character) ? character.toLowerCase() : character)
      .join('');
    writeFileSync(
      item.config,
      `[mcp_servers.engineering-mcp]\ncommand = "node"\nargs = [${JSON.stringify(differentlyCased)}, "--role", "owner", "--repo", ${JSON.stringify(item.repo)}]\n`,
    );

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(prepared.plan.intended_entry.args[0]).toBe(differentlyCased);
    expect(prepared.plan.operations.change).toEqual([]);
  });

  it('does not claim a distinct similarly named Node script from a proven package', () => {
    const item = fixture();
    const script = installedLauncher(item.home);
    const similar = join(dirname(script), 'cli-copy.js');
    writeFileSync(similar, '#!/usr/bin/env node\n');
    writeFileSync(
      item.config,
      `[mcp_servers.similar]\ncommand = "node"\nargs = [${JSON.stringify(similar)}, "--role", "owner", "--repo", ${JSON.stringify(item.repo)}]\n`,
    );

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(prepared.plan.stale_or_test_entries).toEqual([]);
    expect(prepared.plan.operations.add).toHaveLength(1);
  });

  it('fails closed on an additional supported node owner launcher but ignores unrelated node services', () => {
    const item = fixture();
    writeFileSync(
      item.config,
      `[mcp_servers.legacy-owner]\ncommand = "node"\nargs = [${JSON.stringify(installedLauncher(item.home))}, "--role", "owner", "--repo", ${JSON.stringify(item.repo)}]\n`,
    );
    expectConfigureError(
      () => prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo }),
      'CONFIGURE_AMBIGUOUS',
    );

    writeFileSync(
      item.config,
      `[mcp_servers.web]\ncommand = "node"\nargs = [${JSON.stringify(installedLauncher(item.home, 'unrelated-service'))}, "--role", "owner", "--repo", ${JSON.stringify(item.repo)}]\n`,
    );
    const unrelated = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    expect(unrelated.plan.stale_or_test_entries).toEqual([]);
    expect(unrelated.plan.operations.add).toHaveLength(1);
  });

  it('treats semantically equal command and args as a byte-exact no-op', () => {
    const item = fixture();
    const original = `[mcp_servers.engineering-mcp]\ncommand   = 'engineering-mcp' # keep quotes\nargs = [ '--role' , 'owner' , '--repo' , '${item.repo}' ] # keep spacing\n`;
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    expect(prepared.plan.operations).toEqual({ add: [], change: [], remove: [] });
    expect(prepared.plan.no_change).toBe(true);
    expect(prepared.proposedContent).toBe(original);
    const beforeNames = readdirSync(dirname(item.config)).sort();
    const result = applyPreparedConfigure(prepared);
    expect(result).toMatchObject({ mode: 'NO_CHANGE', changed: false, backup_path: null });
    expect(readFileSync(item.config, 'utf8')).toBe(original);
    expect(readdirSync(dirname(item.config)).sort()).toEqual(beforeNames);
  });

  it('applies a new config without a fake backup and emits doctor/connection verification guidance', () => {
    const item = fixture();
    const prepared = prepareConfigure({ host: 'grok', configPath: item.config, repo: item.repo, cwd: item.repo });
    const result = applyPreparedConfigure(prepared);

    expect(result).toMatchObject({ mode: 'APPLIED', changed: true, backup_path: null });
    expect(ownedEntry(item.config)).toMatchObject({
      command: 'engineering-mcp',
      args: ['--role', 'owner', '--repo', item.repo],
    });
    expect(result.verification.doctor_command).toContain('engineering-mcp doctor --repo');
    expect(result.verification.connection_checks.join('\n')).toContain('Reconnect the MCP host');
  });

  it('creates a missing default host directory only during explicit apply', () => {
    const repo = initGitRepo();
    const home = tempDir('eng-mcp-config-new-home-');
    cleanup.push(repo, home);
    const config = join(home, '.grok', 'config.toml');

    const prepared = prepareConfigure({ host: 'grok', home, repo, cwd: repo });
    expect(existsSync(join(home, '.grok'))).toBe(false);
    applyPreparedConfigure(prepared);
    expect(ownedEntry(config).args).toEqual(['--role', 'owner', '--repo', repo]);
  });

  it('rejects a directory or special target as unsafe', () => {
    const item = fixture();
    const directoryTarget = join(dirname(item.config), 'not-a-config.toml');
    mkdirSync(directoryTarget);

    expectConfigureError(
      () => prepareConfigure({ host: 'codex', configPath: directoryTarget, repo: item.repo, cwd: item.repo }),
      'CONFIGURE_UNSAFE_FILE',
    );
  });

  it('does not overwrite an external edit made after the verified backup', () => {
    const item = fixture();
    const original = 'setting = "previewed"\n';
    const external = 'setting = "external edit"\n';
    writeFileSync(item.config, original);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    expectConfigureError(
      () => applyPreparedConfigure(prepared, { afterCapture: ({ configPath }) => writeFileSync(configPath, external) }),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(readFileSync(item.config, 'utf8')).toBe(external);
    expect(backups(item.config)).toHaveLength(1);
  });

  it('surgically updates a quoted owned table while preserving its descendant table', () => {
    const item = fixture();
    writeFileSync(
      item.config,
      `[mcp_servers."engineering-mcp"]\ncommand = "old"\nargs = ["--role", "owner"]\n\n[mcp_servers."engineering-mcp".env]\nKEEP = "yes"\n`,
    );
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    applyPreparedConfigure(prepared);

    expect(readFileSync(item.config, 'utf8')).toContain('[mcp_servers."engineering-mcp".env]\nKEEP = "yes"');
    expect(ownedEntry(item.config).args).toEqual(['--role', 'owner', '--repo', item.repo]);
  });
});
