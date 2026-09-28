# Stable private C2C client contract

Engineering MCP Core owns the private companion compatibility surface described
here. Its contract version is `engineering-c2c/1`.

This is a Core-to-companion interface. It is not a ChatGPT-facing public tool.
The companion may expose `engineering_execute_c2c_plan`, but it must forward
that request to the single private Core operation `execute_c2c_plan`. It must
not publish `execute_c2c_plan` as another ChatGPT alias.

## Supported invocation

Install Engineering MCP Core so its package command is available, then start the
private client:

```text
engineering-mcp c2c-client --contract-version engineering-c2c/1 --repo <canonical-repository>
```

Optional Core-owned launch inputs are:

```text
--db <path>
--worker-profiles <absolute-path>
```

Omit `--db` to use Core's repository-bound default ledger. A companion does not
need to know Store implementation, SQLite schema, production Broker layout, Core
installation path, or binary hash.

The transport is MCP over stdio. The private server advertises exactly one tool:

```text
execute_c2c_plan
```

The process fails before repository or ledger access when
`--contract-version` is absent or differs from `engineering-c2c/1`.

## Request

The operation accepts exactly four top-level fields:

```json
{
  "plan_message": {
    "protocol_version": "engineering-c2c/1",
    "message_id": "stable-plan-id",
    "task_id": "existing-task-id",
    "sender_role": "OWNER",
    "state": "PLAN",
    "expected_revision": 1
  },
  "acceptance_command_id": "stable-acceptance-id",
  "delegation_command_id": "stable-delegation-id",
  "worker_profile_id": "trusted-profile-id"
}
```

The request schema is `executeC2CPlanInputSchema`. It is strict. Repository,
database, executable, argv, environment, process, adapter, launch specification,
dispatch, runner, and execution identity overrides are rejected.

The nested `protocol_version` is validated again for every call. A mismatched
version returns `INVALID_PROTOCOL_VERSION` without entering an authoritative
phase.

## Response and errors

The MCP call result contains:

- JSON text in `content`;
- the same value in `structuredContent`;
- `isError=true` when the controller result has `ok=false`.

`structuredContent` is validated by `executeC2CPlanOutputSchema`.

Success is:

```text
ok=true
stage=launch
plan_message_id
task_id
evaluation
acceptance
delegation
launch
```

Failure is:

```text
ok=false
stage=input|evaluation|acceptance|delegation|launch
error.code
error.message
```

The stable code set is exported as `C2C_CONTROLLER_ERROR_CODES` and validated
by `c2cControllerErrorCodeSchema`. The envelope never includes raw exceptions,
Store rows, launch specifications, credentials, environment values, or child
output.

An `ok=true` launch response means only that the ordered Core operations
returned. It is not an execution-result acceptance or task-completion signal.

## Core-owned authoritative snapshot

The following fields form the authoritative evaluation snapshot inside Core:

- task: `id`, `type`, `status`, `revision`, `repo_root`,
  `assignee_role`, `execution_instance_id`, `result`;
- dispatch when applicable: `id`, `task_id`, `worker_role`,
  `runner_instance_id`, `status`;
- existing evaluation receipt when applicable: `message_id`,
  `message_digest`, `task_id`, `evaluated_revision`, `decision`.

These fields are materialized by Core from its authoritative state. They are not
companion request fields and do not expose Store or database structure.

## Frozen semantics

- `report_result` remains the authoritative execution-result path.
- C2C does not replace `report_result`.
- `EXECUTED` reaches `READY_FOR_REVIEW` only after the authoritative
  lifecycle has accepted the result.
- Terminal tasks may have `TaskContract.execution_instance_id=null`.
- Provenance comes from authoritative dispatch and runner identity.
- A wire `execution_id` never becomes authority.
- `READY_FOR_REVIEW` means only that an authoritative result is present and
  eligible for review.
- C2C does not redefine lifecycle or Store authority.

Exact replay reuses `message_id`, `acceptance_command_id`, and
`delegation_command_id`. Response loss never authorizes replacement identities.

## Companion boundary

OAuth/OIDC, identity-provider configuration, ChatGPT setup, Desktop Bridge
integration, Workspace Access, local grant decisions, HTTPS, reverse proxies,
private tunnels, and hosting topology remain outside Engineering MCP Core.
