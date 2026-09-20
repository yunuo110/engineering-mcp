# Host Setup

Engineering MCP exposes an MCP server to local hosts such as Grok CLI and Codex CLI.

## Recommended command

```text
engineering-mcp --role owner
```

This command intentionally has no hardcoded `--repo`. At process startup, Engineering MCP resolves the repository in this order:

```text
1. --repo
2. ENGINEERING_MCP_REPO
3. launch cwd → git rev-parse --show-toplevel
4. fail closed
```

That resolution order describes direct server startup and the legacy manual
snippet below. Safe Configure uses the same resolver to find the canonical root,
then writes that root explicitly as `--repo` so host cwd cannot silently change
the configured binding.

## Codex CLI

Codex CLI launches MCP servers with the workspace/current directory. If your Codex config sets an MCP server `cwd`, automatic repository discovery follows that pinned cwd.

Example config snippet:

```toml
[mcp_servers.engineering-mcp]
command = "engineering-mcp"
args = ["--role", "owner"]
```

## Grok CLI

Grok CLI also launches MCP child processes with the workspace cwd. Use the same command.

Grok CLI 1.0.13 (and 1.0.x) native configuration uses TOML. Example config snippet for `~/.grok/config.toml`:

```toml
[mcp_servers.engineering-mcp]
command = "engineering-mcp"
args = ["--role", "owner"]
```

If your host uses `.mcp.json` or another standards-based JSON host, use this equivalent snippet separately:

```json
{
  "mcpServers": {
    "engineering-mcp": {
      "command": "engineering-mcp",
      "args": ["--role", "owner"]
    }
  }
}
```

## Setup preview

```bash
engineering-mcp setup
```

This command prints the snippets above and does **not** write configuration files. It never overwrites existing host config.

If you choose to write config manually, preserve unrelated sections and keep existing files backed up outside the repository.

## Safe Configure

Safe Configure supports the native TOML files used by Codex and Grok. Select the
host explicitly. The default operation is a read-only preview:

```bash
engineering-mcp configure --host codex --repo /absolute/path/to/repository
engineering-mcp configure --host grok --repo /absolute/path/to/repository
```

The preview reports a self-contained `plan_identity`, the exact owned entry
additions or `command`/`args` changes,
an empty removal list when nothing is removed, stale/test binding findings, the
invocation cwd, its Git repository when available, and the canonical repository
that will be passed through `--repo`. A meaningful cwd/repository difference is
shown as a warning; the generated entry never relies on that cwd to choose a
repository.

Apply the reviewed plan explicitly:

```bash
engineering-mcp configure --apply --plan <preview-identity>
```

Current apply support is intentionally capability-bounded:

- **Windows:** preview, semantic no-change, first install, and full existing-config
  Safe Configure capture/recovery are supported.
- **Linux/macOS:** preview and semantic no-change are supported. First install remains
  supported when same-directory hard-link create-if-absent capability succeeds. An
  existing config that requires mutation fails early with `CONFIGURE_UNSUPPORTED`,
  before proposal/backup/probe transaction artifacts are created and without changing
  the target pathname or bytes.

The identity embeds an immutable plan plus a corruption checksum. It binds the plan
id, host, resolved target, canonical repository, source hash/missing state,
proposed-content hash, preview timestamp, command, and complete arguments. Apply
deterministically reconstructs the proposed bytes from that frozen intent and rejects
any hash disagreement. No daemon, persistent plan record, local signing secret, or
process lock is used. Apply may repeat `--host`, `--repo`, `--config`, or `--command`
as assertions; a mismatch fails closed.

The plan prevents accidental or stale application. It is deliberately not an
authorization credential: the current OS user's filesystem permission to the target
configuration is the authorization boundary. Possession or editing of a plan does not
grant filesystem access.

On Windows, an existing-file mutation first prepares and validates proposed bytes in a unique
same-directory artifact. It then atomically moves the current target to a unique,
unpublished transaction backup name without overwrite, verifies the captured bytes,
and installs the proposal by creating a hard link at the now-absent target path. Hard
link creation is atomic create-if-absent: if another writer recreates the target, it is
preserved and apply fails closed. A missing target uses create-if-absent installation
on every supported platform; filesystems without the required hard-link primitive are rejected before publication.

On Windows, an existing target's Owner and DACL are part of the capture contract.
Safe Configure copies the exact Owner+Access security descriptor to the proposal and
reads it back before moving the target. This preserves explicit allow/deny entries and
the access-rule protection/inheritance state; inability to read, apply, or verify that
descriptor fails before capture. The retained backup keeps the original descriptor by
virtue of being the moved source file. SACL/audit data is outside the Goal 5A promise.
For a first install there is no source descriptor to copy, so the new file uses the
normal authorization policy inherited from the host configuration directory.

Before an existing target is captured, Safe Configure exercises the actual Windows
object-bound publication helper against disposable same-volume artifacts. The probe
loads the native binding, opens and identifies the source object, verifies SHA-256 and
Owner+DACL state, publishes a hard link with replace disabled, confirms that the link
is the same physical object, and confirms that a second source cannot replace the
occupied probe target. Probe failure returns `CONFIGURE_UNSUPPORTED` before the user
configuration is moved or a `SOURCE` backup is created. Probe artifacts are retained
under the transaction's `.linkcheck.` names rather than deleted by path.

