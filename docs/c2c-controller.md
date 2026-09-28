# Production C2C controller

The formally supported companion entrypoint is documented in
[Stable private C2C client contract](c2c-private-contract.md). The direct
`--enable-c2c-controller` form below remains the operator-facing controller
entrypoint; the companion uses `engineering-mcp c2c-client`.

The controller is an explicit OWNER-only production entrypoint. It orchestrates
four existing frozen APIs; it is not a new lifecycle, scheduler, reservation,
provider router, or arbitrary execution service.

## Enablement and deployment identity

Only an explicitly opted-in OWNER server registers `execute_c2c_plan`:

```text
engineering-mcp --role owner --repo <canonical-repository> --enable-c2c-controller
```

Source checkout equivalent (after installing the repository dependencies):

```text
node src/cli.ts --role owner --repo <repository> --enable-c2c-controller
```

An external trusted WorkerProfile file can be supplied with the existing
`--worker-profiles <absolute-path>` option. Supplying profiles never enables the
controller. The built-in Codex target retains all its original admission rules;
this entrypoint does not broaden which external profiles qualify as Codex V1.

Ordinary `--role owner` remains unchanged. JUNIOR/PRINCIPAL plus this flag fails
at startup, before repository/ledger opening. No environment variable, host name,
profile presence, setup snippet, or Safe Configure action enables this capability.
The existing ordinary `delegate_task` capability remains unchanged; this opt-in
specifically controls the additional C2C production entrypoint.

The actual server process writes one JSON startup record to stderr after tool
registration. Its fields are `event=c2c_controller_enabled`, `pid`, `username`
(or null if unavailable), `role=OWNER`, canonical `repo_root`, and
`tool=execute_c2c_plan`. No environment, config, credentials or child output are
logged by this record. When launched through the CLI wrapper, bind the PID from
this record, not the wrapper PID or a historical test runner PID.

The controller -> C2C Worker Runner -> exact Harness chain inherits OS identity
and environment. Code wiring does not certify a deployed account. Select and
launch a designated controller under the intended Windows account, then bind its
PID/SID using the existing external manual probe. No account switch or privileged
SID helper is added here. Existing interactive Codex/Grok host configurations
are not modified or silently upgraded to controllers.

## Public input

```json
{
  "plan_message": {
    "protocol_version": "engineering-c2c/1",
    "message_id": "stable-plan-id",
    "task_id": "already-created-task-id",
    "sender_role": "OWNER",
    "state": "PLAN",
    "expected_revision": 1,
    "goal": "Describe the proposed plan"
  },
  "acceptance_command_id": "stable-acceptance-id",
  "delegation_command_id": "stable-delegation-id",
  "worker_profile_id": "trusted-profile-name"
}
```

The four top-level fields are required. Additional fields are rejected. The
nested message uses the frozen strict C2C schema and bounded parser; non-PLAN
messages do not enter execution orchestration. `sender_role` is only a consistency
claim, not authentication. Actual authority comes from process role, explicit
startup opt-in, server canonical repository, and authoritative Store.

Task existence, payload and scope remain authoritative. This tool never creates
a task, changes its payload, resumes, recovers, claims, reports or checkpoints it.
A fresh acceptance requires the existing exact READY revision. Use the ordinary
explicit OWNER lifecycle workflow before submitting a new PLAN where necessary.

No executable, argv, environment, cwd/repository override, DB path, adapter,
target schema, manifest, launch spec, PID, or runner/execution identity is a tool
argument. `worker_profile_id` selects only startup-loaded trusted configuration.

## Ordered phases and replay

```text
durableEvaluateC2CMessage()
  -> acceptEvaluatedPlan()
  -> createAcceptedDispatchIntent()
  -> launchControlledC2CWorker()
```

