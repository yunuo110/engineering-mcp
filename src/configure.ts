import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { inspectRepo } from './git.ts';
import { resolveRepository, type RepositorySource } from './repository-resolver.ts';

export type ConfigureHost = 'codex' | 'grok';

export const CONFIGURE_ERROR_CODES = [
  'CONFIGURE_USAGE',
  'CONFIGURE_PATH_INVALID',
  'CONFIGURE_UNSAFE_FILE',
  'CONFIGURE_MALFORMED',
  'CONFIGURE_UNSUPPORTED',
  'CONFIGURE_AMBIGUOUS',
  'CONFIGURE_STALE_TEST',
  'CONFIGURE_SOURCE_CHANGED',
  'CONFIGURE_PLAN_REQUIRED',
  'CONFIGURE_PLAN_INVALID',
  'CONFIGURE_PLAN_INVALIDATED',
  'CONFIGURE_SECURITY_PRESERVATION_FAILED',
  'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
  'CONFIGURE_WRITE_FAILED',
] as const;

export type ConfigureErrorCode = (typeof CONFIGURE_ERROR_CODES)[number];

export class ConfigureError extends Error {
  readonly code: ConfigureErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ConfigureErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConfigureError';
    this.code = code;
    this.details = details;
  }
}

type EntryRecord = Record<string, unknown>;

export type ConfigureOperation = {
  path: string;
  before?: unknown;
  after?: unknown;
};

export type ConfigureFinding = {
  kind: 'STALE' | 'TEST' | 'AMBIGUOUS';
  server: string;
  reason: string;
};

export type RepositoryBindingDiagnostic = {
  invocation_cwd: string;
  host_cwd_repository: string | null;
  bound_repository: string;
  binding_source: RepositorySource;
  matches_host_cwd: boolean | null;
  warning: string | null;
};

export type ConfigurePlan = {
  host: ConfigureHost;
  config_path: string;
  config_exists: boolean;
  intended_entry: {
    server: 'engineering-mcp';
    command: string;
    args: string[];
  };
  operations: {
    add: ConfigureOperation[];
    change: ConfigureOperation[];
    remove: ConfigureOperation[];
  };
  stale_or_test_entries: ConfigureFinding[];
  repository_binding: RepositoryBindingDiagnostic;
  safe_to_apply: boolean;
  no_change: boolean;
  verification: {
    doctor_command: string;
    connection_checks: string[];
  };
};

export type PreparedConfigure = {
  plan: ConfigurePlan;
  expectedSourceHash: string | null;
  proposedContent: string;
  proposedContentHash: string;
  preparedAt: string;
  createParentOnApply: boolean;
};

export type ConfigureFileIdentity = {
  device: string;
  inode: string;
  mode: number;
  size: string;
  mtime_ns: string;
  ctime_ns: string;
  birthtime_ns: string;
};

export type ConfigureTargetIdentity =
  | { state: 'PRESENT'; file: ConfigureFileIdentity }
  | {
      state: 'MISSING';
      parent_path: string;
      parent: ConfigureFileIdentity | null;
    };

type ConfigureHardLinkKind = 'CAPABILITY_CHECK' | 'INSTALL' | 'RESTORE_CAPTURED_EXTERNAL';

export type ConfigureApplyHooks = {
  afterProposedPrepared?: (context: { configPath: string; proposedPath: string }) => void;
  beforeCapture?: (context: { configPath: string; proposedPath: string }) => void;
  afterCapture?: (context: { configPath: string; backupPath: string; proposedPath: string }) => void;
  beforeInstall?: (context: { configPath: string; backupPath: string | null; proposedPath: string }) => void;
  afterInstall?: (context: { configPath: string; backupPath: string | null; proposedPath: string }) => void;
  afterAuthorizationApplied?: (context: { sourcePath: string; proposedPath: string }) => void;
  beforeHardLink?: (context: {
    kind: ConfigureHardLinkKind;
    sourcePath: string;
    targetPath: string;
  }) => void;
  observeWindowsAuthorization?: (context: {
    path: string;
    actual: Omit<ConfigureAuthorizationEvidence, 'fingerprint'>;
  }) => Omit<ConfigureAuthorizationEvidence, 'fingerprint'>;
};

export type ConfigureApplyResult = {
  ok: true;
  mode: 'APPLIED' | 'NO_CHANGE' | 'ALREADY_APPLIED';
  changed: boolean;
  backup_path: string | null;
  proposed_path: string | null;
  retained_artifacts: string[];
  artifacts: ConfigureTransactionArtifact[];
  config_path: string;
  plan: ConfigurePlan;
  verification: ConfigurePlan['verification'];
};

export type ConfigureTransactionArtifact = {
  path: string;
  hash: string;
  classification: 'SOURCE' | 'PROPOSED' | 'EXTERNAL';
  kind: 'PROPOSED' | 'BACKUP';
  identity: ConfigureFileIdentity;
  authorization?: ConfigureAuthorizationEvidence | null;
};

export type ConfigureAuthorizationEvidence = {
  fingerprint: string;
  owner_sddl: string;
  dacl_sddl: string;
  combined_sddl: string;
  owner_sid: string | null;
  dacl_present: boolean;
  dacl_binary_base64: string | null;
  access_rules_protected: boolean;
};

export type ConfigurePlanIdentity = {
  identity: string;
  plan: ConfigurePlan;
  trust_model: string;
};

export type ConfigurePlanAssertions = {
  host?: ConfigureHost;
  repo?: string;
  configPath?: string;
  command?: string;
  cwd?: string;
  hooks?: ConfigureApplyHooks;
};

type ImmutablePlanPayload = {
  version: typeof CONFIGURE_PLAN_VERSION;
  plan_id: string;
  plan: ConfigurePlan;
  source_state: 'PRESENT' | 'MISSING';
  expected_source_hash: string | null;
  proposed_content_hash: string;
  previewed_at: string;
  create_parent_on_apply: boolean;
};

const SERVER_NAME = 'engineering-mcp' as const;
const ENTRY_PATH = 'mcp_servers.engineering-mcp';
const CONFIGURE_PLAN_VERSION = 2 as const;
const PLAN_TOKEN_PREFIX = 'ecp2';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileIdentityFromStat(stat: BigIntStats): ConfigureFileIdentity {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode),
    size: String(stat.size),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
    birthtime_ns: String(stat.birthtimeNs),
  };
}

function sameFileIdentity(left: ConfigureFileIdentity, right: ConfigureFileIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function captureConfigureTargetIdentity(path: string): ConfigureTargetIdentity {
  if (existsSync(path)) {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ConfigureError('CONFIGURE_UNSAFE_FILE', 'Configuration target is not a regular file', {
        config_path: path,
      });
    }
    return { state: 'PRESENT', file: fileIdentityFromStat(stat) };
  }
  const parentPath = dirname(path);
  if (!existsSync(parentPath)) return { state: 'MISSING', parent_path: parentPath, parent: null };
  const parentStat = lstatSync(parentPath, { bigint: true });
  if (!parentStat.isDirectory()) {
    throw new ConfigureError('CONFIGURE_PATH_INVALID', 'Configuration parent path is not a directory', {
      config_path: path,
      parent: parentPath,
    });
  }
  return { state: 'MISSING', parent_path: parentPath, parent: fileIdentityFromStat(parentStat) };
}

type RecognizedLauncher = {
  kind: 'DIRECT' | 'NODE';
  prefix_args: string[];
  server_args: string[];
};

function commandBasename(command: string): string {
  return basename(command.replaceAll('\\', '/')).toLowerCase();
}

function optionValue(args: readonly string[], option: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === option) return args[index + 1] ?? null;
    if (token.startsWith(`${option}=`)) return token.slice(option.length + 1) || null;
  }
  return null;
}

function hasOnlyRecognizedServerOptions(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const equals = /^(--(?:role|repo|db|worker-profiles))=(.+)$/s.exec(token);
    if (equals) continue;
    if (!['--role', '--repo', '--db', '--worker-profiles'].includes(token)) return false;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) return false;
    index += 1;
  }
  return true;
}

function canonicalNodeLauncher(scriptArgument: string): string | null {
  if (!isAbsolute(scriptArgument)) return null;
  let scriptPath: string;
  try {
    scriptPath = realpathSync(resolve(scriptArgument));
    const scriptStat = lstatSync(scriptPath);
    if (!scriptStat.isFile()) return null;
  } catch {
    return null;
  }
  const normalized = scriptPath.replaceAll('\\', '/');
  if (!/\/dist\/cli\.js$/i.test(normalized)) return null;
  const packageRoot = dirname(dirname(scriptPath));
  const manifestPath = join(packageRoot, 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(manifest) || manifest.name !== 'engineering-mcp-cli' || !isRecord(manifest.bin)) return null;
  const binEntry = manifest.bin['engineering-mcp'];
  if (typeof binEntry !== 'string') return null;
  const normalizedBin = binEntry.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalizedBin !== 'dist/cli.js') return null;
  try {
    const declaredEntry = realpathSync(resolve(packageRoot, normalizedBin));
    const scriptIdentity = fileIdentityFromStat(lstatSync(scriptPath, { bigint: true }));
    const declaredIdentity = fileIdentityFromStat(lstatSync(declaredEntry, { bigint: true }));
    return samePhysicalFile(scriptIdentity, declaredIdentity) ? scriptPath : null;
  } catch {
    return null;
  }
}

function recognizeEngineeringMcpLauncher(entry: EntryRecord): RecognizedLauncher | null {
  if (typeof entry.command !== 'string') return null;
  const args = stringArray(entry.args);
  if (args === null) return null;
  const command = commandBasename(entry.command);
  if (/^engineering-mcp(?:\.(?:cmd|exe))?$/.test(command)) {
    return { kind: 'DIRECT', prefix_args: [], server_args: args };
  }
  if (!/^node(?:\.exe)?$/.test(command) || args.length === 0) return null;
  const serverArgs = args.slice(1);
  if (canonicalNodeLauncher(args[0]!) === null) return null;
  if (optionValue(serverArgs, '--role') !== 'owner' || !hasOnlyRecognizedServerOptions(serverArgs)) return null;
  return { kind: 'NODE', prefix_args: [args[0]!], server_args: serverArgs };
}

function isRecord(value: unknown): value is EntryRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function shellArgument(value: string): string {
  if (process.platform === 'win32') return `"${value}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseToml(text: string, path: string): EntryRecord {
  if (text.includes('\uFFFD')) {
    throw new ConfigureError(
      'CONFIGURE_MALFORMED',
      `Host configuration is not valid lossless UTF-8: ${path}`,
    );
  }
  try {
    const parsed = parse(text.replace(/^\uFEFF/, ''));
    if (!isRecord(parsed)) {
      throw new Error('TOML root is not a table');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigureError) throw error;
    throw new ConfigureError('CONFIGURE_MALFORMED', `Malformed TOML configuration: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function defaultConfigPath(host: ConfigureHost, home: string): string {
  return join(home, host === 'codex' ? '.codex' : '.grok', 'config.toml');
}

function validateConfigPath(path: string, allowMissingParent = false): void {
  if (!isAbsolute(path) || path.includes('\0') || /[\r\n]/.test(path)) {
    throw new ConfigureError('CONFIGURE_PATH_INVALID', 'Configuration path must be an absolute filesystem path', {
      config_path: path,
    });
  }
  const parent = dirname(path);
  if (!existsSync(parent)) {
    if (allowMissingParent && existsSync(dirname(parent)) && lstatSync(dirname(parent)).isDirectory()) return;
    throw new ConfigureError('CONFIGURE_PATH_INVALID', 'Configuration parent directory does not exist', {
      config_path: path,
      parent,
    });
  }
  if (!lstatSync(parent).isDirectory()) {
    throw new ConfigureError('CONFIGURE_PATH_INVALID', 'Configuration parent path is not a directory', {
      config_path: path,
      parent,
    });
  }
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ConfigureError(
        'CONFIGURE_UNSAFE_FILE',
        'Configuration target must be a regular file, not a symlink or special file',
        { config_path: path },
      );
    }
  }
}

