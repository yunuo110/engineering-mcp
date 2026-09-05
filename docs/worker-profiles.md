# Worker Profiles

Engineering MCP lets an OWNER select among preconfigured trusted Worker/Harness execution profiles.

Worker Profiles are **trusted operator configuration**, not task-controlled model routing.

```text
OWNER
→ delegate_task(worker_profile = "dsh-deepseek")
→ immutable trusted Worker Profile registry
→ adapter + manifest + opaque Harness config
→ Worker Runner
→ native Harness
```

## Principle

- Engineering MCP standardizes **WHAT** must be done.
- Harnesses control **HOW** to reason, which model/provider to use, and how to execute.
- A Worker Profile selects a **preconfigured trusted Harness execution profile**.
- A task cannot choose arbitrary executables, manifest paths, model identifiers, providers, API endpoints, or credentials through `worker_profile`.

## Configuration

Worker Profile configuration is loaded once at MCP process startup from an explicit trusted path:

```text
--worker-profiles /absolute/path/to/profiles.yaml
```

or:

```text
ENGINEERING_MCP_WORKER_PROFILES=/absolute/path/to/profiles.yaml
```

If both are supplied, `--worker-profiles` wins.

If a supplied path is invalid, startup fails closed. There is no silent fallback to another source after a higher-priority source is supplied.

## Schema

```yaml
schema: engineering-worker-profiles/1

default_profile: codex-luna

profiles:
  codex-luna:
    adapter: codex-exec-luna
    description: Codex CLI worker

  my-generic-worker:
    adapter: generic-cli
    manifest: /absolute/path/to/trusted/generic-worker.yaml
    profile: production
    model: worker-model
    description: My trusted Generic Harness
```

Rules:

- Profile IDs are simple stable identifiers.
- `default_profile` explicit but invalid → startup fails.
- `default_profile` omitted → use `codex-luna` only if `codex-luna` exists; otherwise startup fails.
- `generic-cli` profiles must include an absolute manifest path.
- `model` and `profile` are opaque Harness-owned configuration strings.
- Engineering MCP does not interpret provider/model semantics or route models.

## Backward compatibility

If no profile file is supplied, Engineering MCP uses the built-in `codex-luna` profile:

```text
profile id: codex-luna
adapter: codex-exec-luna
```

Existing `delegate_task(...)` calls without `worker_profile` continue to use that default.

## OWNER API

OWNER processes may list trusted profiles:

```text
list_worker_profiles
```

and may select a profile when delegating:

```text
delegate_task(
  task_id,
  expected_revision,
  worker_profile = "my-generic-worker"
)
```

Unknown profile IDs fail before any claim or dispatch mutation.

## CLI inspection

```bash
engineering-mcp profiles --worker-profiles /absolute/path/to/profiles.yaml
```

This prints the startup-loadable profile registry without invoking any Harness or model.

## Isolation from EWP

Worker Profile selection is **outside** `engineering-worker/1`.

EWP remains a Harness-independent Worker task protocol and does not carry:

- `worker_profile`
- `adapter`
- `manifest`
- `provider`
- `model`
- executable information
