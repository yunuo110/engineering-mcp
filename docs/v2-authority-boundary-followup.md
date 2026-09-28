# V2 authority-boundary follow-up

Status: **HOLD**. This is isolated development, not production acceptance.
Public restricted-Worker execution E2E, real models, model-profile migration,
and production remain outside this change.

## Implemented boundaries

- Default Generic, C2C Generic, and Codex/Luna adapters use the native restricted
  Worker transition. Runner remains Core-token authority. Missing provisioning
  refuses launch; there is no same-token Harness fallback.
- Actual Worker token verification checks distinct role SIDs, raw native
  Administrators membership including deny-only/disabled entries, Medium
  integrity and non-elevation. Keeper separately rejects raw Administrators
  membership without changing Core/Runner token policy.
- Development credentials use a dedicated inherited descriptor 3 into Core,
  then an anonymous helper input channel. No credential argv/env/file is added.
  Core's CLI wrapper closes its descriptor after transfer. Native readers own
  their OS handles and clear partial buffers. This is not a production
  credential storage/rotation design.
- Controller preserves the same dispatch reservation after ambiguous launch
  failure. Durable `ledger_metadata` launch state and repository dispatch/claim
  history gate claim, delegation, physical launch, checkpoint and recovery.
  Task cancel/close does not establish physical drain. No schema migration.
- Protected runtime preflight binds one repository and ledger, validates its
  mutable boundary and ancestor ACLs, and provisions/checks split witness ACLs.
  Bad/missing security evidence refuses launch or produces UNKNOWN.
- Dispatcher callbacks use transactional guarded narrow updates. EWP and Core
  reject explicit contradictory completion without upgrading reported evidence
  to independent verification.
- Runtime closure includes both Runner entries and all four native process
  entries. Nonliteral reachable imports remain refused.
- The Windows authority Git gateway uses a positive configuration schema,
  bounded environment, locked configuration/ancestor paths and disabled hooks.
  It refuses independently controlled submodule configurations rather than
  starting implicit nested Git processes under Core.

## Standard versus protected mode

Standard package installation, CLI initialization and OWNER task-management
tools do not require protected staging config. This does **not** provision a
Worker identity. Per the OWNER's Phase 2B.4 decision, ordinary generic
delegation without such an identity terminates BLOCKED with
`WORKER_PROCESS_FAILED`; the task blocker carries
`WORKER_IDENTITY_REFUSED:not provisioned`. There is no same-token Harness
fallback. Ordinary OWNER delegation is explicitly unavailable in protected
mode. A standard-mode alternate-identity execution source is not authorized
by this milestone.
The authority Git gateway currently requires Windows; cross-platform standard
package compatibility is not established by this milestone.

The earlier R13 staging script is historical evidence, not a deployment recipe
for these changes. It describes bootstrap build `/1`, a two-field identity frame
and the earlier binding. This implementation requires build `/2`, four fields,
`workerLauncherPath`, `authorityGitPath`, `repositoryPath` and `ledgerPath`.
Do not execute the old script or reuse its stage as current acceptance proof.

## Regression migration boundaries

`c2c-controlled-launch.test.ts` and `c2c-controller.test.ts` now use a Vitest-only
native boundary while retaining actual Store, reservation, occupancy, Runner,
receipt and lifecycle assertions. They do not prove Windows identities, Job
handoff or real Harness execution. Ambiguous physical failure now retains
occupancy and cannot authorize a second physical root; a delayed original
Runner claim remains non-authoritative to the callback.

`c2c-generic-cli-e2e.test.ts` now calls the current controlled-bootstrap API.
Its 16 assertions pass with the actual Store, Runner/lifecycle, frozen target,
native fake Harness process, EWP parsing and Git observations. Only native
bootstrap and restricted-token transition are test seams. These assertions
are not cross-SID, Job or protected-staging acceptance. The real protected
fixture host, four-field identity provisioning, staging binding and
worker-writable output layout still require integration.