function validateCommand(command: string): void {
  if (command.trim() !== command || command.length === 0 || command.includes('\0') || /[\r\n]/.test(command)) {
    throw new ConfigureError('CONFIGURE_USAGE', 'Configured command must be one non-empty command string');
  }
}

function findMarkerPath(value: unknown, marker: string, path: string[] = []): { path: string[]; array: boolean } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMarkerPath(item, marker, path);
      if (found) return { ...found, array: true };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value[marker] === true) return { path, array: false };
  for (const [key, child] of Object.entries(value)) {
    const found = findMarkerPath(child, marker, [...path, key]);
    if (found) return found;
  }
  return null;
}

type Header = { start: number; end: number; path: string[]; array: boolean };

function updateMultilineState(line: string, initial: 'basic' | 'literal' | null): 'basic' | 'literal' | null {
  let state = initial;
  let index = 0;
  while (index < line.length) {
    if (state === 'basic') {
      if (line.startsWith('"""', index)) {
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashCount += 1;
        if (slashCount % 2 === 0) {
          state = null;
          index += 3;
          continue;
        }
      }
      index += 1;
      continue;
    }
    if (state === 'literal') {
      if (line.startsWith("'''", index)) {
        state = null;
        index += 3;
        continue;
      }
      index += 1;
      continue;
    }
    if (line[index] === '#') break;
    if (line.startsWith('"""', index)) {
      state = 'basic';
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state = 'literal';
      index += 3;
      continue;
    }
    if (line[index] === '"') {
      index += 1;
      while (index < line.length) {
        if (line[index] === '\\') index += 2;
        else if (line[index++] === '"') break;
      }
      continue;
    }
    if (line[index] === "'") {
      const end = line.indexOf("'", index + 1);
      index = end < 0 ? line.length : end + 1;
      continue;
    }
    index += 1;
  }
  return state;
}

function scanHeaders(text: string): Header[] {
  const headers: Header[] = [];
  const marker = '__engineering_mcp_configure_probe_5a__';
  let state: 'basic' | 'literal' | null = null;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const lineEnd = newline < 0 ? text.length : newline;
    const rawLine = text.slice(start, lineEnd).replace(/\r$/, '');
    const line = start === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    if (state === null && line.trimStart().startsWith('[')) {
      try {
        const parsed = parse(`${line}\n${marker} = true\n`);
        const found = findMarkerPath(parsed, marker);
        if (found) headers.push({ start, end, path: found.path, array: found.array });
      } catch {
        // The complete-document parse reports malformed headers. Header-like text may also be a value.
      }
    }
    state = updateMultilineState(line, state);
    if (newline < 0) break;
    start = end;
  }
  return headers;
}

type Assignment = { start: number; end: number; prefix: string; suffix: string };

function assignmentForLine(text: string, start: number, end: number, key: 'command' | 'args'): Assignment | null {
  const raw = text.slice(start, end);
  const newlineMatch = /(?:\r?\n)$/.exec(raw);
  const newline = newlineMatch?.[0] ?? '';
  const line = newline ? raw.slice(0, -newline.length) : raw;
  const pattern = new RegExp(`^(\\s*(?:${key}|"${key}"|'${key}')\\s*=\\s*)`);
  const match = pattern.exec(line);
  if (!match) return null;
  const valueStart = match[1]!.length;
  let quote: 'basic' | 'literal' | null = null;
  let square = 0;
  let curly = 0;
  let comment = -1;
  for (let index = valueStart; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === 'basic') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === 'literal') {
      if (char === "'") quote = null;
      continue;
    }
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      throw new ConfigureError('CONFIGURE_UNSUPPORTED', `Multiline ${key} values are not safely editable`);
    }
    if (char === '"') quote = 'basic';
    else if (char === "'") quote = 'literal';
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '#' && square === 0 && curly === 0) {
      comment = index;
      break;
    }
  }
  if (quote !== null || square !== 0 || curly !== 0) {
    throw new ConfigureError('CONFIGURE_UNSUPPORTED', `Multiline ${key} values are not safely editable`);
  }
  const contentEnd = comment < 0 ? line.length : comment;
  let valueEnd = contentEnd;
  while (valueEnd > valueStart && /\s/.test(line[valueEnd - 1]!)) valueEnd -= 1;
  if (valueEnd === valueStart) {
    throw new ConfigureError('CONFIGURE_MALFORMED', `${key} has no value`);
  }
  return {
    start,
    end,
    prefix: line.slice(0, valueStart),
    suffix: line.slice(valueEnd) + newline,
  };
}

function renderOwnedEntry(text: string, desired: { command: string; args: string[] }, hasSemanticEntry: boolean): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const headers = scanHeaders(text);
  const owned = headers.filter((header) => !header.array && header.path.join('.') === ENTRY_PATH);
  if (owned.length > 1) {
    throw new ConfigureError('CONFIGURE_AMBIGUOUS', 'Multiple Engineering MCP table declarations are not safely editable');
  }
  if (owned.length === 0) {
    if (hasSemanticEntry) {
      throw new ConfigureError(
        'CONFIGURE_UNSUPPORTED',
        'Engineering MCP exists in an inline, dotted, array, or otherwise unsupported TOML form',
      );
    }
    const prefix = text.length === 0 ? '' : text.endsWith('\n') ? newline : `${newline}${newline}`;
    return `${text}${prefix}[mcp_servers.engineering-mcp]${newline}command = ${tomlString(desired.command)}${newline}args = ${tomlStringArray(desired.args)}${newline}`;
  }

  const header = owned[0]!;
  const headerIndex = headers.indexOf(header);
  const blockEnd = headers[headerIndex + 1]?.start ?? text.length;
  const assignments: Partial<Record<'command' | 'args', Assignment>> = {};
  let cursor = header.end;
  while (cursor < blockEnd) {
    const newlineIndex = text.indexOf('\n', cursor);
    const end = newlineIndex < 0 || newlineIndex >= blockEnd ? blockEnd : newlineIndex + 1;
    for (const key of ['command', 'args'] as const) {
      const assignment = assignmentForLine(text, cursor, end, key);
      if (assignment) {
        if (assignments[key]) {
          throw new ConfigureError('CONFIGURE_AMBIGUOUS', `Multiple ${key} assignments are not safely editable`);
        }
        assignments[key] = assignment;
      }
    }
    if (end <= cursor) break;
    cursor = end;
  }

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const key of ['command', 'args'] as const) {
    const assignment = assignments[key];
    const rendered = key === 'command' ? tomlString(desired.command) : tomlStringArray(desired.args);
    if (assignment) {
      replacements.push({
        start: assignment.start,
        end: assignment.end,
        value: `${assignment.prefix}${rendered}${assignment.suffix}`,
      });
    }
  }
  const missing = (['command', 'args'] as const).filter((key) => !assignments[key]);
  if (missing.length > 0) {
    const insertion = `${missing.map((key) => `${key} = ${key === 'command' ? tomlString(desired.command) : tomlStringArray(desired.args)}`).join(newline)}${newline}`;
    const needsNewline = header.end === blockEnd && blockEnd > 0 && !text.slice(0, blockEnd).endsWith('\n');
    replacements.push({ start: blockEnd, end: blockEnd, value: `${needsNewline ? newline : ''}${insertion}` });
  }
  replacements.sort((left, right) => right.start - left.start);
  let rendered = text;
  for (const replacement of replacements) {
    rendered = rendered.slice(0, replacement.start) + replacement.value + rendered.slice(replacement.end);
  }
  return rendered;
}

function mcpEntries(parsed: EntryRecord): Record<string, EntryRecord> {
  const value = parsed.mcp_servers;
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ConfigureError('CONFIGURE_UNSUPPORTED', 'mcp_servers must be a TOML table');
  }
  const entries: Record<string, EntryRecord> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new ConfigureError('CONFIGURE_UNSUPPORTED', `mcp_servers.${key} must be a TOML table`);
    }
    entries[key] = entry;
  }
  return entries;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null;
}

function referencesEngineeringMcp(key: string, entry: EntryRecord): boolean {
  return key === SERVER_NAME || recognizeEngineeringMcpLauncher(entry) !== null;
}

function hasTestSetupMarker(command: string, args: readonly string[]): boolean {
  const visible: string[] = [command];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--repo') {
      index += 1;
      continue;
    }
    if (token.startsWith('--repo=')) continue;
    visible.push(token);
  }
  return /(?:^|[\s\\/_\-.])(?:test|smoke|fixture|temp|tmp)(?:$|[\s\\/_\-.])/i.test(visible.join(' '));
}

function staleFindings(
  entries: Record<string, EntryRecord>,
  boundRepo: string,
  desired: { command: string; args: string[] },
): ConfigureFinding[] {
  const findings: ConfigureFinding[] = [];
  for (const [key, entry] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    if (!referencesEngineeringMcp(key, entry)) continue;
    if (key !== SERVER_NAME) {
      findings.push({
        kind: /(?:test|smoke|temp|tmp|fixture)/i.test(key) ? 'TEST' : 'AMBIGUOUS',
        server: key,
        reason: 'Additional Engineering MCP-like server entry requires explicit operator review',
      });
      continue;
    }
    const args = stringArray(entry.args);
    if (typeof entry.command !== 'string' || args === null) continue;
    const launcher = recognizeEngineeringMcpLauncher(entry);
    const serverArgs = launcher?.server_args ?? args;
    const configuredRepo = optionValue(serverArgs, '--repo') ?? undefined;
    if (!configuredRepo) {
      findings.push({ kind: 'STALE', server: key, reason: 'Existing entry does not explicitly pin its repository' });
    } else {
      let actualRepo: string | null = null;
      try {
        actualRepo = inspectRepo(configuredRepo).repoRoot;
      } catch {
        // A missing or non-Git target is itself a stale binding.
      }
      if (actualRepo !== boundRepo) {
        findings.push({ kind: 'STALE', server: key, reason: 'Existing entry is bound to a different or invalid repository' });
      }
    }
    if (hasTestSetupMarker(entry.command, args)) {
      findings.push({ kind: 'TEST', server: key, reason: 'Existing entry contains a test/smoke/fixture/temporary marker' });
    }
    if (entry.command !== desired.command || JSON.stringify(args) !== JSON.stringify(desired.args)) {
      findings.push({ kind: 'STALE', server: key, reason: 'Existing entry does not match the intended owner command and arguments' });
    }
  }
  return findings;
}

