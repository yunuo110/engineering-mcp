# AI_PROJECT_STATE.md

## Current Phase

**Goal**

Prepare Engineering MCP V1 as a local stdio coordination ledger for one repository owner and role-constrained Junior/Principal workers. Do not implement until the V1 proposal is reviewed.

**Status**

Reached: `AGENTS.md` §21 describes the planned V1 boundary, not a server that already exists. Product intent for V1 is confirmed. This directory is a Git repository with a governance checkpoint. Toolchain inspection found Node.js v24.13.1, npm 11.8.0, and `@modelcontextprotocol/server@2.0.0` (engines `node >= 20`). Not reached: MCP source, schema, tests, or a runnable server.

**Next**

Review the V1 implementation proposal. After acceptance, implement the smallest stdio MCP that satisfies the confirmed V1 contract.

---

## Current Architecture Snapshot

- Product: a local Engineering MCP coordination ledger. Transport is stdio. No HTTP service.
- Roles: OWNER (Grok), JUNIOR (Luna), PRINCIPAL (Sol). Process role is a launch argument (`--role`), not a tool argument.
- Task types: IMPLEMENTATION → JUNIOR, DIAGNOSIS → PRINCIPAL.
- Persistence: SQLite outside the target product repository, in a user-local application-data directory. This repository must not contain the live coordination database.
- Git access from the MCP is read-only (root, branch, HEAD, working-tree status). It must not modify Git state.
- Writer ownership is simple: at most one JUNIOR IMPLEMENTATION task may hold the external writer slot while RUNNING. PRINCIPAL diagnosis does not become writer.
- Preferred stack: TypeScript with official MCP SDK v2 (`@modelcontextprotocol/server`, not legacy `@modelcontextprotocol/sdk`).
- Connected Automations `tasks` MCP is unrelated and must not be used as this ledger.
- See `AGENTS.md` §21 for planned V1 capabilities and non-goals.

---

## Confirmed Invariants

No runtime invariants are enforced yet. There is no product code or test suite.

Intended V1 rules from confirmed product intent are not duplicated here until they are implemented and tested.

---

## Known Risks / Transitional State

- Implementation has not started. The V1 proposal is awaiting review.
- `node:sqlite` is available on the local Node.js 24.13.1 runtime but is still experimental. Native `better-sqlite3` is the stable alternative and would add a Windows native addon.
- No `.gitignore` exists yet. Implementation must add one before `node_modules` or a local database can appear.
- No accepted ADRs. A persistence-location or SDK-choice ADR is only warranted if the reviewed design is likely to be reversed later.
- Sibling MCP trees under `F:\code` remain out of scope unless explicitly adopted.

---

## Open Project-Level Questions

- Whether `CREATED` is a real persisted state or `create_task` should land in `READY`.
- How `FAILED` is entered, given there is no `report_failed` tool.
- How strict Git baseline checks are on `claim_task` (HEAD mismatch vs dirty working tree).
- Whether workers may `get_task` by ID before claiming, or only after assignment.
- SQLite driver: experimental `node:sqlite` vs `better-sqlite3`.
- How the user-local database is keyed (canonical repo path vs git identity).
