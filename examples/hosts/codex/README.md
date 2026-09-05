# Codex CLI Example

Codex launches MCP servers with workspace cwd. Use:

```text
engineering-mcp --role owner
```

If Codex pins the MCP server `cwd`, automatic repository discovery follows that pinned cwd.

## Sanitized snippet

See `codex-config.example.toml` for a minimal `[mcp_servers.engineering-mcp]` snippet. It contains no credentials or personal paths.