function mergeServerArgs(existing: string[] | null, boundRepo: string): string[] {
  if (existing === null) return ['--role', 'owner', '--repo', boundRepo];
  const auxiliary: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < existing.length; index += 1) {
    const token = existing[index]!;
    const equals = /^(--(?:role|repo|db|worker-profiles))=(.*)$/s.exec(token);
    const option = equals?.[1] ?? token;
    if (!['--role', '--repo', '--db', '--worker-profiles'].includes(option)) {
      throw new ConfigureError(
        'CONFIGURE_UNSUPPORTED',
        `Existing Engineering MCP args contain an unsupported token that cannot be preserved safely: ${token}`,
      );
    }
    if (seen.has(option)) {
      throw new ConfigureError('CONFIGURE_AMBIGUOUS', `Existing Engineering MCP args repeat ${option}`);
    }
    seen.add(option);
    if (equals) {
      if (equals[2]!.length === 0) {
        throw new ConfigureError('CONFIGURE_MALFORMED', `Existing Engineering MCP arg ${option} has no value`);
      }
      if (option === '--db' || option === '--worker-profiles') auxiliary.push(token);
      continue;
    }
    const value = existing[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ConfigureError('CONFIGURE_MALFORMED', `Existing Engineering MCP arg ${option} has no value`);
    }
    if (option === '--db' || option === '--worker-profiles') auxiliary.push(option, value);
    index += 1;
  }
  return ['--role', 'owner', '--repo', boundRepo, ...auxiliary];
}

function bindingDiagnostic(cwd: string, boundRepo: string, source: RepositorySource): RepositoryBindingDiagnostic {
  const invocationCwd = resolve(cwd);
  let hostRepo: string | null = null;
  try {
    hostRepo = resolveRepository({ cwd: invocationCwd }).repoRoot;
  } catch {
    // An invocation outside Git is reported, never substituted.
  }
  const matches = hostRepo === null ? null : hostRepo === boundRepo;
  let warning: string | null = null;
  if (hostRepo === null) {
    warning = 'Invocation cwd is not inside a Git repository; the generated entry explicitly pins the bound repository.';
  } else if (!matches) {
    warning = `Repository-binding mismatch: host cwd resolves to ${hostRepo}, while Engineering MCP will bind to ${boundRepo}.`;
  }
  return {
    invocation_cwd: invocationCwd,
    host_cwd_repository: hostRepo,
    bound_repository: boundRepo,
    binding_source: source,
    matches_host_cwd: matches,
    warning,
  };
}

function validateOwnedEntry(entry: EntryRecord | undefined): void {
  if (!entry) return;
  if (typeof entry.command !== 'string' || stringArray(entry.args) === null) {
    throw new ConfigureError(
      'CONFIGURE_MALFORMED',
      'Existing Engineering MCP entry must contain a string command and a string-array args value',
    );
  }
}

export function prepareConfigure(options: {
  host: ConfigureHost;
  configPath?: string;
  repo?: string;
  envRepo?: string;
  cwd?: string;
  home?: string;
  command?: string;
  now?: Date;
}): PreparedConfigure {
  if (options.host !== 'codex' && options.host !== 'grok') {
    throw new ConfigureError('CONFIGURE_USAGE', 'Supported configure hosts are codex and grok');
  }
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const configuredPath = options.configPath ?? defaultConfigPath(options.host, home);
  if (options.configPath && !isAbsolute(options.configPath)) {
    throw new ConfigureError('CONFIGURE_PATH_INVALID', '--config must be an absolute path');
  }
  const configPath = resolve(configuredPath);
  const createParentOnApply = options.configPath === undefined && !existsSync(dirname(configPath));
  validateConfigPath(configPath, createParentOnApply);
  const repository = resolveRepository({ arg: options.repo, envRepo: options.envRepo, cwd });
  const exists = existsSync(configPath);
  const source = exists ? readFileSync(configPath) : Buffer.alloc(0);
  const text = source.toString('utf8');
  const parsed = parseToml(text, configPath);
  const entries = mcpEntries(parsed);
  const owned = entries[SERVER_NAME];
  validateOwnedEntry(owned);
  const command = options.command ?? (owned?.command as string | undefined) ?? 'engineering-mcp';
  validateCommand(command);
  const ownedLauncher = owned && options.command === undefined ? recognizeEngineeringMcpLauncher(owned) : null;
  const existingServerArgs = ownedLauncher?.server_args ?? (owned ? stringArray(owned.args) : null);
  const desired = {
    command,
    args: [...(ownedLauncher?.prefix_args ?? []), ...mergeServerArgs(existingServerArgs, repository.repoRoot)],
  };
  const ambiguous = Object.entries(entries)
    .filter(([key, entry]) => key !== SERVER_NAME && referencesEngineeringMcp(key, entry))
    .map(([key]) => key)
    .sort();
  if (ambiguous.length > 0) {
    throw new ConfigureError(
      'CONFIGURE_AMBIGUOUS',
      'Additional Engineering MCP-like entries make automatic configuration ambiguous',
      { entries: ambiguous },
    );
  }
  const ownedArgs = owned ? stringArray(owned.args)! : null;
  const semanticNoChange =
    owned !== undefined && owned.command === desired.command && JSON.stringify(ownedArgs) === JSON.stringify(desired.args);
  const proposed = semanticNoChange ? text : renderOwnedEntry(text, desired, owned !== undefined);
  const reparsed = parseToml(proposed, configPath);
  const updatedEntries = mcpEntries(reparsed);
  const updated = updatedEntries[SERVER_NAME];
  if (!updated || updated.command !== desired.command || JSON.stringify(stringArray(updated.args)) !== JSON.stringify(desired.args)) {
    throw new ConfigureError('CONFIGURE_UNSUPPORTED', 'Rendered configuration did not produce the intended Engineering MCP entry');
  }
  const add: ConfigureOperation[] = [];
  const change: ConfigureOperation[] = [];
  if (!owned) {
    add.push({ path: ENTRY_PATH, after: { command: desired.command, args: desired.args } });
  } else {
    if (owned.command !== desired.command) {
      change.push({ path: `${ENTRY_PATH}.command`, before: owned.command, after: desired.command });
    }
    const oldArgs = stringArray(owned.args)!;
    if (JSON.stringify(oldArgs) !== JSON.stringify(desired.args)) {
      change.push({ path: `${ENTRY_PATH}.args`, before: oldArgs, after: desired.args });
    }
  }
  const repoDiagnostic = bindingDiagnostic(cwd, repository.repoRoot, repository.source);
  const findings = staleFindings(entries, repository.repoRoot, desired);
  const postApplyFindings = staleFindings(updatedEntries, repository.repoRoot, desired);
  const verification = {
    doctor_command: `engineering-mcp doctor --repo ${shellArgument(repository.repoRoot)}`,
    connection_checks: [
      `Restart ${options.host} so it reloads ${configPath}.`,
      'Run the doctor command and confirm repository.status is verified and repository.root equals bound_repository.',
      'Reconnect the MCP host and confirm Engineering MCP tools are discovered from the intended instance.',
    ],
  };
  const noChange = proposed === text;
  return {
    plan: {
      host: options.host,
      config_path: configPath,
      config_exists: exists,
      intended_entry: { server: SERVER_NAME, command: desired.command, args: desired.args },
      operations: { add, change, remove: [] },
      stale_or_test_entries: findings,
      repository_binding: repoDiagnostic,
      safe_to_apply: postApplyFindings.every((finding) => finding.kind !== 'TEST'),
      no_change: noChange,
      verification,
    },
    expectedSourceHash: exists ? sha256(source) : null,
    proposedContent: proposed,
    proposedContentHash: sha256(Buffer.from(proposed, 'utf8')),
    preparedAt: (options.now ?? new Date()).toISOString(),
    createParentOnApply,
  };
}

type CurrentTarget = {
  content: Buffer | null;
  identity: ConfigureTargetIdentity;
  hash: string | null;
};

function readCurrent(path: string): CurrentTarget {
  const identity = captureConfigureTargetIdentity(path);
  if (identity.state === 'MISSING') return { content: null, identity, hash: null };
  const descriptor = openSync(path, 'r');
  try {
    const openedIdentity = fileIdentityFromStat(fstatSync(descriptor, { bigint: true }));
    if (!sameFileIdentity(identity.file, openedIdentity)) {
      throw new ConfigureError('CONFIGURE_SOURCE_CHANGED', 'Configuration target identity changed while it was read', {
        config_path: path,
        before_identity: identity.file,
        opened_identity: openedIdentity,
      });
    }
    const content = readFileSync(descriptor);
    const finalIdentity = fileIdentityFromStat(fstatSync(descriptor, { bigint: true }));
    if (!sameFileIdentity(openedIdentity, finalIdentity)) {
      throw new ConfigureError('CONFIGURE_SOURCE_CHANGED', 'Configuration target changed while it was read', {
        config_path: path,
        opened_identity: openedIdentity,
        final_identity: finalIdentity,
      });
    }
    return { content, identity: { state: 'PRESENT', file: finalIdentity }, hash: sha256(content) };
  } finally {
    closeSync(descriptor);
  }
}

type OwnedFile = { path: string; identity: ConfigureFileIdentity; hash: string };

