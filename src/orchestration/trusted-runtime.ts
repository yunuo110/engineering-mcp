import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedControlEnvironment } from './runtime-environment.ts';

const CONFIG_SCHEMA = 'engineering-v2-trusted-launch/3';
const MANIFEST_SCHEMA = 'engineering-v2-trusted-runtime/3';
const HELPER_BUILD = 'engineering-execution-bootstrap/2';
const KEEPER_BUILD = 'engineering-execution-keeper/1';
const SECURITY_BUILD = 'engineering-execution-security/1';
const CREDENTIAL_BUILD = 'engineering-execution-credential/1';
const SHA = /^[0-9A-F]{64}$/;
const RX = 1179817;
const READ = 1179785;
const FULL = 2032127;

type Artifact = { path: string; sha256: string; length: number; role: string };
export type ProtectedPathAcl = { path: string; owner: string; protected: boolean; reparse: boolean;
  sddl: string; aces: { sid: string; rights: number; inherited: boolean; type: string;
    inheritOnly: boolean; containerInherit: boolean; objectInherit: boolean }[] };
type Acl = ProtectedPathAcl;
export type TrustedRuntimeBinding = {
  root: string;
  nodePath: string;
  coreEntry: string;
  serverEntry: string;
  controllerModule: string;
  executionGroupModule: string;
  bootstrapHelper: string;
  keeperPath: string;
  runnerEntry: string;
  manifestPath: string;
  profileConfigPath: string;
  gitPath: string;
  gitInstallRoot: string;
  gitExecPath: string;
  coreSid: string;
  keeperSid: string;
  workerSid: string;
  operatorSid: string;
  workerLauncherPath: string;
  authorityGitPath: string;
  securityHelperPath: string;
  credentialHelperPath: string;
  credentialBlobPath: string;
  repositoryPath: string;
  ledgerPath: string;
};

let protectedExecutionRequested = false;
/** Monotonic process-local mode. A staged installation cannot downgrade itself. */
export function configureProtectedExecutionMode(enabled: boolean): void {
  if (enabled) protectedExecutionRequested = true;
}
export function isProtectedExecutionMode(): boolean {
  if (protectedExecutionRequested) return true;
  const modulePath = fileURLToPath(import.meta.url);
  return existsSync(join(dirname(dirname(dirname(modulePath))), 'trusted-launch-config.json'));
}
export function assertProtectedRepositoryBinding(storePath: string, repoRoot: string): void {
  if (!isProtectedExecutionMode()) return;
  const binding = verifyTrustedRuntime();
  equalPath(resolve(storePath), binding.ledgerPath, 'ledger');
  equalPath(realpathSync.native(repoRoot), binding.repositoryPath, 'repository');
}