Final Windows installation is object-bound rather than pathname-revalidated. Safe
Configure opens the proposal with exclusive sharing, verifies its volume/file identity,
SHA-256, Owner, DACL, and protection/inheritance state through that handle, and asks
Windows to create the target hard link from that same verified file handle with replace
disabled. This prevents ordinary pathname substitution, content races, and occupied-
target replacement between verification and publication. After publication, the active
target and retained `PROPOSED` pathname are hard-link aliases for the same underlying
file object. The captured `SOURCE` backup is a distinct recovery object.

This is an authorization-preservation and transactional-safety boundary, not mandatory
isolation from every Windows principal. Safe Configure preserves the exact Owner, DACL,
explicit allow/deny semantics, and protection/inheritance state of an unambiguous source
and does not itself silently broaden them. A principal that already holds or can
independently exercise `WRITE_DAC`, `WRITE_OWNER`, ownership authority, backup/restore
privileges, or SYSTEM/elevated equivalent authority can modify the shared file object's
security descriptor through any hard link and is outside Safe Configure's isolation
boundary. Observed divergence fails closed where possible and all recovery evidence is
preserved. Post-install verification is detection/recovery evidence; it is not proof
that an independently authorized actor could not perform an unobserved transient
mutation between observations.

Safe Configure edits only the `command` and `args` values in
`mcp_servers.engineering-mcp`, retaining comments, line endings, unrelated MCP
servers, other settings, and unknown keys in the owned table. After installation,
verification failure never triggers automatic rollback, deletion, or replacement of
the active pathname. Instead `CONFIGURE_MANUAL_RECOVERY_REQUIRED` reports exact paths
and hashes. The target, source backup, proposed artifact, and hard-link capability
artifact are retained. This release performs no automatic pathname cleanup.

Crash recovery is derived from those retained bytes and the plan id, not a lock file.
Exact retry resumes after source capture, returns `ALREADY_APPLIED` after a completed
installation, and fails closed on inconsistent or externally changed states. A captured
concurrent edit is restored only by create-if-absent; an already occupied target is
never touched. Backup names include the random plan id plus a random transaction suffix.
Every retained transaction file is reported and classified by immutable plan hashes as
`SOURCE`, `PROPOSED`, or `EXTERNAL`, with its path, hash, and physical identity. Multiple
identical source or proposal artifacts are valid. On Windows, byte-identical `SOURCE`
artifacts must also agree on the canonical Owner+DACL authorization fingerprint; any
Owner, access-rule, or protection/inheritance disagreement is preserved and reported
for manual recovery instead of selecting an artifact by path or creation order. Manual
recovery evidence includes each retained artifact's classification, kind, physical
identity, and readable authorization fingerprint. If the target is absent, any proven
proposal can be restored only by create-if-absent; an external target or ambiguous
external artifact state is preserved for manual recovery.
If the file changed after preview, apply rejects it and requires a fresh preview.
A repeated apply of the intended entry is a no-op and creates no redundant backup.
Recognized `--db` and `--worker-profiles` arguments are retained; role and repository
arguments are replaced with the intended OWNER binding. Unsupported or repeated
arguments fail closed instead of being discarded.

Ownership detection recognizes both the direct `engineering-mcp` executable and a
structured Node launcher only when the resolved script belongs to an
`engineering-mcp-cli` package whose `engineering-mcp` bin maps to `dist/cli.js`.
An unrelated project's `dist/cli.js --role owner` is not claimed. Multiple proven
Engineering MCP owner entries remain ambiguous and fail closed.

Use `--config /absolute/path/config.toml` only when the host uses a non-default
TOML path. Relative paths, malformed TOML, symlinks/special files, inline or
otherwise non-surgically-editable owned entries, and additional Engineering
MCP-like server entries fail closed. Safe Configure never deletes an additional
stale/test entry automatically; remove or rename it only after operator review.
An exact entry carrying a test/smoke/fixture marker is shown in preview with
`safe_to_apply = false` and must be cleaned up by the operator before apply.

After apply, restart the host, run the exact `engineering-mcp doctor --repo ...`
command in the result, confirm the reported repository root, and reconnect the
host to verify MCP tool discovery. A successful file write alone is not treated
as proof of a live connection.

## Worker Profiles (optional)

Worker Profiles are trusted operator configuration. They are loaded once at process startup and are immutable for the process lifetime.

```bash
engineering-mcp --role owner --worker-profiles /absolute/path/to/profiles.yaml
```

or:

```bash
ENGINEERING_MCP_WORKER_PROFILES=/absolute/path/to/profiles.yaml engineering-mcp --role owner
```

If both are set, `--worker-profiles` wins. Without a profile file, Engineering MCP uses the built-in `codex-luna` default. See [Worker Profiles](worker-profiles.md).

## Doctor

```bash
engineering-mcp doctor
```

Doctor reports local environment state offline. It checks:

- Node/runtime;
- Git availability;
- detected repository root/source;
- ledger path and schema/repository binding (if safely inspectable);
- Codex CLI executable presence;
- generic Harness subsystem availability;
- optional DSH executable presence.

Executable presence does **not** mean authenticated. Doctor never prints API keys, tokens, full environment, proxy credentials, or credential files.

## Explicit repository binding

If automatic discovery is not desired, or if a host does not preserve the intended cwd:

```bash
engineering-mcp --role owner --repo /absolute/path/to/repo
```

or:

```bash
ENGINEERING_MCP_REPO=/absolute/path/to/repo engineering-mcp --role owner
```

## Non-Git cwd

If the launch cwd is not inside a Git worktree and no explicit repo is provided, startup fails with:

```text
REPOSITORY_NOT_FOUND
```

No ledger is opened on failed auto-discovery.
