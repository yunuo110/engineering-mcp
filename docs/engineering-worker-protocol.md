# Engineering Worker Protocol v1

The canonical protocol identifier is `engineering-worker/1` (EWP/1).

## Purpose

EWP/1 is the narrow contract between Engineering MCP's trusted Worker Runner and a native coding-agent Harness. It defines:

- what a Harness is asked to do;
- repository context needed to do it safely;
- the terminal result a Harness must return;
- failure modes when the contract is violated.

## Request

An EWP request contains task and repository context only. It never contains:

- `execution_instance_id`;
- lifecycle authority;
- ledger credentials;
- provider API keys or tokens.

The authoritative request schema is `src/adapters/ewp.ts` (`ewpRequestSchema`). The public example below is schema-valid.

Example request shape:

```json
{
  "protocol": "engineering-worker/1",
  "request_id": "uuid",
  "task": {
    "id": "uuid",
    "type": "IMPLEMENTATION",
    "goal": "Implement the requested feature",
    "allowed_scope": ["src/feature"],
    "forbidden_scope": ["src/feature/secret.ts"],
    "acceptance_criteria": ["src/feature/index.ts exists"],
    "validation_requirements": ["npm test"],
    "context_files": ["src/feature/index.ts"],
    "knowledge_refs": ["AGENTS.md"]
  },
  "repository": {
    "root": "/absolute/path/to/repo",
    "base_commit": "abc123"
  },
  "worker": {
    "role": "JUNIOR"
  }
}
```

Do not use convenience aliases such as `task.title`, `task.body`, `repository.repo_root`, or `worker.adapter_id`. The runtime strict schema rejects them.

## Result

A terminal EWP result must be a JSON object with:

- `protocol: "engineering-worker/1"`
- `outcome: "completed" | "blocked"`
- `summary: string`
- `changed_files: string[]`
- `validation: [{ command: string, status: "passed"|"failed"|"not_run", summary?: string }]`
- `known_limitations: string[]`
- optional `blocked_reason: string`
- `exit_code: number`

The authoritative result schema is `src/adapters/ewp.ts` (`ewpResultSchema`). The public example below is schema-valid.

Example result shape:

```json
{
  "protocol": "engineering-worker/1",
  "outcome": "completed",
  "summary": "Implemented the requested feature",
  "changed_files": ["src/feature/index.ts"],
  "validation": [
    {
      "command": "npm test",
      "status": "passed",
      "summary": "Tests passed"
    }
  ],
  "known_limitations": [],
  "exit_code": 0
}
```

The result must **not** include request-envelope fields:

- `request_id`
- `task`
- `repository`
- `worker`

## Worker Profile selection is outside EWP

`worker_profile`, `adapter`, `manifest`, `provider`, `model`, and executable selection are OWNER orchestration configuration. They are **not** part of `engineering-worker/1`. EWP remains a Harness-independent Worker task protocol.

## EWP REQUEST ≠ EWP TERMINAL RESULT

An EWP request is the input given to a Harness. An EWP terminal result is the final outcome returned by the Harness. They are distinct schemas. Request fields are forbidden in a terminal result, and terminal result fields are not part of a request.

## Prompt-wrapper hardening

Generic prompt-wrapper mode is hardened so:

- the supplied object is explicitly an EWP **REQUEST**, not a final answer;
- the final output must be a different EWP **TERMINAL RESULT**;
- request-envelope fields are forbidden in the result;
- invalid or request-shaped output becomes `WORKER_PROTOCOL_FAILURE → BLOCKED`.

## Validation and fail-closed behavior

The Worker Runner parses and schema-validates every Harness result.

- If parsing/validation succeeds, the result is converted to a ledger result.
- If parsing/validation fails, the dispatch is recorded as failed/blocked.
- A result that is actually a request, or that includes request-envelope fields, is rejected.
- Worker testimony is not repository authority: the Runner independently verifies Git state before accepting a completed result.

## Transport

Generic CLI adapter supports:

- prompt via stdin or generated request file;
- result via stdout JSON, stdout JSONL final event, or trusted run-dir JSON file.

All transports are declarative in the adapter manifest. No shell command templates are permitted.

## Versioning

The EWP protocol and the adapter manifest schema are versioned independently.

- EWP: `engineering-worker/1`
- Generic CLI manifest: `engineering-cli-adapter/1`
