# Changelog

## [0.1.0] - 2026-09-05

### Added

- Public `engineering-mcp` CLI with `--help`, `--role owner`, `setup`, `doctor`, and `adapter validate|probe`.
- Conservative setup preview for Grok CLI and Codex CLI (no config writes).
- Offline doctor reporting runtime, Git, repository, ledger, Codex, Generic Harness, and optional DSH availability.
- Open-source documentation: README, architecture, EWP/1, adapter authoring, host setup, and threat model.
- Apache-2.0 license, contributing guide, security policy, GitHub issue templates, and CI for Windows/Linux/macOS.
- Sanitized examples for hosts and harnesses.

### Changed

- Package prepared for public npm release as `engineering-mcp-cli` v0.1.0.
- Default generated MCP command is `engineering-mcp --role owner` without hardcoded `--repo`.

### Preserved

- Engineering Worker Protocol `engineering-worker/1`.
- GenericCliAdapter and adapter registry.
- Automatic repository binding.
- Lifecycle, Store, Worker Runner, dispatch, recovery, and Git verification behavior.
