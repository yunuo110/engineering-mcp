import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPreparedConfigure,
  applyConfigurePlanIdentity,
  ConfigureError,
  createConfigurePlanIdentity,
  prepareConfigure,
  type ConfigureErrorCode,
} from '../src/configure.ts';
import { initGitRepo, tempDir } from './helpers.ts';

type AuthorizationDescriptor = {
  owner_sddl: string;
  dacl_sddl: string;
  combined_sddl: string;
  owner_sid: string | null;
  dacl_present: boolean;
  dacl_binary_base64: string | null;
  access_rules_protected: boolean;
};

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function powershell(script: string, environment: Record<string, string>): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return execFileSync(
    join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, ...environment }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  ).trim();
}

function authorization(path: string): AuthorizationDescriptor {
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ACL_TEST_PATH','Process')",
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
  return JSON.parse(powershell(script, { ACL_TEST_PATH: path })) as AuthorizationDescriptor;
}

function semanticAuthorization(descriptor: AuthorizationDescriptor): Pick<
  AuthorizationDescriptor,
  'owner_sid' | 'dacl_present' | 'dacl_binary_base64' | 'access_rules_protected'
> {
  return {
    owner_sid: descriptor.owner_sid,
    dacl_present: descriptor.dacl_present,
    dacl_binary_base64: descriptor.dacl_binary_base64,
    access_rules_protected: descriptor.access_rules_protected,
  };
}

function expectSameAuthorization(path: string, expected: AuthorizationDescriptor): void {
  expect(semanticAuthorization(authorization(path))).toEqual(semanticAuthorization(expected));
}

function setProtectedAcl(path: string, includeUsersAllow: boolean): void {
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ACL_TEST_PATH','Process')",
    "$includeUsers=[Environment]::GetEnvironmentVariable('ACL_TEST_USERS_ALLOW','Process') -eq 'true'",
    '$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$guests=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-546')",
    "$users=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')",
    '$acl=New-Object System.Security.AccessControl.FileSecurity',
    '$acl.SetOwner($current)',
    '$acl.SetAccessRuleProtection($true,$false)',
    '$deny=New-Object System.Security.AccessControl.FileSystemAccessRule($guests,[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.AccessControlType]::Deny)',
    '$ownerAllow=New-Object System.Security.AccessControl.FileSystemAccessRule($current,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)',
    '$acl.AddAccessRule($deny)',
    '$acl.AddAccessRule($ownerAllow)',
    "if($includeUsers){$usersAllow=New-Object System.Security.AccessControl.FileSystemAccessRule($users,[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($usersAllow)}",
    '[System.IO.File]::SetAccessControl($path,$acl)',
  ].join(';');
  powershell(script, { ACL_TEST_PATH: path, ACL_TEST_USERS_ALLOW: String(includeUsersAllow) });
}

function replaceWithCurrentUserOnlyAcl(path: string): void {
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ACL_TEST_PATH','Process')",
    '$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl=New-Object System.Security.AccessControl.FileSecurity',
    '$acl.SetOwner($current)',
    '$acl.SetAccessRuleProtection($true,$false)',
    '$allow=New-Object System.Security.AccessControl.FileSystemAccessRule($current,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)',
    '$acl.AddAccessRule($allow)',
    '[System.IO.File]::SetAccessControl($path,$acl)',
  ].join(';');
  powershell(script, { ACL_TEST_PATH: path });
}

function copyAuthorization(source: string, target: string): void {
  const descriptor = Buffer.from(authorization(source).combined_sddl, 'utf8').toString('base64');
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ACL_TEST_PATH','Process')",
    "$encoded=[Environment]::GetEnvironmentVariable('ACL_TEST_SDDL','Process')",
    '$sddl=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))',
    '$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access',
    '$acl=New-Object System.Security.AccessControl.FileSecurity',
    '$acl.SetSecurityDescriptorSddlForm($sddl,$sections)',
    '[System.IO.File]::SetAccessControl($path,$acl)',
  ].join(';');
  powershell(script, { ACL_TEST_PATH: target, ACL_TEST_SDDL: descriptor });
}

function protectExistingRules(path: string): void {
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ACL_TEST_PATH','Process')",
    '$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access',
    '$acl=[System.IO.File]::GetAccessControl($path,$sections)',
    '$acl.SetAccessRuleProtection($true,$true)',
    '[System.IO.File]::SetAccessControl($path,$acl)',
  ].join(';');
  powershell(script, { ACL_TEST_PATH: path });
}

