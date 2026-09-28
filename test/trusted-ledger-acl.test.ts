import { describe, expect, it } from 'vitest';
import { assertProtectedLedgerAcl, type ProtectedPathAcl } from '../src/orchestration/trusted-runtime.ts';

// Policy-only identities. No account, Windows token, ACL or production SID is
// created or impersonated by this test; real cross-SID acceptance stays separate.
const identities = { coreSid: 'UNIT_CORE', operatorSid: 'UNIT_OPERATOR',
  keeperSid: 'UNIT_KEEPER', workerSid: 'UNIT_WORKER' };
const read = 1179817;
const full = 2032127;
function ace(sid: string, rights: number, extra: Partial<ProtectedPathAcl['aces'][number]> = {}) {
  return { sid, rights, inherited: false, type: 'Allow', inheritOnly: false,
    containerInherit: false, objectInherit: false, ...extra };
}
function acl(extra: Partial<ProtectedPathAcl> = {}): ProtectedPathAcl {
  return { path: 'UNIT_ONLY_BOUND_PATH', owner: identities.coreSid, protected: true,
    reparse: false, sddl: 'UNIT_ONLY_NOT_SDDL', aces: [ace(identities.coreSid, full),
      ace(identities.operatorSid, full), ace('S-1-5-18', full), ace('S-1-5-32-544', full),
      ace(identities.keeperSid, read), ace(identities.workerSid, read)], ...extra };
}

describe('protected ledger ACL read-only policy', () => {
  it.each(['directory', 'file', 'ancestor'] as const)('accepts a trusted-owner %s without untrusted mutations', (kind) => {
    expect(() => assertProtectedLedgerAcl(acl(), kind, identities)).not.toThrow();
  });
  it.each([identities.keeperSid, identities.workerSid, 'UNIT_UNTRUSTED_GROUP'])(
    'refuses %s as owner even with read-only explicit ACL', (owner) => {
      expect(() => assertProtectedLedgerAcl(acl({ owner }), 'file', identities)).toThrow(/owner\/reparse\/ACL/);
    });
  it.each([0x2, 0x4, 0x10, 0x100, 0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000])(
    'refuses nontrusted ledger file or parent mutation access mask %i', (rights) => {
      for (const sid of [identities.keeperSid, identities.workerSid, 'UNIT_UNTRUSTED_GROUP']) {
        const value = acl(); value.aces.push(ace(sid, rights));
        for (const kind of ['directory', 'file'] as const)
          expect(() => assertProtectedLedgerAcl(value, kind, identities)).toThrow(/mutation access/);
      }
    });
  it.each([0x40, 0x10000, 0x40000, 0x80000])('refuses ancestor replace/security mutation access mask %i', (rights) => {
    const value = acl(); value.aces.push(ace('UNIT_UNTRUSTED_GROUP', rights, { inherited: true }));
    expect(() => assertProtectedLedgerAcl(value, 'ancestor', identities)).toThrow(/ancestor mutation access/);
  });
  it('does not mistake an ancestor InheritOnly ACE for access to the ancestor itself', () => {
    const value = acl(); value.aces.push(ace('UNIT_UNTRUSTED_GROUP', full,
      { inheritOnly: true, containerInherit: true, objectInherit: true }));
    expect(() => assertProtectedLedgerAcl(value, 'ancestor', identities)).not.toThrow();
    expect(() => assertProtectedLedgerAcl(value, 'file', identities)).not.toThrow();
    // A missing ledger and new witness children inherit this grant: deny it on
    // the nearest existing boundary directory, not just the future file.
    expect(() => assertProtectedLedgerAcl(value, 'directory', identities)).toThrow(/mutation access/);
  });
  it('rejects ancestor and boundary reparse entries', () => {
    for (const kind of ['ancestor', 'directory', 'file'] as const)
      expect(() => assertProtectedLedgerAcl(acl({ reparse: true }), kind, identities)).toThrow(/reparse/);
  });
  it('accepts translated TrustedInstaller ownership only for an OS ancestor', () => {
    const trustedInstallerSid = 'UNIT_TRANSLATED_TRUSTED_INSTALLER';
    const value = acl({ owner: trustedInstallerSid }); value.aces.push(ace(trustedInstallerSid, full));
    const translated = { ...identities, trustedInstallerSid };
    expect(() => assertProtectedLedgerAcl(value, 'ancestor', translated)).not.toThrow();
    for (const kind of ['directory', 'file'] as const)
      expect(() => assertProtectedLedgerAcl(value, kind, translated)).toThrow(/owner\/reparse\/ACL/);
    expect(() => assertProtectedLedgerAcl(value, 'ancestor', identities)).toThrow(/owner\/reparse\/ACL/);
  });
  it('accepts OWNER_RIGHTS ReadPermissions plus Synchronize used to suppress implicit WRITE_DAC', () => {
    const value = acl(); value.aces.push(ace('S-1-3-4', 1179648,
      { containerInherit: true, objectInherit: true }));
    for (const kind of ['directory', 'file', 'ancestor'] as const)
      expect(() => assertProtectedLedgerAcl(value, kind, identities)).not.toThrow();
    value.aces.push(ace('S-1-3-4', 0x40000));
    expect(() => assertProtectedLedgerAcl(value, 'directory', identities)).toThrow(/mutation access/);
  });
  it('does not treat a Deny ACE as an unsafe grant, and conservatively rejects unsafe Allow despite Deny', () => {
    const value = acl(); value.aces.push(ace('UNIT_UNTRUSTED_GROUP', full, { type: 'Deny' }));
    expect(() => assertProtectedLedgerAcl(value, 'file', identities)).not.toThrow();
    value.aces.push(ace('UNIT_UNTRUSTED_GROUP', full));
    expect(() => assertProtectedLedgerAcl(value, 'file', identities)).toThrow(/mutation access/);
  });
  it('rejects missing ACL/flag evidence and SID collisions', () => {
    expect(() => assertProtectedLedgerAcl(acl({ aces: [] }), 'file', identities)).toThrow(/ACL/);
    const value = acl(); delete (value.aces[0] as Partial<ProtectedPathAcl['aces'][number]>).inheritOnly;
    expect(() => assertProtectedLedgerAcl(value, 'file', identities)).toThrow(/probe malformed/);
    expect(() => assertProtectedLedgerAcl(acl(), 'file', { ...identities, workerSid: identities.coreSid }))
      .toThrow(/SID collision/);
  });
});