function writeExclusiveFile(path: string, content: Buffer | string, mode: number): OwnedFile {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    return { path, identity: fileIdentityFromStat(fstatSync(descriptor, { bigint: true })), hash: sha256(bytes) };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

type TransactionArtifacts = {
  proposed: OwnedFile[];
  backups: OwnedFile[];
};

type ClassifiedArtifact = ConfigureTransactionArtifact;
type ArtifactHashContext = Pick<PreparedConfigure, 'expectedSourceHash' | 'proposedContentHash'>;
type RecoveryContext = ArtifactHashContext & { configPath: string; planId: string };

function artifactPrefixes(configPath: string, planId: string): {
  proposed: string;
  backup: string;
  capability: string;
} {
  const name = basename(configPath);
  return {
    proposed: `.${name}.engineering-mcp.${planId}.proposed.`,
    backup: `${name}.engineering-mcp.${planId}.source.`,
    capability: `.${name}.engineering-mcp.${planId}.linkcheck.`,
  };
}

function readArtifact(path: string): OwnedFile {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ConfigureError(
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
      'A configure transaction artifact is not a regular file; no pathname was modified',
      { artifact_path: path },
    );
  }
  const descriptor = openSync(path, 'r');
  try {
    const opened = fileIdentityFromStat(fstatSync(descriptor, { bigint: true }));
    if (!samePhysicalFile(fileIdentityFromStat(before), opened)) {
      throw new ConfigureError(
        'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
        'A configure transaction artifact changed while it was opened; all paths were preserved',
        { artifact_path: path },
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fileIdentityFromStat(fstatSync(descriptor, { bigint: true }));
    if (!sameArtifactContentIdentity(opened, after)) {
      throw new ConfigureError(
        'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
        'A configure transaction artifact changed while it was read; all paths were preserved',
        { artifact_path: path },
      );
    }
    return { path, identity: after, hash: sha256(bytes) };
  } finally {
    closeSync(descriptor);
  }
}

function scanTransactionArtifacts(configPath: string, planId: string): TransactionArtifacts {
  const parent = dirname(configPath);
  const prefixes = artifactPrefixes(configPath, planId);
  const result: TransactionArtifacts = { proposed: [], backups: [] };
  if (!existsSync(parent)) return result;
  for (const name of readdirSync(parent).sort()) {
    const path = join(parent, name);
    if (name.startsWith(prefixes.proposed)) result.proposed.push(readArtifact(path));
    if (name.startsWith(prefixes.backup) && name.endsWith('.bak')) result.backups.push(readArtifact(path));
    // .linkcheck.* files are capability probes, not transaction artifacts.
    // Their presence, contents, authorization, and ordering must never affect recovery.
  }
  return result;
}

function retainedArtifacts(artifacts: TransactionArtifacts): string[] {
  return [...artifacts.proposed, ...artifacts.backups]
    .map((artifact) => artifact.path)
    .sort();
}

function classifyArtifact(
  artifact: OwnedFile,
  kind: ClassifiedArtifact['kind'],
  prepared: ArtifactHashContext,
): ClassifiedArtifact {
  const classification: ConfigureTransactionArtifact['classification'] =
    prepared.expectedSourceHash !== null && artifact.hash === prepared.expectedSourceHash
      ? 'SOURCE'
      : artifact.hash === prepared.proposedContentHash
        ? 'PROPOSED'
        : 'EXTERNAL';
  return { path: artifact.path, hash: artifact.hash, classification, kind, identity: artifact.identity };
}

function classifiedArtifacts(
  artifacts: TransactionArtifacts,
  prepared: ArtifactHashContext,
  includeAuthorization = false,
): ClassifiedArtifact[] {
  return [
    ...artifacts.proposed.map((artifact) => classifyArtifact(artifact, 'PROPOSED', prepared)),
    ...artifacts.backups.map((artifact) => classifyArtifact(artifact, 'BACKUP', prepared)),
  ].map((artifact) => ({
    ...artifact,
    ...(includeAuthorization ? { authorization: tryWindowsAuthorizationEvidence(artifact.path) } : {}),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function randomArtifactPath(configPath: string, prefix: string, suffix = ''): string {
  return join(dirname(configPath), `${prefix}${randomBytes(16).toString('hex')}${suffix}`);
}

function createProposedArtifact(prepared: PreparedConfigure, planId: string, mode: number): OwnedFile {
  const prefix = artifactPrefixes(prepared.plan.config_path, planId).proposed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = randomArtifactPath(prepared.plan.config_path, prefix);
    try {
      const artifact = writeExclusiveFile(path, prepared.proposedContent, mode & 0o777);
      if (artifact.hash !== prepared.proposedContentHash) {
        throw new ConfigureError('CONFIGURE_WRITE_FAILED', 'Prepared configure artifact has an unexpected hash', {
          proposed_path: path,
          expected_hash: prepared.proposedContentHash,
          actual_hash: artifact.hash,
        });
      }
      return artifact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if (error instanceof ConfigureError) throw error;
      throw new ConfigureError(
        'CONFIGURE_WRITE_FAILED',
        'Could not durably prepare the proposed configuration; any created artifact was retained',
        { proposed_path: path, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  throw new ConfigureError('CONFIGURE_WRITE_FAILED', 'Could not allocate a unique proposed transaction artifact');
}

function samePhysicalFile(left: ConfigureFileIdentity, right: ConfigureFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameArtifactContentIdentity(left: ConfigureFileIdentity, right: ConfigureFileIdentity): boolean {
  return (
    samePhysicalFile(left, right) &&
    left.size === right.size &&
    left.mtime_ns === right.mtime_ns
  );
}

function requireExpectedArtifacts(
  artifacts: TransactionArtifacts,
  prepared: PreparedConfigure,
  proposedHash: string,
  planId: string,
): { proposed: OwnedFile[] } {
  const invalidProposed = artifacts.proposed.filter((artifact) => artifact.hash !== proposedHash);
  if (invalidProposed.length > 0) {
    manualRecovery(
      'Configure transaction artifacts no longer match the immutable plan; all paths were preserved',
      prepared,
      planId,
      {
        invalid_proposed: invalidProposed.map((artifact) => ({ path: artifact.path, hash: artifact.hash })),
      },
    );
  }
  return { proposed: artifacts.proposed };
}

function createHardLink(
  kind: ConfigureHardLinkKind,
  sourcePath: string,
  targetPath: string,
  hooks: ConfigureApplyHooks,
): void {
  hooks.beforeHardLink?.({ kind, sourcePath, targetPath });
  linkSync(sourcePath, targetPath);
}

function ensureHardLinkCapability(
  prepared: PreparedConfigure,
  planId: string,
  proposed: OwnedFile,
  hooks: ConfigureApplyHooks,
): OwnedFile {
  if (process.platform === 'win32') {
    return ensureWindowsObjectBoundLinkCapability(prepared, planId, proposed, hooks);
  }
  const prefix = artifactPrefixes(prepared.plan.config_path, planId).capability;
  const token = randomBytes(16).toString('hex');
  const probeSourcePath = join(dirname(prepared.plan.config_path), `${prefix}${token}.source`);
  const probeLinkPath = join(dirname(prepared.plan.config_path), `${prefix}${token}.link`);
  try {
    const probeSource = writeExclusiveFile(
      probeSourcePath,
      prepared.proposedContent,
      proposed.identity.mode & 0o777,
    );
    createHardLink('CAPABILITY_CHECK', probeSource.path, probeLinkPath, hooks);
    const linked = readArtifact(probeLinkPath);
    if (
      !samePhysicalFile(probeSource.identity, linked.identity) ||
      samePhysicalFile(proposed.identity, linked.identity) ||
      linked.hash !== proposed.hash
    ) {
      throw new Error('hard-link capability check did not preserve isolated probe identity and bytes');
    }
    return linked;
  } catch (error) {
    throw new ConfigureError(
      'CONFIGURE_UNSUPPORTED',
      'The configuration filesystem cannot provide atomic create-if-absent installation; apply manually',
      {
        config_path: prepared.plan.config_path,
        proposed_path: proposed.path,
        capability_paths: [probeSourcePath, probeLinkPath],
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

type WindowsAuthorizationDescriptor = {
  owner_sddl: string;
  dacl_sddl: string;
  combined_sddl: string;
  owner_sid: string | null;
  dacl_present: boolean;
  dacl_binary_base64: string | null;
  access_rules_protected: boolean;
};

function windowsAuthorizationEvidence(descriptor: WindowsAuthorizationDescriptor): ConfigureAuthorizationEvidence {
  return {
    fingerprint: sha256(Buffer.from(JSON.stringify([
      descriptor.owner_sid,
      descriptor.dacl_present,
      descriptor.dacl_binary_base64,
      descriptor.access_rules_protected,
    ]), 'utf8')),
    ...descriptor,
  };
}

function tryWindowsAuthorizationEvidence(path: string): ConfigureAuthorizationEvidence | null {
  if (process.platform !== 'win32') return null;
  try {
    return windowsAuthorizationEvidence(readWindowsAuthorization(path));
  } catch {
    return null;
  }
}

function windowsPowerShellPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runWindowsPowerShell(script: string, environment: Record<string, string>): string {
  return execFileSync(
    windowsPowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  ).trim();
}

const WINDOWS_OBJECT_LINK_HELPER_CSHARP = String.raw`
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class EngineeringMcpConfigureObjectLink
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint READ_CONTROL = 0x00020000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const int SE_FILE_OBJECT = 1;
    private const int FileLinkInformation = 11;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_STATUS_BLOCK
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    public sealed class Result
    {
        public string device { get; set; }
        public string inode { get; set; }
        public string hash { get; set; }
        public string owner_sid { get; set; }
        public bool dacl_present { get; set; }
        public string dacl_binary_base64 { get; set; }
        public bool access_rules_protected { get; set; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string name,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        IntPtr handle,
        out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(
        IntPtr handle,
        int objectType,
        uint securityInformation,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("ntdll.dll")]
    private static extern int NtSetInformationFile(
        IntPtr fileHandle,
        out IO_STATUS_BLOCK ioStatusBlock,
        IntPtr fileInformation,
        uint length,
        int fileInformationClass);

    private static BY_HANDLE_FILE_INFORMATION GetIdentity(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle.DangerousGetHandle(), out information))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return information;
    }

    private static ulong FileIndex(BY_HANDLE_FILE_INFORMATION information)
    {
        return ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
    }

    private static void ReadAuthorization(
        SafeFileHandle handle,
        out string ownerSid,
        out bool daclPresent,
        out string daclBinaryBase64,
        out bool accessRulesProtected)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint status = GetSecurityInfo(
            handle.DangerousGetHandle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            out owner,
            out group,
            out dacl,
            out sacl,
            out descriptor);
        if (status != 0) throw new System.ComponentModel.Win32Exception((int)status);
        try
        {
            uint length = GetSecurityDescriptorLength(descriptor);
            byte[] bytes = new byte[length];
            Marshal.Copy(descriptor, bytes, 0, checked((int)length));
            RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
            ownerSid = raw.Owner == null ? null : raw.Owner.Value;
            daclPresent = raw.DiscretionaryAcl != null;
            if (daclPresent)
            {
                byte[] daclBytes = new byte[raw.DiscretionaryAcl.BinaryLength];
                raw.DiscretionaryAcl.GetBinaryForm(daclBytes, 0);
                daclBinaryBase64 = Convert.ToBase64String(daclBytes);
            }
            else
            {
                daclBinaryBase64 = null;
            }
            accessRulesProtected = (raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0;
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static string ComputeHash(FileStream stream)
    {
        stream.Position = 0;
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(stream);
            stream.Position = 0;
            return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
        }
    }

    private static void Verify(
        SafeFileHandle handle,
        FileStream stream,
        ulong expectedDevice,
        ulong expectedInode,
        string expectedHash,
        string expectedOwnerSid,
        bool expectedDaclPresent,
        string expectedDaclBinaryBase64,
        bool expectedAccessRulesProtected)
    {
        BY_HANDLE_FILE_INFORMATION identity = GetIdentity(handle);
        if (identity.VolumeSerialNumber != expectedDevice || FileIndex(identity) != expectedInode)
            throw new InvalidOperationException("proposal physical identity changed before object-bound installation");
        string actualHash = ComputeHash(stream);
        if (!String.Equals(actualHash, expectedHash, StringComparison.Ordinal))
            throw new InvalidOperationException("proposal SHA-256 changed before object-bound installation");
        string actualOwnerSid;
        bool actualDaclPresent;
        string actualDaclBinaryBase64;
        bool actualAccessRulesProtected;
        ReadAuthorization(
            handle,
            out actualOwnerSid,
            out actualDaclPresent,
            out actualDaclBinaryBase64,
            out actualAccessRulesProtected);
        if (!String.Equals(actualOwnerSid, expectedOwnerSid, StringComparison.Ordinal))
            throw new InvalidOperationException("proposal Owner changed before object-bound installation");
        if (actualDaclPresent != expectedDaclPresent ||
            !String.Equals(actualDaclBinaryBase64, expectedDaclBinaryBase64, StringComparison.Ordinal))
            throw new InvalidOperationException("proposal DACL semantics changed before object-bound installation");
        if (actualAccessRulesProtected != expectedAccessRulesProtected)
            throw new InvalidOperationException("proposal DACL protection or inheritance state changed before object-bound installation");
    }

    private static void CreateLinkFromHandle(SafeFileHandle source, SafeFileHandle targetDirectory, string targetName)
    {
        byte[] name = System.Text.Encoding.Unicode.GetBytes(targetName);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        int size = checked(nameOffset + name.Length);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteIntPtr(buffer, rootOffset, targetDirectory.DangerousGetHandle());
            Marshal.WriteInt32(buffer, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            IO_STATUS_BLOCK io;
            int status = NtSetInformationFile(
                source.DangerousGetHandle(),
                out io,
                buffer,
                checked((uint)size),
                FileLinkInformation);
            if (status != 0)
                throw new InvalidOperationException("NtSetInformationFile(FileLinkInformation) failed with NTSTATUS 0x" + unchecked((uint)status).ToString("X8"));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static Result VerifyAndLink(
        string proposalPath,
        string targetDirectoryPath,
        string targetName,
        string expectedHash,
        string expectedDeviceText,
        string expectedInodeText,
        string expectedOwnerSidText,
        bool expectedDaclPresent,
        string expectedDaclBinaryBase64Text,
        bool expectedAccessRulesProtected)
    {
        ulong expectedDevice = UInt64.Parse(expectedDeviceText, System.Globalization.CultureInfo.InvariantCulture);
        ulong expectedInode = UInt64.Parse(expectedInodeText, System.Globalization.CultureInfo.InvariantCulture);
        string expectedOwnerSid = expectedOwnerSidText.Length == 0 ? null : expectedOwnerSidText;
        string expectedDaclBinaryBase64 = expectedDaclBinaryBase64Text.Length == 0 ? null : expectedDaclBinaryBase64Text;
        using (SafeFileHandle source = CreateFileW(
            proposalPath,
            GENERIC_READ | READ_CONTROL | SYNCHRONIZE,
            0,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero))
        {
            if (source.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            using (FileStream stream = new FileStream(source, FileAccess.Read, 4096, false))
            using (SafeFileHandle targetDirectory = CreateFileW(
                targetDirectoryPath,
                FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                IntPtr.Zero))
            {
                if (targetDirectory.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                Verify(source, stream, expectedDevice, expectedInode, expectedHash, expectedOwnerSid, expectedDaclPresent, expectedDaclBinaryBase64, expectedAccessRulesProtected);
                Verify(source, stream, expectedDevice, expectedInode, expectedHash, expectedOwnerSid, expectedDaclPresent, expectedDaclBinaryBase64, expectedAccessRulesProtected);
                CreateLinkFromHandle(source, targetDirectory, targetName);
                Verify(source, stream, expectedDevice, expectedInode, expectedHash, expectedOwnerSid, expectedDaclPresent, expectedDaclBinaryBase64, expectedAccessRulesProtected);
                BY_HANDLE_FILE_INFORMATION finalIdentity = GetIdentity(source);
                return new Result
                {
                    device = finalIdentity.VolumeSerialNumber.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    inode = FileIndex(finalIdentity).ToString(System.Globalization.CultureInfo.InvariantCulture),
                    hash = expectedHash,
                    owner_sid = expectedOwnerSid,
                    dacl_present = expectedDaclPresent,
                    dacl_binary_base64 = expectedDaclBinaryBase64,
                    access_rules_protected = expectedAccessRulesProtected
                };
            }
        }
    }
}
`;

type WindowsObjectBoundLinkResult = {
  device: string;
  inode: string;
  hash: string;
  owner_sid: string | null;
  dacl_present: boolean;
  dacl_binary_base64: string | null;
  access_rules_protected: boolean;
};

function createWindowsObjectBoundLink(
  kind: ConfigureHardLinkKind,
  source: OwnedFile,
  targetPath: string,
  expectedAuthorization: WindowsAuthorizationDescriptor,
  hooks: ConfigureApplyHooks,
): void {
  hooks.beforeHardLink?.({ kind, sourcePath: source.path, targetPath });
  const script = [
    "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_SOURCE','Process')))",
    'Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop',
    "$proposal=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_PROPOSAL','Process')",
    "$targetDirectory=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_TARGET_DIRECTORY','Process')",
    "$targetName=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_TARGET_NAME','Process')",
    "$expectedHash=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_HASH','Process')",
    "$expectedDevice=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_DEVICE','Process')",
    "$expectedInode=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_INODE','Process')",
    "$ownerSid=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_OWNER_SID','Process')",
    "$daclPresent=[bool]::Parse([Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_DACL_PRESENT','Process'))",
    "$daclBinary=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_DACL_BINARY','Process')",
    "$protected=[bool]::Parse([Environment]::GetEnvironmentVariable('ENGINEERING_MCP_OBJECT_LINK_PROTECTED','Process'))",
    '[EngineeringMcpConfigureObjectLink]::VerifyAndLink($proposal,$targetDirectory,$targetName,$expectedHash,$expectedDevice,$expectedInode,$ownerSid,$daclPresent,$daclBinary,$protected)|ConvertTo-Json -Compress',
  ].join(';');
  const output = runWindowsPowerShell(script, {
    ENGINEERING_MCP_OBJECT_LINK_SOURCE: Buffer.from(WINDOWS_OBJECT_LINK_HELPER_CSHARP, 'utf8').toString('base64'),
    ENGINEERING_MCP_OBJECT_LINK_PROPOSAL: source.path,
    ENGINEERING_MCP_OBJECT_LINK_TARGET_DIRECTORY: dirname(targetPath),
    ENGINEERING_MCP_OBJECT_LINK_TARGET_NAME: basename(targetPath),
    ENGINEERING_MCP_OBJECT_LINK_HASH: source.hash,
    ENGINEERING_MCP_OBJECT_LINK_DEVICE: source.identity.device,
    ENGINEERING_MCP_OBJECT_LINK_INODE: source.identity.inode,
    ENGINEERING_MCP_OBJECT_LINK_OWNER_SID: expectedAuthorization.owner_sid ?? '',
    ENGINEERING_MCP_OBJECT_LINK_DACL_PRESENT: String(expectedAuthorization.dacl_present),
    ENGINEERING_MCP_OBJECT_LINK_DACL_BINARY: expectedAuthorization.dacl_binary_base64 ?? '',
    ENGINEERING_MCP_OBJECT_LINK_PROTECTED: String(expectedAuthorization.access_rules_protected),
  });
  const result = JSON.parse(output) as WindowsObjectBoundLinkResult;
  if (
    result.device !== source.identity.device ||
    result.inode !== source.identity.inode ||
    result.hash !== source.hash ||
    result.owner_sid !== expectedAuthorization.owner_sid ||
    result.dacl_present !== expectedAuthorization.dacl_present ||
    result.dacl_binary_base64 !== expectedAuthorization.dacl_binary_base64 ||
    result.access_rules_protected !== expectedAuthorization.access_rules_protected
  ) {
    throw new Error('Windows object-bound installation returned inconsistent verification evidence');
  }
}

function applyWindowsAuthorization(path: string, authorization: WindowsAuthorizationDescriptor): void {
  const encoded = Buffer.from(authorization.combined_sddl, 'utf8').toString('base64');
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_ACL_PATH','Process')",
    "$encoded=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_ACL_SDDL','Process')",
    '$sddl=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))',
    '$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access',
    '$acl=New-Object System.Security.AccessControl.FileSecurity',
    '$acl.SetSecurityDescriptorSddlForm($sddl,$sections)',
    '[System.IO.File]::SetAccessControl($path,$acl)',
  ].join(';');
  runWindowsPowerShell(script, {
    ENGINEERING_MCP_ACL_PATH: path,
    ENGINEERING_MCP_ACL_SDDL: encoded,
  });
}

function ensureWindowsObjectBoundLinkCapability(
  prepared: PreparedConfigure,
  planId: string,
  proposed: OwnedFile,
  hooks: ConfigureApplyHooks,
): OwnedFile {
  const prefix = artifactPrefixes(prepared.plan.config_path, planId).capability;
  const token = randomBytes(16).toString('hex');
  const probeSourceAPath = join(dirname(prepared.plan.config_path), `${prefix}${token}.source-a`);
  const probeSourceBPath = join(dirname(prepared.plan.config_path), `${prefix}${token}.source-b`);
  const probeLinkPath = join(dirname(prepared.plan.config_path), `${prefix}${token}.link`);
  try {
    const expectedAuthorization = readWindowsAuthorization(proposed.path);
    let probeSourceA = writeExclusiveFile(probeSourceAPath, prepared.proposedContent, proposed.identity.mode & 0o777);
    let probeSourceB = writeExclusiveFile(probeSourceBPath, prepared.proposedContent, proposed.identity.mode & 0o777);
    applyWindowsAuthorization(probeSourceA.path, expectedAuthorization);
    applyWindowsAuthorization(probeSourceB.path, expectedAuthorization);
    probeSourceA = readArtifact(probeSourceA.path);
    probeSourceB = readArtifact(probeSourceB.path);
    requireWindowsAuthorization(probeSourceA.path, expectedAuthorization, 'PRE_CAPTURE');
    requireWindowsAuthorization(probeSourceB.path, expectedAuthorization, 'PRE_CAPTURE');
    if (samePhysicalFile(probeSourceA.identity, probeSourceB.identity)) {
      throw new Error('native capability probe sources did not have distinct physical identities');
    }

    createWindowsObjectBoundLink(
      'CAPABILITY_CHECK',
      probeSourceA,
      probeLinkPath,
      expectedAuthorization,
      hooks,
    );
    let linked = readArtifact(probeLinkPath);
    requireWindowsAuthorization(linked.path, expectedAuthorization, 'PRE_CAPTURE');
    if (!samePhysicalFile(probeSourceA.identity, linked.identity) || linked.hash !== proposed.hash) {
      throw new Error('native object-bound capability check did not preserve file identity and bytes');
    }

    let occupiedTargetRejected = false;
    try {
      createWindowsObjectBoundLink(
        'CAPABILITY_CHECK',
        probeSourceB,
        probeLinkPath,
        expectedAuthorization,
        hooks,
      );
    } catch {
      occupiedTargetRejected = true;
    }
    if (!occupiedTargetRejected) {
      throw new Error('native object-bound capability check replaced an occupied target');
    }
    linked = readArtifact(probeLinkPath);
    requireWindowsAuthorization(linked.path, expectedAuthorization, 'PRE_CAPTURE');
    if (
      !samePhysicalFile(probeSourceA.identity, linked.identity) ||
      samePhysicalFile(probeSourceB.identity, linked.identity) ||
      linked.hash !== proposed.hash
    ) {
      throw new Error('native object-bound capability check altered an occupied target');
    }
    return linked;
  } catch (error) {
    throw new ConfigureError(
      'CONFIGURE_UNSUPPORTED',
      'The Windows configuration volume cannot provide verified object-bound create-if-absent installation; apply manually',
      {
        config_path: prepared.plan.config_path,
        proposed_path: proposed.path,
        capability_paths: [probeSourceAPath, probeSourceBPath, probeLinkPath],
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function parseAuthorizationDescriptor(output: string, path: string): WindowsAuthorizationDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`Windows security descriptor output was not valid JSON for ${path}`);
  }
  if (
    !isRecord(value) ||
    typeof value.owner_sddl !== 'string' ||
    typeof value.dacl_sddl !== 'string' ||
    typeof value.combined_sddl !== 'string' ||
    (value.owner_sid !== null && typeof value.owner_sid !== 'string') ||
    typeof value.dacl_present !== 'boolean' ||
    (value.dacl_binary_base64 !== null && typeof value.dacl_binary_base64 !== 'string') ||
    value.dacl_present !== (value.dacl_binary_base64 !== null) ||
    typeof value.access_rules_protected !== 'boolean'
  ) {
    throw new Error(`Windows security descriptor output was incomplete for ${path}`);
  }
  return value as WindowsAuthorizationDescriptor;
}

function readWindowsAuthorization(path: string): WindowsAuthorizationDescriptor {
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_ACL_PATH','Process')",
    '$owner=[System.Security.AccessControl.AccessControlSections]::Owner',
    '$access=[System.Security.AccessControl.AccessControlSections]::Access',
    '$combined=$owner -bor $access',
    '$acl=[System.IO.File]::GetAccessControl($path,$combined)',
    '$raw=New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(),0)',
    '$ownerSid=$null;if($null -ne $raw.Owner){$ownerSid=$raw.Owner.Value}',
    '$daclPresent=$null -ne $raw.DiscretionaryAcl',
    '$daclBinary=$null;if($daclPresent){$daclBytes=New-Object byte[] $raw.DiscretionaryAcl.BinaryLength;$raw.DiscretionaryAcl.GetBinaryForm($daclBytes,0);$daclBinary=[Convert]::ToBase64String($daclBytes)}',
    '[pscustomobject]@{owner_sddl=$acl.GetSecurityDescriptorSddlForm($owner);dacl_sddl=$acl.GetSecurityDescriptorSddlForm($access);combined_sddl=$acl.GetSecurityDescriptorSddlForm($combined);owner_sid=$ownerSid;dacl_present=$daclPresent;dacl_binary_base64=$daclBinary;access_rules_protected=$acl.AreAccessRulesProtected}|ConvertTo-Json -Compress',
  ].join(';');
  return parseAuthorizationDescriptor(runWindowsPowerShell(script, { ENGINEERING_MCP_ACL_PATH: path }), path);
}

function sameWindowsAuthorization(
  left: WindowsAuthorizationDescriptor,
  right: WindowsAuthorizationDescriptor,
): boolean {
  return (
    left.owner_sid === right.owner_sid &&
    left.dacl_present === right.dacl_present &&
    left.dacl_binary_base64 === right.dacl_binary_base64 &&
    left.access_rules_protected === right.access_rules_protected
  );
}

function requireWindowsAuthorization(
  path: string,
  expected: WindowsAuthorizationDescriptor,
  context: 'PRE_CAPTURE' | 'POST_CAPTURE',
): void {
  const actual = readWindowsAuthorization(path);
  if (!sameWindowsAuthorization(expected, actual)) {
    throw new ConfigureError(
      'CONFIGURE_SECURITY_PRESERVATION_FAILED',
      context === 'PRE_CAPTURE'
        ? 'Windows Owner and DACL verification failed before target capture'
        : 'Windows Owner and DACL verification failed after target capture; retained paths require manual recovery',
      { path, context, expected, actual },
    );
  }
}

function preserveWindowsAuthorization(
  sourcePath: string,
  proposedPath: string,
  hooks: ConfigureApplyHooks,
  expectedSource?: WindowsAuthorizationDescriptor,
): WindowsAuthorizationDescriptor | null {
  if (process.platform !== 'win32') return null;
  try {
    const source = expectedSource ?? readWindowsAuthorization(sourcePath);
    if (expectedSource !== undefined) requireWindowsAuthorization(sourcePath, expectedSource, 'POST_CAPTURE');
    applyWindowsAuthorization(proposedPath, source);
    hooks.afterAuthorizationApplied?.({ sourcePath, proposedPath });
    requireWindowsAuthorization(proposedPath, source, 'PRE_CAPTURE');
    return source;
  } catch (error) {
    if (error instanceof ConfigureError && error.code === 'CONFIGURE_SECURITY_PRESERVATION_FAILED') throw error;
    throw new ConfigureError(
      'CONFIGURE_SECURITY_PRESERVATION_FAILED',
      'Windows Owner and DACL could not be copied and verified; target capture was refused',
      {
        source_path: sourcePath,
        proposed_path: proposedPath,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

type SourceAuthorizationConsensus = {
  source: OwnedFile;
  descriptor: WindowsAuthorizationDescriptor | null;
  evidence: ConfigureAuthorizationEvidence | null;
};

function requireSourceAuthorizationConsensus(
  sourceBackups: readonly OwnedFile[],
  context: RecoveryContext,
  hooks: ConfigureApplyHooks = {},
): SourceAuthorizationConsensus | null {
  if (sourceBackups.length === 0) return null;
  if (process.platform !== 'win32') {
    return { source: sourceBackups[0]!, descriptor: null, evidence: null };
  }
  const observed = sourceBackups.map((source) => {
    try {
      const actual = readWindowsAuthorization(source.path);
      const descriptor = hooks.observeWindowsAuthorization?.({ path: source.path, actual }) ?? actual;
      return { source, descriptor, evidence: windowsAuthorizationEvidence(descriptor) };
    } catch (error) {
      throwManualRecovery(
        'A SOURCE artifact authorization descriptor could not be read; authorization provenance is ambiguous',
        context,
        {
          unreadable_source_artifact: source.path,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  });
  const expected = observed[0]!;
  const disagreement = observed.some((item) => !sameWindowsAuthorization(expected.descriptor, item.descriptor));
  if (disagreement) {
    throwManualRecovery(
      'Byte-identical SOURCE artifacts have divergent Windows Owner or DACL authorization; no source was selected',
      context,
      {
        conflicting_source_authorizations: observed
          .map((item) => ({
            path: item.source.path,
            hash: item.source.hash,
            identity: item.source.identity,
            authorization: item.evidence,
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      },
    );
  }
  return expected;
}

function captureTargetNoOverwrite(configPath: string, backupPath: string): void {
  if (process.platform !== 'win32') {
    throw new ConfigureError(
      'CONFIGURE_UNSUPPORTED',
      'Existing configuration capture requires Windows same-volume no-overwrite move semantics; apply manually',
      { config_path: configPath, backup_path: backupPath },
    );
  }
  const script = [
    "$source=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_CAPTURE_SOURCE','Process')",
    "$destination=[Environment]::GetEnvironmentVariable('ENGINEERING_MCP_CAPTURE_DESTINATION','Process')",
    '[System.IO.File]::Move($source,$destination)',
  ].join(';');
  runWindowsPowerShell(script, {
      ENGINEERING_MCP_CAPTURE_SOURCE: configPath,
      ENGINEERING_MCP_CAPTURE_DESTINATION: backupPath,
  });
}

function throwManualRecovery(
  message: string,
  context: RecoveryContext,
  details: Record<string, unknown> = {},
): never {
  let current: Record<string, unknown>;
  try {
    const target = readCurrent(context.configPath);
    current = { state: target.identity.state, hash: target.hash, identity: target.identity };
  } catch (error) {
    current = { read_error: error instanceof Error ? error.message : String(error) };
  }
  let artifacts: string[] = [];
  let artifactDetails: ClassifiedArtifact[] = [];
  try {
    const scanned = scanTransactionArtifacts(context.configPath, context.planId);
    artifacts = retainedArtifacts(scanned);
    artifactDetails = classifiedArtifacts(scanned, context, true);
  } catch {
    // The primary error already carries the unsafe artifact path.
  }
  throw new ConfigureError('CONFIGURE_MANUAL_RECOVERY_REQUIRED', message, {
    config_path: context.configPath,
    plan_id: context.planId,
    expected_source_hash: context.expectedSourceHash,
    proposed_hash: context.proposedContentHash,
    current_target: current,
    retained_artifacts: artifacts,
    artifacts: artifactDetails,
    ...details,
  });
}

function manualRecovery(
  message: string,
  prepared: PreparedConfigure,
  planId: string,
  details: Record<string, unknown> = {},
): never {
  return throwManualRecovery(
    message,
    {
      configPath: prepared.plan.config_path,
      planId,
      expectedSourceHash: prepared.expectedSourceHash,
      proposedContentHash: prepared.proposedContentHash,
    },
    details,
  );
}

function validateInstalledSemantics(prepared: PreparedConfigure, path: string): void {
  const written = readCurrent(path);
  if (written.identity.state !== 'PRESENT' || written.hash !== prepared.proposedContentHash || written.content === null) {
    throw new Error('installed target does not match the proposed content hash');
  }
  const parsed = parseToml(written.content.toString('utf8'), path);
  const entry = mcpEntries(parsed)[SERVER_NAME];
  if (
    !entry ||
    entry.command !== prepared.plan.intended_entry.command ||
    JSON.stringify(stringArray(entry.args)) !== JSON.stringify(prepared.plan.intended_entry.args)
  ) {
    throw new Error('installed target does not match the intended Engineering MCP entry');
  }
}

function noChangeResult(prepared: PreparedConfigure): ConfigureApplyResult {
  return {
    ok: true,
    mode: 'NO_CHANGE',
    changed: false,
    backup_path: null,
    proposed_path: null,
    retained_artifacts: [],
    artifacts: [],
    config_path: prepared.plan.config_path,
    plan: prepared.plan,
    verification: prepared.plan.verification,
  };
}

function completedResult(
  prepared: PreparedConfigure,
  artifacts: TransactionArtifacts,
  mode: 'APPLIED' | 'ALREADY_APPLIED',
  backupPath: string | null,
  proposedPath: string,
): ConfigureApplyResult {
  return {
    ok: true,
    mode,
    changed: mode === 'APPLIED',
    backup_path: backupPath,
    proposed_path: proposedPath,
    retained_artifacts: retainedArtifacts(artifacts),
    artifacts: classifiedArtifacts(artifacts, prepared),
    config_path: prepared.plan.config_path,
    plan: prepared.plan,
    verification: prepared.plan.verification,
  };
}

function requireInstalledAuthorization(
  expected: WindowsAuthorizationDescriptor | null,
  installedPath: string,
  prepared: PreparedConfigure,
  planId: string,
): void {
  if (expected === null || process.platform !== 'win32') return;
  try {
    requireWindowsAuthorization(installedPath, expected, 'POST_CAPTURE');
  } catch (error) {
    manualRecovery('Installed configuration does not preserve the source Owner and DACL', prepared, planId, {
      installed_path: installedPath,
      expected_authorization: windowsAuthorizationEvidence(expected),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function installProvenProposal(
  prepared: PreparedConfigure,
  planId: string,
  proposed: OwnedFile,
  sourceBackups: readonly OwnedFile[],
  artifacts: TransactionArtifacts,
  hooks: ConfigureApplyHooks,
  mode: 'APPLIED' | 'ALREADY_APPLIED',
  capabilityAlreadyVerified = false,
): ConfigureApplyResult {
  const configPath = prepared.plan.config_path;
  const recoveryContext: RecoveryContext = {
    configPath,
    planId,
    expectedSourceHash: prepared.expectedSourceHash,
    proposedContentHash: prepared.proposedContentHash,
  };
  const sourceConsensus = requireSourceAuthorizationConsensus(sourceBackups, recoveryContext, hooks);
  const sourceBackup = sourceConsensus?.source ?? null;
  if (prepared.expectedSourceHash !== null && sourceConsensus === null) {
    manualRecovery('A proven proposal cannot be installed because the source authorization backup is missing', prepared, planId);
  }
  if (sourceBackup !== null) {
    try {
      preserveWindowsAuthorization(sourceBackup.path, proposed.path, hooks, sourceConsensus?.descriptor ?? undefined);
    } catch (error) {
      manualRecovery('Proposal authorization could not be re-established from the SOURCE consensus', prepared, planId, {
        source_path: sourceBackup.path,
        proposed_path: proposed.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!capabilityAlreadyVerified) {
    ensureHardLinkCapability(prepared, planId, proposed, hooks);
  }
  let refreshed = scanTransactionArtifacts(configPath, planId);
  try {
    hooks.beforeInstall?.({ configPath, backupPath: sourceBackup?.path ?? null, proposedPath: proposed.path });
  } catch (error) {
    manualRecovery('Apply stopped before create-if-absent installation; exact retry can resume', prepared, planId, {
      backup_path: sourceBackup?.path ?? null,
      proposed_path: proposed.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    if (process.platform === 'win32') {
      const authorization = sourceConsensus?.descriptor ?? readWindowsAuthorization(proposed.path);
      createWindowsObjectBoundLink('INSTALL', proposed, configPath, authorization, hooks);
    } else {
      createHardLink('INSTALL', proposed.path, configPath, hooks);
    }
  } catch (error) {
    const target = readCurrent(configPath);
    if (target.identity.state !== 'PRESENT' || target.hash !== prepared.proposedContentHash) {
      manualRecovery('Another writer occupied the target before create-if-absent installation', prepared, planId, {
        backup_path: sourceBackup?.path ?? null,
        proposed_path: proposed.path,
        install_error: error instanceof Error ? error.message : String(error),
      });
    }
    mode = 'ALREADY_APPLIED';
  }
  try {
    hooks.afterInstall?.({ configPath, backupPath: sourceBackup?.path ?? null, proposedPath: proposed.path });
    const installed = readCurrent(configPath);
    if (installed.identity.state !== 'PRESENT' || installed.hash !== prepared.proposedContentHash) {
      throw new Error('installed target content changed');
    }
    validateInstalledSemantics(prepared, configPath);
    requireInstalledAuthorization(sourceConsensus?.descriptor ?? null, configPath, prepared, planId);
  } catch (error) {
    if (error instanceof ConfigureError && error.code === 'CONFIGURE_MANUAL_RECOVERY_REQUIRED') throw error;
    manualRecovery(
      'Post-install verification failed; automatic rollback and pathname cleanup are intentionally disabled',
      prepared,
      planId,
      {
        backup_path: sourceBackup?.path ?? null,
        proposed_path: proposed.path,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  refreshed = scanTransactionArtifacts(configPath, planId);
  return completedResult(prepared, refreshed, mode, sourceBackup?.path ?? null, proposed.path);
}

function applyConfigureTransaction(
  prepared: PreparedConfigure,
  planId: string,
  hooks: ConfigureApplyHooks,
): ConfigureApplyResult {
  if (!prepared.plan.safe_to_apply) {
    throw new ConfigureError(
      'CONFIGURE_STALE_TEST',
      'A stale/test Engineering MCP binding requires operator cleanup before apply',
      { findings: prepared.plan.stale_or_test_entries },
    );
  }
  const configPath = prepared.plan.config_path;
  const recoveryContext: RecoveryContext = {
    configPath,
    planId,
    expectedSourceHash: prepared.expectedSourceHash,
    proposedContentHash: prepared.proposedContentHash,
  };
  const parent = dirname(configPath);
  validateConfigPath(configPath, prepared.createParentOnApply);
  let current = readCurrent(configPath);
  if (prepared.plan.no_change) {
    if (current.hash !== prepared.expectedSourceHash) {
      throw new ConfigureError('CONFIGURE_SOURCE_CHANGED', 'Host configuration changed after preview', {
        expected_hash: prepared.expectedSourceHash,
        actual_hash: current.hash,
      });
    }
    return noChangeResult(prepared);
  }
  if (process.platform !== 'win32' && prepared.expectedSourceHash !== null) {
    throw new ConfigureError(
      'CONFIGURE_UNSUPPORTED',
      'Existing configuration mutation is currently supported only on Windows; preview and semantic no-change remain available on this platform',
      { config_path: configPath, platform: process.platform },
    );
  }
  if (!existsSync(parent)) {
    if (!prepared.createParentOnApply) {
      throw new ConfigureError('CONFIGURE_PATH_INVALID', 'Configuration parent directory does not exist', {
        config_path: configPath,
      });
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  validateConfigPath(configPath);

  let artifacts = scanTransactionArtifacts(configPath, planId);
  let { proposed: proposedArtifacts } = requireExpectedArtifacts(
    artifacts,
    prepared,
    prepared.proposedContentHash,
    planId,
  );
  const refresh = (): {
    sourceBackups: OwnedFile[];
    proposedBackups: OwnedFile[];
    externalBackups: OwnedFile[];
    provenProposals: OwnedFile[];
  } => {
    const sourceBackups = prepared.expectedSourceHash === null
      ? []
      : artifacts.backups.filter((artifact) => artifact.hash === prepared.expectedSourceHash);
    const proposedBackups = artifacts.backups.filter((artifact) => artifact.hash === prepared.proposedContentHash);
    const externalBackups = artifacts.backups.filter(
      (artifact) => artifact.hash !== prepared.expectedSourceHash && artifact.hash !== prepared.proposedContentHash,
    );
    const provenProposals = [
      ...artifacts.proposed.filter((artifact) => artifact.hash === prepared.proposedContentHash),
      ...proposedBackups,
    ];
    return { sourceBackups, proposedBackups, externalBackups, provenProposals };
  };
  let state = refresh();

  if (state.externalBackups.length > 0) {
    if (
      current.identity.state === 'MISSING' &&
      state.externalBackups.length === 1 &&
      state.sourceBackups.length === 0 &&
      state.proposedBackups.length === 0
    ) {
      const captured = state.externalBackups[0]!;
      try {
        createHardLink('RESTORE_CAPTURED_EXTERNAL', captured.path, configPath, hooks);
      } catch (error) {
        manualRecovery(
          'Captured external bytes could not be restored with create-if-absent; all paths were preserved',
          prepared,
          planId,
          { backup_path: captured.path, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      artifacts = scanTransactionArtifacts(configPath, planId);
      throw new ConfigureError(
        'CONFIGURE_PLAN_INVALIDATED',
        'External bytes were captured before apply and restored only with create-if-absent',
        {
          config_path: configPath,
          expected_source_hash: prepared.expectedSourceHash,
          proposed_hash: prepared.proposedContentHash,
          artifacts: classifiedArtifacts(artifacts, prepared),
        },
      );
    }
    manualRecovery('External transaction artifacts make recovery ambiguous; no pathname was overwritten', prepared, planId);
  }

  if (current.identity.state === 'PRESENT' && current.hash === prepared.proposedContentHash) {
    const sourceConsensus = requireSourceAuthorizationConsensus(state.sourceBackups, recoveryContext, hooks);
    const sourceBackup = sourceConsensus?.source ?? null;
    if (prepared.expectedSourceHash !== null && sourceConsensus === null) {
      manualRecovery('The active proposal cannot be verified because its source authorization backup is missing', prepared, planId);
    }
    validateInstalledSemantics(prepared, configPath);
    requireInstalledAuthorization(sourceConsensus?.descriptor ?? null, configPath, prepared, planId);
    const proposal = state.provenProposals[0];
    return completedResult(
      prepared,
      artifacts,
      'ALREADY_APPLIED',
      sourceBackup?.path ?? null,
      proposal?.path ?? configPath,
    );
  }

  if (current.identity.state === 'PRESENT' && current.hash !== prepared.expectedSourceHash) {
    if (artifacts.backups.length === 0) {
      throw new ConfigureError(
        'CONFIGURE_PLAN_INVALIDATED',
        'Host configuration changed after preview and before capture; no target pathname was modified',
        {
          config_path: configPath,
          expected_source_hash: prepared.expectedSourceHash,
          actual_source_hash: current.hash,
          proposed_hash: prepared.proposedContentHash,
          current_target: { state: current.identity.state, hash: current.hash, identity: current.identity },
          artifacts: classifiedArtifacts(artifacts, prepared),
        },
      );
    }
    manualRecovery('The active target contains external bytes; target and artifacts were preserved', prepared, planId);
  }

  if (current.identity.state === 'MISSING' && state.provenProposals.length > 0) {
    return installProvenProposal(
      prepared,
      planId,
      state.provenProposals[0]!,
      state.sourceBackups,
      artifacts,
      hooks,
      'ALREADY_APPLIED',
    );
  }

  if (prepared.expectedSourceHash === null) {
    if (artifacts.backups.length > 0) {
      manualRecovery('A first-install plan unexpectedly has captured backups', prepared, planId);
    }
  } else if (current.identity.state === 'MISSING' && state.sourceBackups.length === 0) {
    manualRecovery('The target is missing and no proven source or proposal artifact is available', prepared, planId);
  }

  if (proposedArtifacts.length === 0) {
    const sourceMode = current.identity.state === 'PRESENT'
      ? current.identity.file.mode
      : state.sourceBackups[0]?.identity.mode ?? 0o600;
    proposedArtifacts = [createProposedArtifact(prepared, planId, sourceMode)];
    artifacts = scanTransactionArtifacts(configPath, planId);
    requireExpectedArtifacts(artifacts, prepared, prepared.proposedContentHash, planId);
    state = refresh();
  }
  const proposed = proposedArtifacts[0]!;
  try {
    hooks.afterProposedPrepared?.({ configPath, proposedPath: proposed.path });
  } catch (error) {
    throw new ConfigureError('CONFIGURE_WRITE_FAILED', 'Apply stopped before target capture; the target was not changed', {
      config_path: configPath,
      proposed_path: proposed.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let expectedAuthorization: WindowsAuthorizationDescriptor | null = null;
  if (prepared.expectedSourceHash !== null) {
    const sourceConsensus = current.identity.state === 'PRESENT'
      ? null
      : requireSourceAuthorizationConsensus(state.sourceBackups, recoveryContext, hooks);
    const authorizationSource = current.identity.state === 'PRESENT'
      ? configPath
      : sourceConsensus?.source.path ?? null;
    if (authorizationSource === null) {
      manualRecovery('The source Owner and DACL cannot be recovered before installation', prepared, planId);
    }
    expectedAuthorization = preserveWindowsAuthorization(
      authorizationSource,
      proposed.path,
      hooks,
      sourceConsensus?.descriptor ?? undefined,
    );
  }
  ensureHardLinkCapability(prepared, planId, proposed, hooks);
  artifacts = scanTransactionArtifacts(configPath, planId);

  let backupPath = state.sourceBackups[0]?.path ?? null;
  current = readCurrent(configPath);
  if (prepared.expectedSourceHash !== null && current.hash === prepared.expectedSourceHash) {
    try {
      hooks.beforeCapture?.({ configPath, proposedPath: proposed.path });
    } catch (error) {
      throw new ConfigureError('CONFIGURE_WRITE_FAILED', 'Apply stopped before target capture; the target was not changed', {
        config_path: configPath,
        proposed_path: proposed.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const backupPrefix = artifactPrefixes(configPath, planId).backup;
    const newBackupPath = randomArtifactPath(configPath, backupPrefix, '.bak');
    try {
      captureTargetNoOverwrite(configPath, newBackupPath);
    } catch (error) {
      artifacts = scanTransactionArtifacts(configPath, planId);
      state = refresh();
      const converged = state.sourceBackups[0] ?? state.proposedBackups[0];
      const afterFailure = readCurrent(configPath);
      if (afterFailure.identity.state === 'PRESENT' && afterFailure.hash === prepared.proposedContentHash) {
        validateInstalledSemantics(prepared, configPath);
        const sourceConsensus = requireSourceAuthorizationConsensus(state.sourceBackups, recoveryContext, hooks);
        const sourceBackup = sourceConsensus?.source ?? null;
        requireInstalledAuthorization(sourceConsensus?.descriptor ?? null, configPath, prepared, planId);
        return completedResult(prepared, artifacts, 'ALREADY_APPLIED', sourceBackup?.path ?? null, proposed.path);
      }
      if (!converged || afterFailure.identity.state !== 'MISSING') {
        if (error instanceof ConfigureError) throw error;
        throw new ConfigureError('CONFIGURE_WRITE_FAILED', 'Atomic configuration capture failed without changing the target', {
          config_path: configPath,
          backup_path: newBackupPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      backupPath = converged.path;
    }
    if (existsSync(newBackupPath)) backupPath = newBackupPath;
    if (backupPath === null) {
      manualRecovery('Atomic capture outcome could not be proven from retained filesystem state', prepared, planId);
    }
    try {
      hooks.afterCapture?.({ configPath, backupPath, proposedPath: proposed.path });
    } catch (error) {
      manualRecovery('Apply stopped after source capture; exact retry can resume', prepared, planId, {
        backup_path: backupPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const captured = readArtifact(backupPath);
    artifacts = scanTransactionArtifacts(configPath, planId);
    state = refresh();
    const capturedClass = classifyArtifact(captured, 'BACKUP', prepared).classification;
    if (capturedClass === 'PROPOSED') {
      return installProvenProposal(
        prepared,
        planId,
        captured,
        state.sourceBackups,
        artifacts,
        hooks,
        'ALREADY_APPLIED',
        true,
      );
    }
    if (capturedClass === 'EXTERNAL') {
      if (state.sourceBackups.length > 0 || state.proposedBackups.length > 0) {
        manualRecovery('External captured bytes make concurrent recovery ambiguous', prepared, planId, {
          captured_path: captured.path,
        });
      }
      try {
        createHardLink('RESTORE_CAPTURED_EXTERNAL', captured.path, configPath, hooks);
      } catch (error) {
        manualRecovery('Captured external bytes could not be restored without overwrite', prepared, planId, {
          captured_path: captured.path,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      artifacts = scanTransactionArtifacts(configPath, planId);
      throw new ConfigureError('CONFIGURE_PLAN_INVALIDATED', 'Captured external bytes were restored without overwrite', {
        config_path: configPath,
        expected_source_hash: prepared.expectedSourceHash,
        proposed_hash: prepared.proposedContentHash,
        artifacts: classifiedArtifacts(artifacts, prepared),
      });
    }
    if (expectedAuthorization !== null) {
      try {
        requireWindowsAuthorization(captured.path, expectedAuthorization, 'POST_CAPTURE');
      } catch (error) {
        manualRecovery('Captured source did not retain its original Owner and DACL', prepared, planId, {
          captured_path: captured.path,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  artifacts = scanTransactionArtifacts(configPath, planId);
  state = refresh();
  const exactBackup = state.sourceBackups[0] ?? null;
  if (prepared.expectedSourceHash !== null && exactBackup === null) {
    manualRecovery('The source capture is missing before installation', prepared, planId);
  }
  backupPath = exactBackup?.path ?? null;

  return installProvenProposal(prepared, planId, proposed, state.sourceBackups, artifacts, hooks, 'APPLIED', true);
}

export function applyPreparedConfigure(
  prepared: PreparedConfigure,
  hooks: ConfigureApplyHooks = {},
): ConfigureApplyResult {
  return applyConfigureTransaction(prepared, randomBytes(32).toString('hex'), hooks);
}

function assertPlanContext(payload: ImmutablePlanPayload, assertions: ConfigurePlanAssertions): void {
  const mismatch = (field: string, expected: unknown, actual: unknown): never => {
    throw new ConfigureError('CONFIGURE_PLAN_INVALIDATED', `Configure plan ${field} does not match apply intent`, {
      field,
      expected,
      actual,
    });
  };
  if (assertions.host !== undefined && assertions.host !== payload.plan.host) {
    mismatch('host', payload.plan.host, assertions.host);
  }
  if (assertions.configPath !== undefined) {
    const actual = resolve(assertions.configPath);
    if (actual !== payload.plan.config_path) mismatch('config_path', payload.plan.config_path, actual);
  }
  if (assertions.command !== undefined && assertions.command !== payload.plan.intended_entry.command) {
    mismatch('command', payload.plan.intended_entry.command, assertions.command);
  }
  if (assertions.repo !== undefined) {
    let actual: string;
    try {
      actual = inspectRepo(assertions.repo).repoRoot;
    } catch {
      mismatch('repository', payload.plan.repository_binding.bound_repository, resolve(assertions.repo));
    }
    if (actual! !== payload.plan.repository_binding.bound_repository) {
      mismatch('repository', payload.plan.repository_binding.bound_repository, actual!);
    }
  }
  try {
    const currentBinding = inspectRepo(payload.plan.repository_binding.bound_repository).repoRoot;
    if (currentBinding !== payload.plan.repository_binding.bound_repository) {
      mismatch('repository', payload.plan.repository_binding.bound_repository, currentBinding);
    }
  } catch {
    mismatch('repository', payload.plan.repository_binding.bound_repository, null);
  }
}

function reconstructProposed(payload: ImmutablePlanPayload, source: Buffer): string {
  if (payload.source_state === 'PRESENT' && sha256(source) !== payload.expected_source_hash) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALIDATED', 'Captured source does not match the preview source hash');
  }
  if (payload.source_state === 'MISSING' && source.length !== 0) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'A missing-source plan cannot contain source bytes');
  }
  const text = source.toString('utf8');
  const parsed = parseToml(text, payload.plan.config_path);
  const entries = mcpEntries(parsed);
  const owned = entries[SERVER_NAME];
  validateOwnedEntry(owned);
  const desired = {
    command: payload.plan.intended_entry.command,
    args: [...payload.plan.intended_entry.args],
  };
  const sourceArgs = owned ? stringArray(owned.args)! : null;
  const semanticNoChange =
    owned !== undefined && owned.command === desired.command && JSON.stringify(sourceArgs) === JSON.stringify(desired.args);
  const proposed = semanticNoChange ? text : renderOwnedEntry(text, desired, owned !== undefined);
  if (sha256(Buffer.from(proposed, 'utf8')) !== payload.proposed_content_hash) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALIDATED', 'Frozen configure intent no longer materializes the previewed bytes');
  }
  return proposed;
}

function parseImmutablePlan(identity: string): ImmutablePlanPayload {
  const parts = identity.split('.');
  if (parts.length !== 3 || parts[0] !== PLAN_TOKEN_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '')) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'Configure plan identity has an invalid format');
  }
  const encoded = parts[1]!;
  const checksum = parts[2]!;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'Configure plan identity has invalid encoding');
  }
  if (bytes.toString('base64url') !== encoded || !/^[0-9a-f]{64}$/.test(checksum) || sha256(bytes) !== checksum) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'Configure plan identity checksum does not match its immutable payload');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'Configure plan payload is not valid JSON');
  }
  if (!isRecord(value) || !isRecord(value.plan) || value.version !== CONFIGURE_PLAN_VERSION) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'Configure plan payload has an unsupported schema');
  }
  const payload = value as unknown as ImmutablePlanPayload;
  const intended = isRecord(payload.plan.intended_entry) ? payload.plan.intended_entry : null;
  const binding = isRecord(payload.plan.repository_binding) ? payload.plan.repository_binding : null;
  if (
    !/^[0-9a-f]{64}$/.test(payload.plan_id) ||
    (payload.source_state !== 'PRESENT' && payload.source_state !== 'MISSING') ||
    (payload.source_state === 'PRESENT' && !/^[0-9a-f]{64}$/.test(payload.expected_source_hash ?? '')) ||
    (payload.source_state === 'MISSING' && payload.expected_source_hash !== null) ||
    !/^[0-9a-f]{64}$/.test(payload.proposed_content_hash) ||
    typeof payload.previewed_at !== 'string' ||
    !Number.isFinite(Date.parse(payload.previewed_at)) ||
    typeof payload.create_parent_on_apply !== 'boolean' ||
    (payload.plan.host !== 'codex' && payload.plan.host !== 'grok') ||
    typeof payload.plan.config_path !== 'string' ||
    !isAbsolute(payload.plan.config_path) ||
    resolve(payload.plan.config_path) !== payload.plan.config_path ||
    payload.plan.config_exists !== (payload.source_state === 'PRESENT') ||
    intended === null ||
    intended.server !== SERVER_NAME ||
    typeof intended.command !== 'string' ||
    stringArray(intended.args) === null ||
    binding === null ||
    typeof binding.bound_repository !== 'string'
  ) {
    throw new ConfigureError('CONFIGURE_PLAN_INVALID', 'Configure plan payload is malformed');
  }
  return payload;
}

export function createConfigurePlanIdentity(prepared: PreparedConfigure): ConfigurePlanIdentity {
  const payload: ImmutablePlanPayload = {
    version: CONFIGURE_PLAN_VERSION,
    plan_id: randomBytes(32).toString('hex'),
    plan: prepared.plan,
    source_state: prepared.expectedSourceHash === null ? 'MISSING' : 'PRESENT',
    expected_source_hash: prepared.expectedSourceHash,
    proposed_content_hash: prepared.proposedContentHash,
    previewed_at: prepared.preparedAt,
    create_parent_on_apply: prepared.createParentOnApply,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    identity: `${PLAN_TOKEN_PREFIX}.${bytes.toString('base64url')}.${sha256(bytes)}`,
    plan: prepared.plan,
    trust_model:
      'The self-contained plan detects stale or inconsistent apply intent; it is not an authorization credential. Authorization is the current OS user\'s filesystem permission to the target configuration.',
  };
}

function sourceBytesForPlan(payload: ImmutablePlanPayload, hooks: ConfigureApplyHooks): Buffer {
  if (payload.source_state === 'MISSING') return Buffer.alloc(0);
  const current = readCurrent(payload.plan.config_path);
  if (current.hash === payload.expected_source_hash && current.content !== null) return current.content;
  const artifacts = scanTransactionArtifacts(payload.plan.config_path, payload.plan_id);
  const context: RecoveryContext = {
    configPath: payload.plan.config_path,
    planId: payload.plan_id,
    expectedSourceHash: payload.expected_source_hash,
    proposedContentHash: payload.proposed_content_hash,
  };
  const sourceBackups = artifacts.backups.filter((artifact) => artifact.hash === payload.expected_source_hash);
  const consensus = requireSourceAuthorizationConsensus(sourceBackups, context, hooks);
  if (consensus !== null) {
    const captured = readCurrent(consensus.source.path);
    if (captured.content !== null && captured.hash === payload.expected_source_hash) return captured.content;
  }
  if (current.identity.state === 'MISSING' || artifacts.backups.length > 0) {
    throwManualRecovery(
      'Preview source bytes are unavailable and retained transaction artifacts require manual recovery',
      context,
    );
  }
  throw new ConfigureError('CONFIGURE_PLAN_INVALIDATED', 'Preview source bytes are no longer available for deterministic apply', {
    config_path: payload.plan.config_path,
    expected_source_hash: payload.expected_source_hash,
    proposed_hash: payload.proposed_content_hash,
    current_target: { state: current.identity.state, hash: current.hash, identity: current.identity },
    artifacts: classifiedArtifacts(artifacts, context, true),
  });
}

export function applyConfigurePlanIdentity(
  identity: string,
  assertions: ConfigurePlanAssertions = {},
): ConfigureApplyResult {
  const payload = parseImmutablePlan(identity);
  assertPlanContext(payload, assertions);
  const source = sourceBytesForPlan(payload, assertions.hooks ?? {});
  const proposed = reconstructProposed(payload, source);
  const prepared: PreparedConfigure = {
    plan: payload.plan,
    expectedSourceHash: payload.expected_source_hash,
    proposedContent: proposed,
    proposedContentHash: payload.proposed_content_hash,
    preparedAt: payload.previewed_at,
    createParentOnApply: payload.create_parent_on_apply,
  };
  try {
    return applyConfigureTransaction(prepared, payload.plan_id, assertions.hooks ?? {});
  } catch (error) {
    if (error instanceof ConfigureError && error.code === 'CONFIGURE_SOURCE_CHANGED') {
      throw new ConfigureError('CONFIGURE_PLAN_INVALIDATED', error.message, error.details);
    }
    throw error;
  }
}
