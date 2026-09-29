# Phase 3B0-R5E: pre/post Userenv Worker profile binding

This is isolated development validation, not production admission. Production
remains **HOLD**. R5B, R5C and R5D rejected filesystem-handle pinning:
metadata-only opens did not exclude DELETE, while share-participating opens
blocked normal `NTUSER.DAT` loading and Windows assigned a TEMP profile.

The trusted `execution-worker.exe` authenticates the configured Worker with
`LogonUserW(LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT)`, verifies its
SID, non-administrator groups, Medium integrity and unelevated token, then
calls `GetUserProfileDirectoryW` on that token. Failure is
`PROFILE_NOT_PROVISIONED`; it creates no child. The returned path is bounded,
fully qualified local-drive path, NUL-free and normalized. It is not derived from the username. The
runtime does not open the profile root, `NTUSER.DAT`, or provider content.

It next calls `CreateProcessWithLogonW(LOGON_WITH_PROFILE)` with the explicit
application path, checked command line, intended working directory,
`CREATE_SUSPENDED | CREATE_NO_WINDOW`, and `lpEnvironment = NULL`. There is no
logon-flags-0 or minimal-environment fallback. Before the child is resumed,
the launcher opens its token, repeats Worker role checks, and calls
`GetUserProfileDirectoryW` on the **child token**. Its normalized path must
equal the preflight path. Any failure or mismatch, including a TEMP profile,
is `PROFILE_BINDING_REFUSED`: the suspended child is terminated and waited,
without running the Harness. Only after this gate do the existing Job checks,
assignment and task protocol continue.

The same bounded password buffer serves `LogonUserW` and
`CreateProcessWithLogonW`. It is zeroed on success and every failure path.
The preflight token's non-inheritable handle state is checked. It is not impersonated, inherited, persisted or passed to
the child; it is closed after the post-check. The existing only-three-pipes
inheritance boundary remains in force. Runtime never calls `CreateProfile`,
`LoadUserProfile` or `DeleteProfile`, mutates ProfileList, or repairs profiles.
Provisioning remains an explicit operator action: create a dedicated Worker
account, call `CreateProfile`, prepare its provider state and validate its ACL.

The runtime verifies profile registration before process creation and verifies
the profile bound to the suspended child after `CreateProcessWithLogonW`
returns. **It does not atomically lock the Windows ProfileList registry
state.** Concurrent privileged mutation by Administrator or Operator is
outside the current single-trusted-operator threat model. Kernel compromise
is also outside that model.

The isolated test uses disposable Core, Keeper and Worker standard users, a
fake provider marker and a deterministic fake Harness. It verifies missing
and stale registrations are refused before child creation; a provisioned
Worker has the expected SID, profile environment, HKCU marker, provider
access, Job membership and protocol; Core and Keeper cannot read the marker.
An external administrator fixture deliberately makes the provisioned hive
unloadable after preflight. The real launcher must refuse or kill a suspended
TEMP-bound child before Harness entry. These fixtures do not use production
accounts, repositories, credentials, Bridge, Broker or ledger.