Each phase keeps its own existing transaction and receipt. Rejection stops later
phases. A committed earlier phase is NOT rolled back when a later phase rejects,
throws, or loses its response. The caller must retain the exact PLAN and all
three stable identities (message, acceptance, delegation) when retrying. The
server does not synthesize replacement command IDs.

After evaluation response loss, retry reuses the original evaluation. After
acceptance loss it also reuses acceptance. After delegation loss it also reuses
the original dispatch and durable target, even if current profiles/manifests
changed. After launch loss, the same dispatch is passed to the frozen launch
controller. A READY/launching dispatch may have another physical attempt; the
existing authoritative claim fence still permits only one execution. An already
claimed or terminal dispatch does not spawn again. Inconsistent state fails
closed through the existing launch implementation.

A reused message/command ID with different content/identity is not a request to
replace the target. There is no fallback profile. No new controller receipt,
mega-transaction, schema migration or writer-generation change exists.

## Output and observation limits

The structured response and text content contain the same allowlisted projection:

- PLAN/task identifiers and final attempted phase;
- evaluation decision/revision, acceptance decision/ID/revision;
- delegation decision/ID/dispatch/profile identifiers;
- on success, launch state plus task/dispatch status snapshot and two physical
  observation booleans.

`ok: true` means the ordered controller calls returned, NOT task completion.
`physical_spawn_requested` means the frozen launcher returned `SPAWNED`;
`physical_spawn_observed` means its synchronous callback supplied a non-null PID.
Neither proves an authoritative claim, successful Harness execution, or terminal
result. A physical spawn failure can leave a valid launching dispatch for retry.
The projection is a point-in-time snapshot, not a live state feed. Existing task,
dispatch and S2 APIs remain the sources for subsequent state/evidence.

Rejections preserve the frozen phase error code. Unexpected exceptions return
`CONTROLLER_PHASE_FAILED` plus a fixed message and completed-phase projections.
Raw upstream exceptions, launch specs, profiles/manifests, environment and child
streams are not copied into controller output. No additional controller record
is written to the ledger.

## Validation and provider boundary

Tests exercise the public tool through in-memory MCP and through the real public
CLI/stdio server. Deterministic native GenericCli fixtures exercise the full
physical Worker/claim/adapter/terminal path. Codex compatibility uses the existing
frozen builder/exact consumer and trusted test seams, never real model quota.
Four after-phase response-loss simulations reopen the Store and retry identical
requests; concurrency, conflicts, strict input, non-READY states and safe output
are checked. Temporary fixtures, child processes and run directories belong to
the tests and are cleaned up.

The controller branches on no provider and adds no backend. Codex and GenericCli
V1 semantics remain frozen. Grok bridge/authentication and DSH/DeepSeek are not
part of this change.

```text
SCHEMA_VERSION = 12
WRITER_PROTOCOL_GENERATION = 4
```

Once this entrypoint is validated and an operator deploys a designated controller,
the next Grok step is PID/account binding, same-context Phase-2 metadata probing,
and dedicated Worker config/auth isolation. This code does not perform those
deployment or certification steps automatically.

## Validation record (2026-09-19)

The implementation was exercised through the fixed Desktop Bridge project tasks.

- Type checking: exit 0, job `1d6e6c1f-098e-46ad-afc7-45bae90e85b1`.
- Production build: exit 0, job `3ea8893a-6b9e-4380-a804-694508a19adf`;
  `dist/c2c/controller.js` was produced.
- Expanded targeted regression: 28 files, 423 tests; 422 passed, 1 failed;
  job `1904c70c-1322-4e5f-9d62-55889186f67b`. The sole failure was the
  pre-existing `public-cli.test.ts` Configure apply case. All 36 new controller
  tests passed, including the real CLI/stdio/native-fixture path.
- Initial test development exposed a Writable/PassThrough type annotation and
  four assertions expecting an error return where the installed MCP SDK rejects
  an unknown tool call with ProtocolError. These test-only mistakes were fixed;
  production admission was not loosened to make them pass.
