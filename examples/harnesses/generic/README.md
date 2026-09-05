# Generic Harness Example

Create a `engineering-cli-adapter/1` manifest and validate it:

```bash
engineering-mcp adapter validate ./manifest.example.yaml
engineering-mcp adapter probe ./manifest.example.yaml
```

This example uses placeholder command `my-harness-cli`. Replace it with an actual local Harness executable that understands EWP/1. Do not include credentials or private endpoints.
