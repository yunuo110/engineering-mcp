# Grok CLI Example

Grok CLI 1.0.13 (and 1.0.x) native configuration uses TOML in `~/.grok/config.toml`.

Use:

```text
engineering-mcp --role owner
```

If Grok pins the MCP server `cwd`, automatic repository discovery follows that pinned cwd.

## Native Grok snippet (TOML)

See `grok-config.example.toml` for a sanitized native `~/.grok/config.toml` snippet.

## JSON / other hosts

`grok-mcp.example.json` is a host-agnostic `mcpServers` snippet for `.mcp.json` or other standards-based JSON hosts. Do not present JSON as Grok CLI's native config format.

Do not commit real credentials or personal paths.