The unstaged `src/index.ts` C2C stdio and ingress smoke expectations were
retired as positive protected-launch assertions: mandatory trusted-runtime
preflight now refuses them before the ledger opens. The exact private tool
surface and missing-task/no-durable-row behavior remain covered in
`c2c-controller.test.ts` and `c2c-ingress-v1.test.ts`; a real stdio positive
smoke requires a freshly staged protected runtime and remains an acceptance
gate. The packed standard-mode test still installs and initializes the package,
exercises OWNER tools and the built-in stub, and now asserts that unprovisioned
generic execution is BLOCKED. Its ignored-file scope assertion executes the
installed Runner logic through an explicit in-process fixture, not through a
Worker SID. The worker-profile tests verify that the startup-captured manifest
bytes are dispatched, while execution remains fail-closed without a Worker
identity. None of these synthetic seams is cross-SID evidence.

Two old expectations changed intentionally:

| OLD CONTRACT | NEW CONTRACT | WHY CHANGE IS INTENTIONAL |
| --- | --- | --- |
| A failed physical launch callback could release the reservation and launch another root. | An ambiguous bootstrap launch retains the original repository reservation; a callback cannot authorize a second root. | A callback is not proof that the first child does not exist. |
| `claim_next` could skip a C2C-reserved Task A and claim Task B in the same repository. | Repository-level occupancy denies Task B while A's execution group is UNKNOWN. | Task status alone cannot prove exclusive workspace ownership. |

Submodule checkpoint contract: **unsupported**. The native authority Git
gateway refuses an indexed gitlink and rejects repository `submodule.*.url`
configuration before it runs a Core/Runner authority operation. This currently
applies to both standard and protected execution paths. The old positive test
for checkpointing an unrelated parent file while preserving an unchanged
gitlink has intentionally become a repository-admission refusal. Nested
repository dirt, submodule HEAD advance and removed gitlinks must leave Git
HEAD, checkpoint refs and ledger checkpoint rows unchanged. A supported
submodule contract requires a separate locked configuration/recursive-operation
design and is outside this milestone.

## Phase 2B.4 CI evidence policy

Iteration uses local typecheck, build, and affected targeted tests. Ordinary
pushes run `Core Fast CI` on Ubuntu, Windows, and macOS; the Windows job also
runs the fixed contract-test subset. The Vitest setup currently uses Windows
`where.exe`, so non-Windows jobs do not claim unit-test coverage.

`Core Windows Full Regression` runs on pull requests and manual workflow
dispatch, not ordinary pushes. It performs a clean install, typecheck, build,
and the unchanged `npm test`. On a pull request it checks out and records the
actual branch HEAD, not GitHub's synthetic merge commit. Its green result can
replace the final local generic Core regression only when the recorded
`TESTED_COMMIT_SHA` equals
the Phase 2B.4 frozen commit SHA. Any later source change makes that result
stale. The PR run metadata may show a synthetic merge SHA; use the checkout
verification step as the tested-byte evidence. Record the repository, branch,
commit SHA, run URL, job conclusion, and Vitest summary before claiming this gate.
The first isolated-branch full run uses a pull request; manual dispatch is
available only after the default-branch workflow enables that event.

Hosted CI does not validate local-host SID, token, DACL, owner, Job Object,
Keeper, protected staging, restricted Worker, process, or handle evidence.
That isolated host acceptance remains a separate required gate. CI does not
use production credentials, ledger, accounts, or real Codex/Grok sessions.

## Acceptance still required

1. All typecheck and regression failures resolved without dropping assertions.
2. An actual operator-owned development host and fresh protected staging,
   exercised through the same Controller identity channel, not direct helper
   launch substituted for public plumbing.
3. Real disposable standard-user evidence for all adapter paths, Worker
   filesystem/pipe/handle/environment denial and cross-SID Git sentinels.
4. Actual split witness owner/ACL acceptance, including parent attacks and
   invalid-security evidence refusing consumption.
5. Full pre-handoff failure injection matrix and exact child/account cleanup.

Native no-account tests cover partial-buffer cleanup, owned anonymous pipe
closure/shutdown races, role/admin group rejection and exact suspended-child
termination. They do not prove successful alternate-identity execution or that
every injected native failure has been tested. No disposable accounts were
created during this follow-up, so there are no newly created accounts to retain.

Companion independently closes unauthenticated local authority, separates Work
from raw C2C, refuses independent HTTP writes and requires a trusted absolute
Core host with one-time identity transport. Its host remains unprovisioned;
unit transport tests are not public execution acceptance.
