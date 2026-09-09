# Changelog

## [0.1.1] - 2026-09-09

### Fixed

- Preserve exact Git filenames, including spaces, Unicode and rename sources,
  during scope verification; record Git-observed changed files in runner results.
- Enforce allowed and forbidden scope for ignored files using before/after
  content snapshots. Unchanged ignored caches are not reported as worker changes.
- Reject successful-looking worker results when the Harness process exits unsuccessfully.
- Quote Windows Codex `.cmd` arguments and reject shell expansion characters;
  include the required exit code in the worker result prompt.
- Persist runner claim and terminal dispatch changes in the existing lifecycle
  transaction; preserve OWNER cancellation records when a late runner returns
  or emits a delayed process error.
- Resolve a new relative `--db` path before launching workers in repository cwd.

### Validated

- Expanded lifecycle and stale-writer fencing regressions, including live legacy
  connections and prepared statements across schema migration.
- Deterministic crash/restart tests around claim, worker execution, and result
  persistence; atomic task/dispatch ownership updates.
- Production-only tarball installation, MCP startup, controlled Harness delegation,
  durable restart, and ignored-file scope rejection on Windows with Node.js 24.

### Support and limitations

- Runtime and clean Git prerequisites, ledger-only cancellation, interrupted launch
  recovery, and Windows `.cmd` path restrictions.
- Supported use is trusted local execution with sequential workers. Workers are
  not sandboxed. Cancellation fences lifecycle/results; it does not terminate
  process trees. Stop old processes before recovery or replacement execution.
- Codex has controlled process tests; authenticated model E2E is not verified.
  Linux/macOS runtime validation is not claimed for this release.
- Ignored-file verification reads ignored content twice per run; large caches add
  I/O cost. Quiesce other writers. It observes net changes, not transient writes.
- No universal request idempotency or protection against malicious direct SQLite
  access is claimed.

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