function fail(message: string): never { throw new Error(`TRUSTED_RUNTIME_REFUSED:${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid object');
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`invalid ${name}`);
  return value;
}
function equalPath(actual: string, expected: string, name: string): void {
  if (!isAbsolute(actual) || resolve(actual).toLowerCase() !== resolve(expected).toLowerCase())
    fail(`${name} path mismatch`);
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && !part.startsWith('..') && !isAbsolute(part);
}
function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}
function files(root: string): string[] {
  const result: string[] = [];
  const walk = (path: string): void => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isSymbolicLink()) fail(`reparse point: ${child}`);
      if (item.isDirectory()) walk(child);
      else if (item.isFile()) result.push(child);
      else fail(`unexpected artifact type: ${child}`);
    }
  };
  walk(root);
  return result;
}
function directories(root: string): string[] {
  const result = [root];
  const walk = (path: string): void => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const child = join(path, item.name);
      result.push(child); walk(child);
    }
  };
  walk(root); return result;
}

function aclSnapshot(paths: string[], securityHelperPath: string): { sid: string; trustedInstallerSid: string; rows: Acl[] } {
  const output = execFileSync(securityHelperPath, ['snapshot'],
    { input: JSON.stringify(paths), encoding: 'utf8', windowsHide: true,
      maxBuffer: 16 * 1024 * 1024, timeout: 30000,
      env: boundedControlEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'] });
  const parsed = record(JSON.parse(output));
  if (!Array.isArray(parsed.rows) || parsed.rows.length !== paths.length) fail('ACL probe incomplete');
  return { sid: string(parsed.sid, 'caller SID'), trustedInstallerSid: string(parsed.trustedInstallerSid, 'TrustedInstaller SID'),
    rows: parsed.rows as Acl[] };
}
function assertControlAcl(row: Acl, operatorSid: string, coreSid: string,
  keeperSid: string): void {
  if (row.reparse || !row.protected || row.owner !== operatorSid || row.aces.length !== 4)
    fail(`control owner/ACL mismatch: ${row.path}`);
  const expected = new Map([[operatorSid, FULL], ['S-1-5-18', FULL],
    [coreSid, RX], [keeperSid, RX]]);
  if (expected.size !== 4) fail('control SID collision');
  for (const ace of row.aces) {
    if (ace.type !== 'Allow' || ace.inherited || ace.inheritOnly || expected.get(ace.sid) !== ace.rights)
      fail(`control ACE mismatch: ${row.path}`);
    expected.delete(ace.sid);
  }
  if ([...expected.keys()].length !== 0) fail(`control ACE missing: ${row.path}`);
}

/** Exact protected ACL for an externally provisioned credential object. */
export function assertProtectedCredentialAcl(row: ProtectedPathAcl, kind: 'directory' | 'file',
  identity: Pick<TrustedRuntimeBinding, 'operatorSid' | 'coreSid' | 'keeperSid' | 'workerSid'>): void {
  const expected = new Map([[identity.operatorSid, FULL], ['S-1-5-18', FULL],
    [identity.coreSid, kind === 'directory' ? RX : READ]]);
  if (expected.size !== 3 || expected.has(identity.keeperSid) || expected.has(identity.workerSid)
    || identity.keeperSid === identity.workerSid) fail('credential SID collision');
  if (row.owner !== identity.operatorSid || !row.protected || row.reparse
    || !Array.isArray(row.aces) || row.aces.length !== 3)
    fail('credential owner/ACL mismatch');
  for (const ace of row.aces) {
    if (ace.type !== 'Allow' || ace.inherited || ace.inheritOnly || ace.containerInherit
      || ace.objectInherit || !Number.isInteger(ace.rights) || expected.get(ace.sid) !== ace.rights)
      fail('credential ACE mismatch');
    expected.delete(ace.sid);
  }
  if ([...expected.keys()].length !== 0) fail('credential ACE missing');
}

type LedgerAclKind = 'directory' | 'file' | 'ancestor';
type LedgerAclIdentity = Pick<TrustedRuntimeBinding, 'coreSid' | 'keeperSid' | 'workerSid' | 'operatorSid'>
  & { trustedInstallerSid?: string };
const REPLACE_ACCESS = 0x00010000 | 0x00000040 | 0x00040000 | 0x00080000;
const MUTATE_ACCESS = REPLACE_ACCESS | 0x00000002 | 0x00000004 | 0x00000010 | 0x00000100;
const GENERIC_MUTATE_ACCESS = 0x10000000 | 0x40000000;

/** Pure fail-closed policy over the read-only Windows ACL probe, not an ACL writer. */
export function assertProtectedLedgerAcl(row: ProtectedPathAcl, kind: LedgerAclKind,
  identity: LedgerAclIdentity): void {
  const trusted = new Set([identity.coreSid, identity.operatorSid, 'S-1-5-18', 'S-1-5-32-544']);
  if (trusted.size !== 4 || trusted.has(identity.keeperSid) || trusted.has(identity.workerSid)
    || identity.keeperSid === identity.workerSid) fail('ledger SID collision');
  // The SID is obtained by Windows NTAccount translation in the native probe, never
  // supplied by the repository/config. It is trusted on OS ancestors only.
  if (kind === 'ancestor' && identity.trustedInstallerSid) {
    if (identity.trustedInstallerSid === identity.keeperSid || identity.trustedInstallerSid === identity.workerSid)
      fail('ledger OS SID collision');
    trusted.add(identity.trustedInstallerSid);
  }
  if (row.reparse || !trusted.has(row.owner) || !Array.isArray(row.aces) || row.aces.length === 0)
    fail(`ledger owner/reparse/ACL mismatch: ${row.path}`);
  for (const ace of row.aces) {
    if (!Number.isInteger(ace.rights) || typeof ace.sid !== 'string'
      || typeof ace.inheritOnly !== 'boolean' || typeof ace.containerInherit !== 'boolean'
      || typeof ace.objectInherit !== 'boolean' || (ace.type !== 'Allow' && ace.type !== 'Deny'))
      fail(`ledger ACL probe malformed: ${row.path}`);
    if (ace.type === 'Deny' || trusted.has(ace.sid)) continue;
    // An InheritOnly ACE does not authorize replacing this ancestor. On the
    // ledger parent it still authorizes future SQLite/witness children, so it
    // cannot be ignored when those objects have not been created yet.
    if (ace.inheritOnly && (kind !== 'directory' || (!ace.containerInherit && !ace.objectInherit))) continue;
    const forbidden = (kind === 'ancestor' ? REPLACE_ACCESS : MUTATE_ACCESS) | GENERIC_MUTATE_ACCESS;
    if ((ace.rights & forbidden) !== 0)
      fail(`untrusted ledger ${kind} mutation access: ${row.path}`);
  }
}

function ledgerAclInventory(ledgerPath: string): Array<{ path: string; kind: LedgerAclKind }> {
  const paths = new Map<string, { path: string; kind: LedgerAclKind }>();
  const add = (path: string, kind: LedgerAclKind): void => {
    const key = resolve(path).toLowerCase();
    if (!paths.has(key)) paths.set(key, { path, kind });
  };
  for (const path of [ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isFile()) fail(`ledger file type mismatch: ${path}`);
    add(path, 'file');
  }
  const witnessRoot = join(dirname(ledgerPath), 'execution-witnesses');
  if (existsSync(witnessRoot)) {
    if (!lstatSync(witnessRoot).isDirectory()) fail(`witness root type mismatch: ${witnessRoot}`);
    add(witnessRoot, 'directory');
  }
  let parent = dirname(ledgerPath);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) fail('ledger has no existing parent');
    parent = next;
  }
  if (!lstatSync(parent).isDirectory()) fail(`ledger parent type mismatch: ${parent}`);
  add(parent, 'directory');
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    if (!lstatSync(ancestor).isDirectory()) fail(`ledger ancestor type mismatch: ${ancestor}`);
    add(ancestor, 'ancestor');
    if (dirname(ancestor) === ancestor) break;
  }
  return [...paths.values()];
}
function readJson(path: string): Record<string, unknown> {
  try { return record(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return fail(`invalid JSON: ${path}`); }
}

export function trustedRuntimeRootFromModule(): string {
  const path = fileURLToPath(import.meta.url);
  if (!path.toLowerCase().endsWith('\\dist\\orchestration\\trusted-runtime.js'))
    fail('Controller is not loaded from staged dist');
  return dirname(dirname(dirname(path)));
}

/** Fail-closed verifier. Only fixed attested helpers are launched for build and ACL probes. */
export function verifyTrustedRuntime(root = trustedRuntimeRootFromModule()): TrustedRuntimeBinding {
  if (process.platform !== 'win32') fail('Windows runtime required');
  if (!isAbsolute(root) || !existsSync(root) || lstatSync(root).isSymbolicLink())
    fail('trusted root missing or redirected');
  const actualRoot = realpathSync.native(root);
  const configPath = join(actualRoot, 'trusted-launch-config.json');
  const manifestPath = join(actualRoot, 'trusted-runtime-manifest.json');
  const config = readJson(configPath), manifest = readJson(manifestPath);
  if (config.schema !== CONFIG_SCHEMA || manifest.schema !== MANIFEST_SCHEMA
    || manifest.configSchema !== CONFIG_SCHEMA || manifest.helperBuild !== HELPER_BUILD
    || manifest.keeperBuild !== KEEPER_BUILD
    || manifest.securityHelperBuild !== SECURITY_BUILD
    || manifest.credentialHelperBuild !== CREDENTIAL_BUILD) fail('schema/build binding mismatch');
  equalPath(string(config.root, 'root'), actualRoot, 'root');
  equalPath(string(config.manifestPath, 'manifestPath'), manifestPath, 'manifest');
  equalPath(string(config.nodePath, 'nodePath'), join(actualRoot, 'node', 'node.exe'), 'Node');
  equalPath(string(config.coreEntry, 'coreEntry'), join(actualRoot, 'dist', 'cli.js'), 'Core entry');
  equalPath(string(config.serverEntry, 'serverEntry'), join(actualRoot, 'dist', 'index.js'), 'Core server');
  equalPath(string(config.controllerModule, 'controllerModule'),
    join(actualRoot, 'dist', 'orchestration', 'c2c-launch-controller.js'), 'Controller');
  equalPath(string(config.executionGroupModule, 'executionGroupModule'),
    join(actualRoot, 'dist', 'orchestration', 'execution-group.js'), 'execution group');
  equalPath(string(config.bootstrapHelper, 'bootstrapHelper'),
    join(actualRoot, 'dist', 'native', 'execution-bootstrap.exe'), 'bootstrap helper');
  equalPath(string(config.keeperPath, 'keeperPath'),
    join(actualRoot, 'dist', 'native', 'execution-keeper.exe'), 'Keeper');
  equalPath(string(config.workerLauncherPath, 'workerLauncherPath'),
    join(actualRoot, 'dist', 'native', 'execution-worker.exe'), 'Worker launcher');
  equalPath(string(config.authorityGitPath, 'authorityGitPath'),
    join(actualRoot, 'dist', 'native', 'authority-git.exe'), 'authority Git launcher');
  equalPath(string(config.securityHelperPath, 'securityHelperPath'),
    join(actualRoot, 'dist', 'native', 'execution-security.exe'), 'security helper');
  const credentialHelperPath = string(config.credentialHelperPath, 'credentialHelperPath');
  equalPath(credentialHelperPath,
    join(actualRoot, 'dist', 'native', 'execution-credential.exe'), 'credential helper');
  if (manifest.credentialHelperPath !== credentialHelperPath)
    fail('credential helper binding mismatch');
  equalPath(string(config.runnerEntry, 'runnerEntry'),
    join(actualRoot, 'dist', 'orchestration', 'c2c-worker-runner-entry.js'), 'Runner');
  equalPath(string(config.profileConfigPath, 'profileConfigPath'),
    join(actualRoot, 'trusted-profile-config.json'), 'profile configuration');
  const gitPath = string(config.gitPath, 'gitPath');
  const gitInstallRoot = string(config.gitInstallRoot, 'gitInstallRoot');
  const gitExecPath = string(config.gitExecPath, 'gitExecPath');
  if (!isAbsolute(gitPath) || !isAbsolute(gitInstallRoot) || !isAbsolute(gitExecPath)
    || !inside(gitInstallRoot, gitPath) || !inside(gitInstallRoot, gitExecPath))
    fail('Git installation binding invalid');
  const coreSid = string(config.coreSid, 'coreSid');
  const keeperSid = string(config.keeperSid, 'keeperSid');
  const workerSid = string(config.workerSid, 'workerSid');
  const operatorSid = string(manifest.operatorSid, 'operatorSid');
  if (manifest.coreSid !== coreSid || manifest.keeperSid !== keeperSid
    || manifest.workerSid !== workerSid
    || new Set([coreSid, keeperSid, workerSid, operatorSid, 'S-1-5-18', 'S-1-5-32-544']).size !== 6)
    fail('identity binding mismatch');
  const repositoryPath = string(config.repositoryPath, 'repositoryPath');
  const ledgerPath = string(config.ledgerPath, 'ledgerPath');
  if (!isAbsolute(repositoryPath) || !isAbsolute(ledgerPath)
    || manifest.repositoryPath !== repositoryPath || manifest.ledgerPath !== ledgerPath
    || realpathSync.native(repositoryPath).toLowerCase() !== repositoryPath.toLowerCase())
    fail('repository/ledger binding mismatch');
  const credentialBlobPath = string(config.credentialBlobPath, 'credentialBlobPath');
  const credentialRoot = dirname(credentialBlobPath);
  const disallowedRoots = [actualRoot, repositoryPath, dirname(ledgerPath)];
  if (!isAbsolute(credentialBlobPath) || credentialRoot === credentialBlobPath
    || manifest.credentialBlobPath !== credentialBlobPath
    || disallowedRoots.some((root) => resolve(credentialRoot).toLowerCase() === resolve(root).toLowerCase()
      || inside(root, credentialRoot) || inside(root, credentialBlobPath)))
    fail('credential path binding invalid');
  try {
    if (!lstatSync(credentialRoot).isDirectory() || lstatSync(credentialRoot).isSymbolicLink()
      || !lstatSync(credentialBlobPath).isFile() || lstatSync(credentialBlobPath).isSymbolicLink()
      || realpathSync.native(credentialRoot).toLowerCase() !== resolve(credentialRoot).toLowerCase()
      || realpathSync.native(credentialBlobPath).toLowerCase() !== resolve(credentialBlobPath).toLowerCase())
      fail('credential object type/redirect mismatch');
  } catch { fail('credential object absent or redirected'); }
  const stagedPackage = readJson(join(actualRoot, 'package.json'));
  if (manifest.packageVersion !== stagedPackage.version) fail('Core package version mismatch');
  const profiles = readJson(string(config.profileConfigPath, 'profileConfigPath'));
  if (profiles.schema !== 'engineering-v2-trusted-profiles/1' || profiles.mode !== 'builtin')
    fail('profile configuration mismatch');

  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail('empty manifest');
  const internalFiles = files(actualRoot).filter((path) => path.toLowerCase() !== manifestPath.toLowerCase());
  const internalEntries = new Map<string, Artifact>();
  const externalEntries: Artifact[] = [];
  for (const raw of artifacts) {
    const entry = record(raw) as Artifact;
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path)
      || typeof entry.role !== 'string' || !SHA.test(entry.sha256)
      || !Number.isSafeInteger(entry.length) || entry.length < 0) fail('invalid artifact entry');
    const key = resolve(entry.path).toLowerCase();
    if (inside(actualRoot, entry.path)) {
      if (internalEntries.has(key)) fail('duplicate manifest artifact');
      internalEntries.set(key, entry);
    } else externalEntries.push(entry);
  }
  if (internalEntries.size !== internalFiles.length) fail('unmanifested/missing control file');
  for (const path of internalFiles) {
    const entry = internalEntries.get(resolve(path).toLowerCase());
    if (!entry) fail(`unmanifested control file: ${path}`);
  }
  const externalAllowed = new Set([resolve(gitPath).toLowerCase()]);
  if (externalEntries.length !== externalAllowed.size
    || externalEntries.some((entry) => !externalAllowed.delete(resolve(entry.path).toLowerCase()))
    || externalAllowed.size !== 0) fail('external trust inventory mismatch');
  for (const raw of artifacts) {
    const entry = raw as Artifact;
    if (!existsSync(entry.path) || !lstatSync(entry.path).isFile()
      || lstatSync(entry.path).isSymbolicLink()
      || lstatSync(entry.path).size !== entry.length || fileHash(entry.path) !== entry.sha256)
      fail(`artifact hash/path mismatch: ${entry.path}`);
  }
  if (!internalEntries.has(resolve(credentialHelperPath).toLowerCase()))
    fail('credential helper absent from manifest');
  try {
    const build = execFileSync(credentialHelperPath, ['--version'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 128, timeout: 5000,
      env: boundedControlEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (build.trim() !== CREDENTIAL_BUILD) fail('credential helper build mismatch');
  } catch { fail('credential helper build refused'); }
  const controlPaths = [dirname(actualRoot), ...directories(actualRoot), manifestPath, ...internalFiles];
  const externalPaths = [gitInstallRoot, dirname(gitPath), gitPath, gitExecPath];
  // A missing first ledger file is checked through its existing parent. Every
  // later binding/admission check reruns this inventory after Store.open, and
  // then validates the actual SQLite file and sidecar ACLs too.
  const ledgerPaths = ledgerAclInventory(ledgerPath);
  const probe = aclSnapshot([...controlPaths, ...externalPaths, ...ledgerPaths.map((entry) => entry.path),
    credentialRoot, credentialBlobPath],
    config.securityHelperPath as string);
  if (probe.sid !== coreSid) fail('process is not the bound Core identity');
  for (let index = 0; index < controlPaths.length; index++)
    assertControlAcl(probe.rows[index]!, operatorSid, coreSid, keeperSid);
  const gitSddl = manifest.gitSddl;
  if (!Array.isArray(gitSddl) || gitSddl.length !== externalPaths.length)
    fail('Git ACL boundary missing');
  for (let index = 0; index < externalPaths.length; index++) {
    const row = probe.rows[controlPaths.length + index]!;
    if (row.reparse || row.owner !== 'S-1-5-32-544' || row.sddl !== gitSddl[index])
      fail(`Git installation owner/ACL drift: ${row.path}`);
  }
  for (let index = 0; index < ledgerPaths.length; index++) {
    const entry = ledgerPaths[index]!;
    assertProtectedLedgerAcl(probe.rows[controlPaths.length + externalPaths.length + index]!, entry.kind,
      { coreSid, keeperSid, workerSid, operatorSid, trustedInstallerSid: probe.trustedInstallerSid });
  }
  const credentialOffset = controlPaths.length + externalPaths.length + ledgerPaths.length;
  equalPath(probe.rows[credentialOffset]!.path, credentialRoot, 'credential root');
  equalPath(probe.rows[credentialOffset + 1]!.path, credentialBlobPath, 'credential blob');
  assertProtectedCredentialAcl(probe.rows[credentialOffset]!, 'directory',
    { operatorSid, coreSid, keeperSid, workerSid });
  assertProtectedCredentialAcl(probe.rows[credentialOffset + 1]!, 'file',
    { operatorSid, coreSid, keeperSid, workerSid });
  if (resolve(process.execPath).toLowerCase() !== resolve(string(config.nodePath, 'nodePath')).toLowerCase())
    fail('Node executable is not staged Node');
  return {
    root: actualRoot,
    nodePath: config.nodePath as string,
    coreEntry: config.coreEntry as string,
    serverEntry: config.serverEntry as string,
    controllerModule: config.controllerModule as string,
    executionGroupModule: config.executionGroupModule as string,
    bootstrapHelper: config.bootstrapHelper as string,
    keeperPath: config.keeperPath as string,
    runnerEntry: config.runnerEntry as string,
    manifestPath,
    profileConfigPath: config.profileConfigPath as string,
    gitPath,
    gitInstallRoot,
    gitExecPath,
    coreSid,
    keeperSid,
    workerSid,
    operatorSid,
    workerLauncherPath: config.workerLauncherPath as string,
    authorityGitPath: config.authorityGitPath as string,
    securityHelperPath: config.securityHelperPath as string,
    credentialHelperPath,
    credentialBlobPath,
    repositoryPath,
    ledgerPath,
  };
}
