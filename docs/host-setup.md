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
