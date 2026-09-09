#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ledgerPathFor } from './db-path.ts';
import { inspectRepo } from './git.ts';
import { resolveRepository } from './repository-resolver.ts';
import { loadManifest, validateManifest } from './adapters/manifest.ts';
import { SCHEMA_VERSION } from './types.ts';
import { resolveRuntimeEntry } from './runtime-resolver.ts';
import { builtinWorkerProfiles, listWorkerProfiles, loadWorkerProfiles } from './worker-profiles.ts';

const VERSION = '0.1.1';
const serverEntry = resolveRuntimeEntry(import.meta.url, {
  source: './index.ts',
  dist: './index.js',
});

function printHelp(): void {
  console.log(`engineering-mcp v${VERSION}

A safety-first control plane for native coding-agent harnesses.

Usage:
  engineering-mcp --role owner|junior|principal [--repo <path>] [--db <path>] [--worker-profiles <path>]
  engineering-mcp setup
  engineering-mcp doctor
  engineering-mcp profiles
  engineering-mcp adapter validate <manifest>
  engineering-mcp adapter probe <manifest>

Commands:
  setup                 Preview MCP host configuration snippets (no files written)
  doctor                Report local runtime, Git, ledger, and harness availability
  profiles              Print loaded worker profiles without invoking models
  adapter validate      Validate a GenericCliAdapter manifest only
  adapter probe         Locate the manifest command without invoking a model

Options:
  --help                Show this help.
`);
}

function runServer(args: string[]): void {
  const child = spawn(process.execPath, [serverEntry, ...args], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  child.on('close', (code) => process.exit(code ?? 1));
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}

function resolveCommand(command: string): string | null {
  if (process.platform === 'win32') {
    const candidates = [command, `${command}.cmd`, `${command}.bat`, `${command}.exe`];
    for (const candidate of candidates) {
      try {
        const output = execFileSync('where.exe', [candidate], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }).trim();
        const first = output.split(/\r?\n/)[0];
        if (first) return first;
      } catch {
        // continue
      }
    }
    return null;
  }

  try {
    return execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function commandExists(command: string): boolean {
  return resolveCommand(command) !== null;
}

function setup(): void {
  console.log(`Engineering MCP v${VERSION} setup preview

No configuration files were written by this command.

Recommended MCP server command:
  engineering-mcp --role owner

The command intentionally has no hardcoded --repo. Repository binding is resolved
automatically at process startup.

Codex CLI example snippet:
  [mcp_servers.engineering-mcp]
  command = "engineering-mcp"
  args = ["--role", "owner"]

Grok CLI example snippet (native TOML in ~/.grok/config.toml):
  [mcp_servers.engineering-mcp]
  command = "engineering-mcp"
  args = ["--role", "owner"]

If your host uses .mcp.json or another standards-based JSON host, the equivalent
JSON snippet is:

  {
    "mcpServers": {
      "engineering-mcp": {
        "command": "engineering-mcp",
        "args": ["--role", "owner"]
      }
    }
  }

If your host pins a specific workspace directory, Engineering MCP will use that
directory for automatic Git repository discovery. You can also pin explicitly:

  engineering-mcp --role owner --repo /absolute/path/to/repo

Optional trusted Worker Profiles file:
  engineering-mcp --role owner --worker-profiles /absolute/path/to/profiles.yaml

Worker Profiles are trusted operator configuration. They select preconfigured
Harness execution profiles; they do not let task text choose executables,
models, providers, or credentials.

Run "engineering-mcp doctor" to verify local prerequisites.
`);
}

async function inspectLedgerFile(ledgerPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(ledgerPath)) {
    return { status: 'not-found' };
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const userVersionRow = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
      const userVersion = userVersionRow ? Object.values(userVersionRow)[0] : null;
      const bindingRow = db
        .prepare(`SELECT value FROM ledger_metadata WHERE key = 'repository_root'`)
        .get() as { value?: string } | undefined;
      const tables = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'task_events', 'ledger_metadata', 'dispatch_runs')`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      const schemaCurrent = Number(userVersion) === SCHEMA_VERSION;
      return {
        status: bindingRow?.value && schemaCurrent ? 'verified' : 'found',
        schema_version: userVersion,
        schema_current: schemaCurrent,
        repository_binding: bindingRow?.value ?? null,
        tables,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      status: 'found',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function codexCliStatus(): string {
  if (!commandExists('codex') && !commandExists('codex.cmd')) {
    return 'not-found';
  }
  const home = homedir();
  const configCandidates = [join(home, '.codex', 'config.toml'), join(home, '.codex', 'config.json')];
  return configCandidates.some((candidate) => existsSync(candidate)) ? 'configured' : 'found';
}

async function doctor(args: string[]): Promise<void> {
  const repoArg = optionValue(args, '--repo');
  const gitFound = commandExists('git');
  const codexStatus = codexCliStatus();
  const dshFound = commandExists('dsh') || commandExists('dsh.cmd');

  const report: Record<string, unknown> = {
    node: process.version,
    platform: process.platform,
    git: gitFound ? 'found' : 'not-found',
    repository: {
      status: 'not-found',
      source: null,
      root: null,
      branch: null,
      head: null,
      clean: null,
    },
    ledger: {
      path: null,
      status: 'not-found',
      schema_version: null,
      repository_binding: null,
    },
    codex_cli: codexStatus,
    generic_harness_subsystem: 'found',
    dsh: dshFound ? 'found' : 'not-found',
  };

  const profilePath = optionValue(args, '--worker-profiles') ?? process.env.ENGINEERING_MCP_WORKER_PROFILES;
  if (profilePath) {
    try {
      const workerProfiles = loadWorkerProfiles(profilePath);
      report.worker_profiles = {
        status: 'loaded',
        source_path: workerProfiles.sourcePath,
        default_profile: workerProfiles.defaultProfile,
        count: workerProfiles.profiles.size,
      };
    } catch (error) {
      report.worker_profiles = {
        status: 'invalid',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    report.worker_profiles = {
      status: 'builtin',
      default_profile: 'codex-luna',
      count: 1,
    };
  }

  try {
    const resolution = resolveRepository({
      arg: repoArg,
      envRepo: process.env.ENGINEERING_MCP_REPO,
      cwd: process.cwd(),
    });
    const git = inspectRepo(resolution.repoRoot);
    report.repository = {
      status: 'verified',
      source: resolution.source,
      root: resolution.repoRoot,
      branch: git.branch,
      head: git.head,
      clean: git.clean,
    };

    const ledgerPath = ledgerPathFor(resolution.repoRoot);
    const ledger = await inspectLedgerFile(ledgerPath);
    report.ledger = {
      path: ledgerPath,
      status: ledger.status,
      schema_version: ledger.schema_version ?? null,
      schema_current: ledger.schema_current ?? null,
      repository_binding: ledger.repository_binding ?? null,
    };
    if (ledger.error) {
      (report.ledger as Record<string, unknown>).error = ledger.error;
    }
  } catch (error) {
    report.repository_error = error instanceof Error ? error.message : String(error);
  }

  console.log(JSON.stringify(report, null, 2));
}

function runProbeVersion(resolved: string): string | null {
  try {
    const output =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)
        ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${resolved}" --version`], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          })
        : execFileSync(resolved, ['--version'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          });
    const text = output.trim();
    return text.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function profilesCommand(args: string[]): void {
  const path = optionValue(args, '--worker-profiles') ?? process.env.ENGINEERING_MCP_WORKER_PROFILES;
  const workerProfiles = path ? loadWorkerProfiles(path) : builtinWorkerProfiles();
  console.log(
    JSON.stringify(
      {
        ok: true,
        default_profile: workerProfiles.defaultProfile,
        profiles: listWorkerProfiles(workerProfiles),
      },
      null,
      2,
    ),
  );
}

