# AI_PROJECT_STATE.md

## Current Phase

**Goal**

Engineering MCP V1 is a local stdio coordination ledger for one repository owner and role-constrained Junior/Principal workers.

**Status**

V1 is implemented: TypeScript ESM stdio server, `node:sqlite` ledger, and role-filtered tools. Direct `node src/index.ts` execution works without `tsx`. Independent review of the committed V1 is the next gate.

**Next**

Independent review of committed V1. Do not configure Grok/Codex MCP clients until that review completes. Do not broaden V1.

---

## Current Architecture Snapshot

- Launch: `node src/index.ts --role owner|junior|principal --repo <target> [--db <path>]`. Role is process identity, not a tool argument.
- Transport: local stdio via `@modelcontextprotocol/server` v2 `serveStdio`.
- Persistence: `node:sqlite` (`DatabaseSync`) with WAL, foreign keys, 5s busy timeout, and `user_version = 1`. Live DB is outside the target repo (`%LOCALAPPDATA%\engineering-mcp\ledgers\<key>\ledger.sqlite` unless `--db` is set).
- Tables: `tasks` (authoritative) and `task_events` (audit only).
- At most one `RUNNING` task per ledger, any type. IMPLEMENTATION RUNNING is the JUNIOR writer slot. DIAGNOSIS RUNNING is read-only but still exclusive.
- Git access is read-only (`rev-parse`, `status --porcelain=v1`). `create_task` / `claim_task` / `resume_task` require a clean tree; claim also requires matching branch and `HEAD === base_commit`.
- See `AGENTS.md` §21 for V1 non-goals.

---

## Confirmed Invariants

These are enforced by code and tests:

- `create_task` lands in `READY`; there is no durable `CREATED` state.
- `claim_task` is the only transition into `RUNNING`.
- At most one `RUNNING` task exists per ledger.
- `report_result` / `report_blocked` from `RUNNING` release that slot.
- `resume_task` reopens `BLOCKED` | `FAILED` | `COMPLETED` to `READY`, clears assignee/result/blocker, and captures current HEAD as `base_commit`.
- OWNER may `close_task` from `COMPLETED` | `FAILED` | `CANCELLED`.
- Workers cannot read `READY` tasks; a successful `claim_task` returns the full Task Contract.
- JUNIOR claims only IMPLEMENTATION; PRINCIPAL claims only DIAGNOSIS.
- Mutating lifecycle ops are transactional (revision check, status check, row update, event insert).
- The MCP does not mutate Git state.
- A task remains bound to the canonical `repo_root` captured at create. `claim_task` and `resume_task` reject a process bound to a different repository even when branch and HEAD match.

---

## Known Risks / Transitional State

- `node:sqlite` is still experimental on Node.js 24.13.1. Isolated behind `store.ts`.
- SDK input-schema failures (for example extra `branch` on `create_task`) return MCP `isError` text from the SDK, not this server's `{ ok: false, error: { code } }` envelope. Domain errors from lifecycle do return structuredContent.
- `.gitignore` excludes `node_modules/` and `*.sqlite*`. The live ledger must not be committed.
- Connected Automations `tasks` MCP remains unrelated.

---

## Open Project-Level Questions

None that block V1 use. Broadening beyond the approved V1 contract requires a new decision.