function addExplicitAclRule(path: string, sid: string, type: 'Allow' | 'Deny'): void {
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('ACL_TEST_PATH','Process')",
    "$sid=New-Object System.Security.Principal.SecurityIdentifier([Environment]::GetEnvironmentVariable('ACL_TEST_RULE_SID','Process'))",
    "$type=[System.Enum]::Parse([System.Security.AccessControl.AccessControlType],[Environment]::GetEnvironmentVariable('ACL_TEST_RULE_TYPE','Process'))",
    '$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access',
    '$acl=[System.IO.File]::GetAccessControl($path,$sections)',
    '$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::ReadData,$type)',
    '$acl.AddAccessRule($rule)',
    '[System.IO.File]::SetAccessControl($path,$acl)',
  ].join(';');
  powershell(script, {
    ACL_TEST_PATH: path,
    ACL_TEST_RULE_SID: sid,
    ACL_TEST_RULE_TYPE: type,
  });
}

function duplicateSourcePath(sourcePath: string, token: string): string {
  return sourcePath.replace(/\.source\.[^.]+\.bak$/, `.source.${token}.bak`);
}

function recoveryFixture(): {
  repo: string;
  root: string;
  config: string;
  identity: string;
  sourceBackup: string;
} {
  const item = fixture();
  const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
  const identity = createConfigurePlanIdentity(prepared).identity;
  expectConfigureError(
    () => applyConfigurePlanIdentity(identity, {
      hooks: { afterCapture: () => { throw new Error('retain source for authorization consensus test'); } },
    }),
    'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
  );
  const sourceBackup = readdirSync(item.root)
    .map((name) => join(item.root, name))
    .find((path) => path.endsWith('.bak'))!;
  return { ...item, identity, sourceBackup };
}

