# DSH — Verified Architecture Reference

DSH is connected through Engineering MCP's `GenericCliAdapter` boundary, **not** as a turnkey built-in adapter.

## Actual verified DSH invocation contract

Tested version: **DSH 0.1.2-rc.1**.

The verified boundary is:

```text
Engineering MCP
  → GenericCliAdapter
  → trusted DSH bridge/wrapper
  → dsh --profile headless "<positional task>"
  → DSH
```

Important facts:

- DSH itself is the Harness boundary.
- DSH did **not** natively speak EWP/1 in the tested version.
- The upstream DSH interface is experimental/release-candidate.
- A trusted bridge is required to adapt EWP prompt-wrapper input/output to DSH's actual positional headless interface.
- Provider/model configuration remains inside DSH.
- Engineering MCP does **not** directly integrate DeepSeek API or OpenCode Go.
- Engineering MCP does not store or proxy DSH/DeepSeek credentials.

## Status

This is a **verified architecture reference**, not a plug-and-play public recipe. A private/site-specific DSH bridge was used in maintainer verification. A fully generic sanitized bridge is not being shipped as turnkey in this patch because the upstream DSH interface is still experimental and the bridge depends on local DSH behavior.

To recreate the boundary, you must provide a trusted bridge that:

1. accepts an EWP prompt from GenericCliAdapter;
2. translates the EWP request into DSH's positional headless task form;
3. invokes `dsh --profile headless "<positional task>"`;
4. reads DSH output and returns a schema-valid EWP terminal result to GenericCliAdapter.

The reference manifest below is intentionally incomplete and must not be treated as a ready-to-run example.
