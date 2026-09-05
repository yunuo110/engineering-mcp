# Adapter Authoring

Add a local Harness with a declarative `engineering-cli-adapter/1` manifest.

Use `GenericCliAdapter` when the Harness can be launched as a local CLI process and can exchange EWP/1 requests/results through stdin, files, stdout, or JSONL.

## Manifest schema

The manifest is a strict YAML/JSON object:

```yaml
schema: engineering-cli-adapter/1
id: my-harness
name: My Harness
adapter: generic-cli
command: my-harness-cli
arguments:
  - "--task-id"
  - "${task_id}"
working_directory: "${repo_root}"
prompt:
  transport: stdin
  format: engineering-worker/1
result:
  source: stdout
  format: json
  strategy: last-json-object
process:
  shell: false
  success_exit_codes: [0]
protocol_mode: native
```

## Allowed trusted variables

Manifest arguments and working directory may use only trusted variables:

- `${repo_root}`
- `${run_dir}`
- `${task_id}`
- `${dispatch_run_id}`
- `${profile}`
- `${model}`

Task-derived variables are forbidden in argv and working directory.

## Prompt transports

### stdin

The EWP request is written to the child process stdin. The Harness should consume it as a request and return a terminal EWP result.

### file

If `prompt.transport` is `file`, the manifest must include `prompt.argument`. Engineering MCP writes a request file into the trusted run directory and passes the file path as that argument.

## Result transports

### stdout JSON

Use `source: stdout`, `format: json`, and `strategy: last-json-object`. The adapter looks for the last parseable JSON object in stdout.

### stdout JSONL

Use `source: stdout`, `format: jsonl`, and `final_event` with `field`/`equals`. The adapter returns the last JSONL event whose field equals the value.

### file

Use `source: file` and `result.path`. The file must be a JSON EWP terminal result in the trusted run directory or a trusted path.

## Process safety

- `process.shell` must be `false`.
- Command and arguments are explicit.
- No shell command templates are permitted.
- `success_exit_codes` must be declared.

## Validation and probe

```bash
engineering-mcp adapter validate manifest.yaml
engineering-mcp adapter probe manifest.yaml
```

- `validate` only checks schema and safety rules; it never calls external models.
- `probe` validates the manifest, resolves the command, and runs the equivalent of `<command> --version` with a bounded timeout and local execution only. It does not run an authenticated smoke.
- `adapter smoke`, if exposed, is explicitly opt-in and may consume model quota.

## Worker Profiles and manifests

Worker Profiles are trusted operator configuration that select an adapter and, for `generic-cli`, a manifest path. The manifest continues to own process launch and EWP transport concerns. Profile `profile` and `model` strings are passed through to `GenericCliAdapter` as opaque trusted Harness configuration.

See [Worker Profiles](worker-profiles.md).

## Registry

Adapters are registered in `src/adapters/registry.ts`. Specialized adapters (for example Codex) are registered under their stable IDs. Generic CLI manifests are selected at runtime via `generic-cli`.

## Community manifests

Community manifests must be labeled as **not maintainer E2E verified**. Do not include real credentials, tokens, private endpoints, or personal paths.