function adapterCommand(args: string[]): void {
  const [sub, manifestPath] = args;
  if (!sub || !manifestPath) {
    console.error('usage: engineering-mcp adapter validate|probe|smoke <manifest>');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  const validation = validateManifest(manifest);

  if (sub === 'validate') {
    console.log(JSON.stringify({ ok: validation.ok, errors: validation.errors }, null, 2));
    process.exit(validation.ok ? 0 : 1);
    return;
  }

  if (sub === 'probe') {
    const resolved = resolveCommand(manifest.command);
    const version = resolved ? runProbeVersion(resolved) : null;
    const ok = validation.ok && resolved !== null && version !== null;
    console.log(
      JSON.stringify(
        {
          ok,
          validation,
          command: manifest.command,
          resolved_command: resolved,
          version,
          authenticated_model_execution: 'not tested',
        },
        null,
        2,
      ),
    );
    process.exit(ok ? 0 : 1);
    return;
  }

  if (sub === 'smoke') {
    console.error('adapter smoke is opt-in and requires a configured real harness; not run from this command');
    process.exit(1);
    return;
  }

  console.error(`unknown adapter subcommand: ${sub}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printHelp();
    return;
  }

  if (args.includes('--role')) {
    runServer(args);
    return;
  }

  const [cmd, ...rest] = args;
  if (cmd === 'setup') {
    setup();
    return;
  }
  if (cmd === 'doctor') {
    await doctor(rest);
    return;
  }
  if (cmd === 'adapter') {
    adapterCommand(rest);
    return;
  }
  if (cmd === 'profiles') {
    profilesCommand(rest);
    return;
  }

  console.error('Unknown command. Use engineering-mcp --help');
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