function fixture(): { repo: string; root: string; config: string } {
  const repo = initGitRepo();
  const root = tempDir('eng-mcp-config-acl-');
  const config = join(root, 'config.toml');
  cleanup.push(repo, root);
  writeFileSync(config, 'setting = "source"\n');
  return { repo, root, config };
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

describe.skipIf(process.platform !== 'win32')('Safe Configure Windows authorization preservation', () => {
  it('preserves a protected restrictive DACL and deny ACE on target and retained backup', () => {
    const item = fixture();
    setProtectedAcl(item.config, false);
    const expected = authorization(item.config);
    expect(expected.access_rules_protected).toBe(true);
    expect(expected.dacl_sddl).toContain('(D;');

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    const result = applyPreparedConfigure(prepared);

    expectSameAuthorization(item.config, expected);
    expectSameAuthorization(result.backup_path!, expected);
  });

  it('preserves explicit allow entries without broadening inherited access', () => {
    const item = fixture();
    setProtectedAcl(item.config, true);
    const expected = authorization(item.config);

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    const result = applyPreparedConfigure(prepared);

    expectSameAuthorization(item.config, expected);
    expectSameAuthorization(result.backup_path!, expected);
  });

  it('preserves inherited/unprotected DACL state', () => {
    const item = fixture();
    const expected = authorization(item.config);
    expect(expected.access_rules_protected).toBe(false);

    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    const result = applyPreparedConfigure(prepared);

    expectSameAuthorization(item.config, expected);
    expectSameAuthorization(result.backup_path!, expected);
  });

  it('fails before capture when generic links work but the native object-bound preflight fails', () => {
    const item = fixture();
    setProtectedAcl(item.config, false);
    const sourceBytes = readFileSync(item.config);
    const expectedAuthorization = authorization(item.config);
    const genericSource = join(item.root, 'generic-link-source');
    const genericTarget = join(item.root, 'generic-link-target');
    writeFileSync(genericSource, 'generic hard-link capability');
    linkSync(genericSource, genericTarget);
    expect(readFileSync(genericTarget)).toEqual(readFileSync(genericSource));

    let captured = false;
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    const error = expectConfigureError(
      () => applyPreparedConfigure(prepared, {
        beforeHardLink: ({ kind }) => {
          if (kind === 'CAPABILITY_CHECK') throw new Error('injected native object-bound helper failure');
        },
        afterCapture: () => { captured = true; },
      }),
      'CONFIGURE_UNSUPPORTED',
    );

    expect(error.details?.cause).toContain('injected native object-bound helper failure');
    expect(captured).toBe(false);
    expect(existsSync(item.config)).toBe(true);
    expect(readFileSync(item.config)).toEqual(sourceBytes);
    expectSameAuthorization(item.config, expectedAuthorization);
    expect(readdirSync(item.root).filter((name) => name.endsWith('.bak'))).toEqual([]);
  });

  it('exercises native create-if-absent preflight before capture and then installs normally', () => {
    const item = fixture();
    const observed: Array<{ kind: string; captured: boolean }> = [];
    let captured = false;
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    const result = applyPreparedConfigure(prepared, {
      beforeHardLink: ({ kind }) => observed.push({ kind, captured }),
      afterCapture: () => { captured = true; },
    });

    expect(result.mode).toBe('APPLIED');
    expect(observed.filter((entry) => entry.kind === 'CAPABILITY_CHECK')).toEqual([
      { kind: 'CAPABILITY_CHECK', captured: false },
      { kind: 'CAPABILITY_CHECK', captured: false },
    ]);
    expect(observed).toContainEqual({ kind: 'INSTALL', captured: true });
  });

  it('keeps retained capability-probe authorization outside completed replay authority', () => {
    const item = fixture();
    setProtectedAcl(item.config, false);
    const expected = authorization(item.config);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
    const identity = createConfigurePlanIdentity(prepared).identity;
    const applied = applyConfigurePlanIdentity(identity);
    expect(applied.mode).toBe('APPLIED');

    const probePath = readdirSync(item.root)
      .filter((name) => name.includes('.linkcheck.'))
      .map((name) => join(item.root, name))
      .find((path) => existsSync(path))!;
    expect(probePath).toBeTruthy();

    replaceWithCurrentUserOnlyAcl(probePath);
    expect(authorization(probePath)).not.toEqual(expected);

    const replay = applyConfigurePlanIdentity(identity);
    expect(replay.mode).toBe('ALREADY_APPLIED');
    expectSameAuthorization(item.config, expected);
    expect(replay.retained_artifacts.every((path) => !path.includes('.linkcheck.'))).toBe(true);
    expect(replay.artifacts.every((artifact) => !artifact.path.includes('.linkcheck.'))).toBe(true);
  });

  it('fails before capture when proposed DACL readback no longer matches the source', () => {
    const item = fixture();
    const sourceBytes = readFileSync(item.config);
    const expected = authorization(item.config);
    const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });

    expectConfigureError(
      () => applyPreparedConfigure(prepared, {
        afterAuthorizationApplied: ({ proposedPath }) => replaceWithCurrentUserOnlyAcl(proposedPath),
      }),
      'CONFIGURE_SECURITY_PRESERVATION_FAILED',
    );

    expect(existsSync(item.config)).toBe(true);
    expect(readFileSync(item.config)).toEqual(sourceBytes);
    expectSameAuthorization(item.config, expected);
    expect(readdirSync(item.root).filter((name) => name.endsWith('.bak'))).toEqual([]);
  });

  it('rejects a proposal whose DACL change completes before final object binding', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const item = fixture();
      setProtectedAcl(item.config, false);
      const prepared = prepareConfigure({ host: 'codex', configPath: item.config, repo: item.repo, cwd: item.repo });
      expectConfigureError(
        () => applyPreparedConfigure(prepared, {
          beforeHardLink: ({ kind, sourcePath }) => {
            if (kind === 'INSTALL') replaceWithCurrentUserOnlyAcl(sourcePath);
          },
        }),
        'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
      );
      expect(existsSync(item.config)).toBe(false);
    }
  }, 120_000);

  it('accepts byte-identical SOURCE artifacts only when their authorization is identical', () => {
    const item = recoveryFixture();
    const duplicate = duplicateSourcePath(item.sourceBackup, '000-identical');
    copyFileSync(item.sourceBackup, duplicate);
    copyAuthorization(item.sourceBackup, duplicate);

    const result = applyConfigurePlanIdentity(item.identity);
    expect(result.mode).toBe('ALREADY_APPLIED');
    expect(semanticAuthorization(authorization(item.config))).toEqual(semanticAuthorization(authorization(item.sourceBackup)));
  });

  it('accepts equivalent unprotected SOURCE authorization when only auto-inherited SDDL bookkeeping differs', () => {
    const item = recoveryFixture();
    const duplicate = duplicateSourcePath(item.sourceBackup, '000-auto-inherited-normalized');
    copyFileSync(item.sourceBackup, duplicate);
    copyAuthorization(item.sourceBackup, duplicate);

    const toggleAutoInherited = (sddl: string): string =>
      sddl.includes('D:AI') ? sddl.replace('D:AI', 'D:') : sddl.replace('D:', 'D:AI');

    const result = applyConfigurePlanIdentity(item.identity, {
      hooks: {
        observeWindowsAuthorization: ({ path, actual }) => path === duplicate
          ? {
              ...actual,
              dacl_sddl: toggleAutoInherited(actual.dacl_sddl),
              combined_sddl: toggleAutoInherited(actual.combined_sddl),
            }
          : actual,
      },
    });

    expect(result.mode).toBe('ALREADY_APPLIED');
    expectSameAuthorization(item.config, authorization(item.sourceBackup));
  });

  for (const [type, sid] of [
    ['Allow', 'S-1-5-32-545'],
    ['Deny', 'S-1-5-32-546'],
  ] as const) {
    it(`rejects byte-identical SOURCE artifacts with an extra ${type.toLowerCase()} ACE`, () => {
      const item = recoveryFixture();
      const duplicate = duplicateSourcePath(item.sourceBackup, `extra-${type.toLowerCase()}`);
      copyFileSync(item.sourceBackup, duplicate);
      copyAuthorization(item.sourceBackup, duplicate);
      addExplicitAclRule(duplicate, sid, type);

      expect(semanticAuthorization(authorization(duplicate))).not.toEqual(
        semanticAuthorization(authorization(item.sourceBackup)),
      );

      const error = expectConfigureError(
        () => applyConfigurePlanIdentity(item.identity),
        'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
      );
      const conflicts = error.details!.conflicting_source_authorizations as Array<{
        authorization: { fingerprint: string };
      }>;
      expect(new Set(conflicts.map((entry) => entry.authorization.fingerprint)).size).toBe(2);
      expect(existsSync(item.config)).toBe(false);
    });
  }

  for (const token of ['000-divergent-first', 'zzz-divergent-last']) {
    it(`rejects byte-identical SOURCE artifacts with divergent protected DACL regardless of pathname order (${token})`, () => {
      const item = recoveryFixture();
      const duplicate = duplicateSourcePath(item.sourceBackup, token);
      copyFileSync(item.sourceBackup, duplicate);
      copyAuthorization(item.sourceBackup, duplicate);
      setProtectedAcl(duplicate, true);

      const error = expectConfigureError(
        () => applyConfigurePlanIdentity(item.identity),
        'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
      );
      const conflicts = error.details!.conflicting_source_authorizations as Array<{
        path: string;
        authorization: { fingerprint: string };
      }>;
      expect(new Set(conflicts.map((entry) => entry.authorization.fingerprint)).size).toBe(2);
      expect(existsSync(item.config)).toBe(false);
    });
  }

  it('rejects byte-identical SOURCE artifacts with different owners', () => {
    const item = recoveryFixture();
    const duplicate = duplicateSourcePath(item.sourceBackup, 'owner-divergent');
    copyFileSync(item.sourceBackup, duplicate);
    copyAuthorization(item.sourceBackup, duplicate);

    expectConfigureError(
      () => applyConfigurePlanIdentity(item.identity, {
        hooks: {
          observeWindowsAuthorization: ({ path, actual }) => {
            if (path !== duplicate) return actual;

            const useSystem = actual.owner_sid === 'S-1-5-32-544';
            const ownerSddl = useSystem ? 'O:SY' : 'O:BA';

            return {
              ...actual,
              owner_sddl: ownerSddl,
              combined_sddl: `${ownerSddl}${actual.dacl_sddl}`,
              owner_sid: useSystem ? 'S-1-5-18' : 'S-1-5-32-544',
            };
          },
        },
      }),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(existsSync(item.config)).toBe(false);
  });

  it('rejects byte-identical SOURCE artifacts with different inheritance protection state', () => {
    const item = recoveryFixture();
    const duplicate = duplicateSourcePath(item.sourceBackup, 'protection-divergent');
    copyFileSync(item.sourceBackup, duplicate);
    copyAuthorization(item.sourceBackup, duplicate);
    protectExistingRules(duplicate);
    expect(authorization(duplicate).access_rules_protected).toBe(true);
    expect(authorization(item.sourceBackup).access_rules_protected).toBe(false);

    expectConfigureError(
      () => applyConfigurePlanIdentity(item.identity),
      'CONFIGURE_MANUAL_RECOVERY_REQUIRED',
    );
    expect(existsSync(item.config)).toBe(false);
  });
});
