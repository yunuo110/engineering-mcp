import { describe, expect, it } from 'vitest';
import { assertProtectedCredentialAcl, type ProtectedPathAcl } from '../src/orchestration/trusted-runtime.ts';

const identity = { operatorSid: 'UNIT_OPERATOR', coreSid: 'UNIT_CORE',
  keeperSid: 'UNIT_KEEPER', workerSid: 'UNIT_WORKER' };
const FULL = 2032127;
const RX = 1179817;
const READ = 1179785;
type Ace = ProtectedPathAcl['aces'][number];
function ace(sid: string, rights: number, extra: Partial<Ace> = {}): Ace {
  return { sid, rights, type: 'Allow', inherited: false, inheritOnly: false,
    containerInherit: false, objectInherit: false, ...extra };
}
function row(kind: 'directory' | 'file'): ProtectedPathAcl {
  return { path: 'UNIT_ONLY_CREDENTIAL_OBJECT', owner: identity.operatorSid,
    protected: true, reparse: false, sddl: 'UNIT_ONLY_SDDL', aces: [
      ace(identity.operatorSid, FULL), ace('S-1-5-18', FULL),
      ace(identity.coreSid, kind === 'directory' ? RX : READ),
    ] };
}

describe('production credential ACL policy', () => {
  it.each(['directory', 'file'] as const)('accepts exact protected %s descriptor', (kind) => {
    expect(() => assertProtectedCredentialAcl(row(kind), kind, identity)).not.toThrow();
  });
  it.each([identity.keeperSid, identity.workerSid, 'S-1-5-11', 'S-1-5-32-545', 'S-1-1-0'])(
    'refuses extra read grant to %s', (sid) => {
      const value = row('file'); value.aces.push(ace(sid, READ));
      expect(() => assertProtectedCredentialAcl(value, 'file', identity)).toThrow(/credential/);
    });
  it('refuses wrong owner, inheritance, reparse and missing Core read', () => {
    for (const value of [
      { ...row('file'), owner: identity.coreSid },
      { ...row('file'), protected: false },
      { ...row('file'), reparse: true },
      { ...row('file'), aces: row('file').aces.slice(0, 2) },
    ]) expect(() => assertProtectedCredentialAcl(value, 'file', identity)).toThrow(/credential/);
  });
  it('refuses deny, inherited, inherit-only, inherited-child and wrong-rights ACEs', () => {
    for (const extra of [{ type: 'Deny' }, { inherited: true }, { inheritOnly: true },
      { containerInherit: true }, { objectInherit: true }, { rights: FULL }]) {
      const value = row('directory'); value.aces[2] = ace(identity.coreSid, RX, extra as Partial<Ace>);
      expect(() => assertProtectedCredentialAcl(value, 'directory', identity)).toThrow(/credential/);
    }
  });
  it('refuses SID collision with Keeper or Worker', () => {
    expect(() => assertProtectedCredentialAcl(row('file'), 'file',
      { ...identity, keeperSid: identity.coreSid })).toThrow(/credential SID collision/);
  });
});