- The previous Phase-2 call-site tests were updated from 'no production caller'
  to exactly the controller plus each primitive definition. All Phase-2 probe,
  authentication, metadata and isolation assertions remain unchanged. Earlier
  NOT WIRED reports describe the historical state, not deployment certification.

Four new after-phase tests simulate response loss after real committed API calls,
then reopen the Store. They are not new OS process-kill tests; the existing
primitive crash/migration tests remain separately covered by the regression run.
The native GenericCli fixture executes as a real subprocess. The Codex controller
compatibility test uses frozen builder/exact-consumer test seams and fake output,
not a real Codex model invocation. No live Grok/Luna/DSH request was made.

### Complete regression

The complete suite was run with the already accepted six-way Vitest sharding
procedure, following earlier monolithic runs reaching the fixed 600-second task
limit. No monolithic pass is claimed for this stage. Every listed shard reached
an actual Vitest final summary.

| Shard | Files | Passed | Failed | Exit code | Job |
| --- | ---: | ---: | ---: | ---: | --- |
| 1/6 | 10 | 190 | 1 | 1 | `c2b02319-9f0f-4847-ae9b-ac055dcaf5be` |
| 2/6 | 10 | 104 | 19 | 1 | `9040382c-c46a-4b94-a7ea-321462610670` |
| 3/6 | 10 | 110 | 29 | 1 | `b3b6b619-7be7-42da-9446-2577b499e66c` |
| 4/6 | 10 | 85 | 1 | 1 | `6f3925e3-1e93-4ddc-b919-ef8a2d0ab822` |
| 5/6 first run | 10 | 70 | 1 | 1 | `03bfe13e-107c-41df-8c7e-32c3d36c9cda` |
| 6/6 | 10 | 60 | 0 | 0 | `014901ca-22e7-4b1e-ab8a-41a154214bdc` |
| 5/6 independent rerun | 10 | 71 | 0 | 0 | `53024c1c-8a56-46e1-93b1-bea1e64c2d1f` |

Initial aggregate: **60 files, 670 tests; 619 passed, 51 failed**. One additional
failure occurred in the existing `codex-registry-integration.test.ts` teardown:
`afterEach -> removeDir -> rmSync` returned EPERM on its temporary repository.
The task-completion assertions were not the reported failure. The test removes
its directories immediately after observing terminal state without waiting for
the spawned process to release its cwd. The exact locking actor was not measured.

After all identified initial shard jobs completed, the entire shard 5 was rerun
without changing that test, production code, permissions, ACL or safe.directory:
**71/71 passed**. Using this rerun for shard 5 gives **54 passed files + 6 failed
files; 620 passed tests + 50 failed tests**, still 60 files / 670 tests overall.
The original error is retained above; the initial run was not green. The original
failed legacy teardown path was not independently re-inspected or cleaned after
recovery, so no system-wide temporary-directory cleanup is claimed.

The persistent failures are unchanged from the supplied baseline:
Configure transaction 18, Windows ACL 7, Configure 12, public CLI Configure apply 1,
mixed-version 11, release-migration 1. All new controller cases passed in both
expanded targeted and complete regression. The 43 existing Grok reconciliation /
manual-probe / Phase-2 tests are not new controller tests; this stage adds 36
controller tests across two files.

The Bridge returned intermittent upstream 502 errors during result retrieval and
an attempted shard rerun. An attempt without a returned job ID has no verifiable
result and is not counted. Only the identified completed jobs above are used.
Recovery restored and reread the actual package script as `"test": "vitest run"`.
No .only / skip bypass was introduced. The controller tests' own child-process
and temporary-fixture cleanup completed; existing unrelated work was not removed.

Production code wiring: **WIRED**. This is not a deployment or Worker identity
certificate. No persistent designated controller was deployed and no live Grok,
Luna or DSH model was invoked. Final Worker account/config binding remains an
explicit subsequent deployment step.
