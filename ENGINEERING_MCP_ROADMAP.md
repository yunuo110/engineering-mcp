# Engineering MCP — Design Roadmap

## 1. Purpose

Engineering MCP is a local coordination layer for a role-based AI software-engineering workflow.

Its purpose is not to make autonomous agents recursively manage one another.

Its purpose is to provide a small, reliable control plane through which:

- a Senior Engineer / Repository Owner can delegate bounded implementation work;
- a Junior implementation worker can execute clearly defined tasks;
- a Principal technical diagnostician can resolve high-value technical uncertainty;
- task state, role boundaries, repository ownership, and structured results survive individual agent sessions.

The design should optimize for:

- correctness;
- clear ownership;
- minimal context-transfer friction;
- bounded use of expensive reasoning models;
- recoverability;
- inspectability;
- gradual automation.

The design should not optimize for agent count, orchestration complexity, or maximum parallelism.

---

# 2. Role Model

The long-term role model is:

## Chat

Product / intent authority and independent review gate.

Responsibilities:

- capture user intent;
- define required behavior, constraints, and acceptance criteria;
- review material L2/L3 changes at integration boundaries;
- detect intent drift and insufficient evidence.

Chat is not part of Engineering MCP V1 and should remain outside the local control plane until there is a demonstrated reason to automate this boundary.

---

## Grok

Senior Engineer / Repository Owner.

Responsibilities:

- reconcile requested behavior with repository reality;
- inspect architecture and tests;
- choose implementation direction;
- perform high-decision-density implementation;
- decide whether work should remain with the Senior, go to the Junior, or require Principal diagnosis;
- integrate delegated results;
- own final repository correctness;
- maintain appropriate Git and project-state checkpoints.

Repository ownership always remains with Grok.

Delegation transfers execution responsibility, not repository ownership.

---

## Luna

Bounded Implementation Worker.

Primary purpose:

> consume execution volume after the engineering direction is already sufficiently clear.

Appropriate work includes:

- mechanical multi-file changes;
- caller migrations;
- regression-test implementation;
- fixture updates;
- known-root-cause fixes;
- cleanup following established architecture changes;
- type/build/lint fixes;
- bounded implementation slices with objective acceptance criteria.

Luna must not independently redefine:

- product behavior;
- architecture;
- persistent formats;
- public API semantics;
- task scope;
- project risk;
- long-term governance.

---

## Sol

Principal Technical Diagnostician.

Primary purpose:

> consume uncertainty density when technical truth itself is materially unresolved.

Appropriate work includes:

- concurrency;
- races and deadlocks;
- ownership semantics;
- lifecycle ordering;
- crash recovery;
- persistent-state integrity;
- transaction behavior;
- difficult runtime / OS / toolchain behavior;
- technically uncertain, high-cost, or irreversible decisions.

Default Sol mode is read-only diagnosis.

Sol should leave the workflow once it has established, where possible:

- root cause;
- violated invariant;
- supporting evidence;
- minimal correct repair;
- required validation.

Implementation should normally return to Grok or Luna.

---

# 3. Core Architectural Principles

## 3.1 Task-centric, not message-centric

Engineering MCP models engineering work as structured Tasks.

It is not an agent mailbox, Slack clone, or general conversation system.

The primary abstraction is:

> Delegated Engineering Task

not:

> Message between agents.

---

## 3.2 Role API over model API

The coordination layer should expose engineering roles and task semantics, not arbitrary model selection.

Conceptually:

- IMPLEMENTATION → Junior
- DIAGNOSIS → Principal

Future automated APIs should resemble:

- `delegate_implementation`
- `escalate_diagnosis`

rather than:

- `run_model(model=..., effort=...)`

Model binding belongs to deployment policy, not to the calling agent.

---

## 3.3 Repository Owner and Current Writer are different concepts

Repository Owner:

- always Grok in the current workflow.

Current Writer:

- Grok;
- Luna during a delegated implementation;
- explicitly authorized Sol in a future exceptional direct-repair mode;
- none.

Ownership must not move simply because another model produced code.

---

## 3.4 One Writer Rule

For one working tree, only one AI writer may modify repository state at a time.

V1 deliberately serializes delegated tasks.

Parallelism must not be introduced until isolation is explicit and reliable.

---

## 3.5 Repository reality beats session memory

Durable engineering truth lives in:

- current code;
- tests;
- Git;
- accepted ADRs;
- `AI_PROJECT_STATE.md`;
- Engineering MCP Task state.

Agent chat history is temporary working memory.

A long-lived session is never a substitute for durable repository state.

---

## 3.6 Structured conclusions, not reasoning transcripts

Agents should exchange:

- task contracts;
- confirmed facts;
- evidence references;
- blockers;
- structured results;
- diagnosis outcomes;
- validation requirements.

Engineering MCP should not become a permanent store for full agent transcripts or private reasoning histories.

---

# 4. V1 — Coordination Ledger

Status:

> Implemented, independently reviewed, and validated with real Grok / Luna / Sol clients.

V1 is intentionally narrow.

## V1 capabilities

- local stdio MCP;
- role-specific server processes;
- SQLite persistence;
- IMPLEMENTATION and DIAGNOSIS tasks;
- role-constrained tool registration;
- persistent task state;
- task revisions;
- append-only task-event audit;
- structured results;
- structured blockers;
- one delegated RUNNING task per ledger;
- clean Git baseline enforcement;
- repository binding;
- read-only Git inspection;
- explicit owner close decision.

## V1 tools

OWNER:

- `create_task`
- `get_task`
- `list_active_tasks`
- `resume_task`
- `cancel_task`
- `close_task`

JUNIOR:

- `claim_task`
- `get_task`
- `report_result`
- `report_blocked`

PRINCIPAL:

- `claim_task`
- `get_task`
- `report_result`
- `report_blocked`

## V1 lifecycle

`create_task`

→ READY

`claim_task`

READY → RUNNING

`report_result`

RUNNING → COMPLETED | FAILED

`report_blocked`

RUNNING → BLOCKED

`resume_task`

BLOCKED | FAILED | COMPLETED → READY

`cancel_task`

READY | RUNNING | BLOCKED | FAILED | COMPLETED → CANCELLED

`close_task`

COMPLETED | FAILED | CANCELLED → CLOSED

CLOSED is immutable.

## V1 deliberate limitations

V1 does not include:

- automatic worker startup;
- Codex App Server;
- task queues;
- heartbeats;
- TTL leases;
- fencing;
- automatic crash recovery;
- parallel writers;
- worktree management;
- automatic Git writes;
- automatic commit or merge;
- LLM routing;
- automatic risk classification;
- autonomous task decomposition;
- recursive agent delegation;
- quota management;
- web UI;
- transcript storage;
- Chat integration.

These are not missing features.

They are intentionally outside V1.

---

# 4.5 V1.5.x — Persistent Task Queue + Execution Ownership + Manual Recovery

V1.5.x is a narrow operational increment over V1. It does not add parallel execution, automatic worker startup, heartbeats, leases, or worktree management.

## Queue semantics

- Every `create_task` call creates a `READY` task. Multiple `READY` tasks can persist in the same ledger.
- `READY` tasks are the pending queue. There is no new queue-specific state.
- Queue order is FIFO by `created_at ASC, rowid ASC`. V1.5.x does not add priority or scoring.
- `claim_next_task` atomically selects and claims the oldest `READY` task of the worker's task type.
- `claim_task` remains available for explicit task-id claims.
- At most one task may be `RUNNING`; the partial unique index on `RUNNING`, transactional claims, and database triggers enforce this.

## Execution ownership

- `assignee_role` is authorization/assignment.
- `execution_instance_id` is active execution ownership.
- A `RUNNING` task must always have a non-null `execution_instance_id`.
- A non-RUNNING task must never have an active execution owner.
- Database triggers enforce this invariant even against older writer processes.

## Startup behavior

- Server startup is execution-state side-effect free.
- Starting any MCP process never recovers, blocks, fails, requeues, or mutates a persisted `RUNNING` task.

## Recovery semantics

- Recovery is explicit and OWNER-only through `recover_task(task_id, expected_revision)`.
- Recovery requires repository binding and optimistic revision matching.
- Recovery transitions `RUNNING` → `BLOCKED`, stores a `CONTEXT_STALE` blocker, clears execution ownership, and writes structured recovery metadata to `task_events`.
- Requeue is explicit and remains an OWNER-only decision through `resume_task`.
- A crashed/lost execution remains `RUNNING` until an OWNER explicitly recovers it.

## Migration / legacy writer safety

- A legacy DB with a `RUNNING` task cannot be migrated automatically; migration fails closed until the legacy RUNNING execution is resolved under the old version.
- A legacy DB without a `RUNNING` task can be migrated safely.
- After migration, legacy processes may remain alive, but unsafe execution-state writes are rejected by SQLite triggers.
- Old clients may receive database-level write errors and must be upgraded/restarted before further execution work.

## Safety assumptions

- Queue execution still requires a clean Git tree, matching repository binding, and (for claims) matching branch and base commit.
- A queued task whose repository assumptions changed is not silently skipped or auto-failed; claim attempts fail explicitly.
- Permissions and role boundaries are unchanged. Workers cannot see or manipulate READY tasks before claiming, and recovery never retries automatically.

# 5. Near-Term Stage — Real Project Adoption

The first stage after V1 validation is not additional MCP automation.

It is operational adoption in a real long-running repository.

The goals are to learn:

- how frequently Grok actually delegates;
- which task shapes work well for Luna;
- Luna first-pass acceptance rate;
- common blocker categories;
- how often Sol escalation is genuinely useful;
- whether manually launching Luna / Sol is materially inconvenient;
- whether clean-checkpoint delegation creates excessive friction;
- whether current task schemas contain too much or too little context.

This stage should prioritize observation over automation.

## Metrics worth observing

### Delegation frequency

How many implementation tasks are worth delegating during normal engineering?

### Junior first-pass acceptance

How often does Grok accept Luna's result without revision?

### Junior revision rate

How often does one bounded revision solve the issue?

### Junior rejection / takeover rate

How often does Grok need to discard or substantially redo delegated work?

### Principal escalation frequency

How often is Sol actually required?

### Principal yield

Of Sol escalations, how many genuinely required Principal-level technical diagnosis rather than ordinary Senior debugging?

### Context expansion

How frequently does a worker need substantial repository exploration beyond supplied task context?

### Human orchestration friction

Does manually launching a worker with a Task ID become a meaningful annoyance?

These observations should determine later automation.

Do not build automation merely because it was anticipated in this roadmap.

---

# 6. V1.x — Operational Hardening

V1.x should contain only improvements justified by real use.

Possible candidates include:

## 6.1 Better repository targeting

The current deployment binds a server process to a specific `--repo`.

A multi-project operational model may later provide:

- explicit project aliases;
- safer launcher wrappers;
- per-project role configurations;
- generated local client configuration;
- repository registration.

This must preserve the invariant:

> a Task is permanently bound to the canonical repository in which it was created.

Repository switching must never become an implicit or model-controlled action.

---

## 6.2 Improved diagnostics

Potential additions:

- clearer configuration doctor output;
- ledger inspection commands;
- explicit schema-version reporting;
- active-task diagnostic view;
- repository-binding diagnostics.

These should remain observational.

They should not turn Engineering MCP into a management UI.

---

## 6.3 SQLite robustness tests

Possible hardening based on observed need:

- real simultaneous multi-process contention tests;
- busy-timeout behavior tests;
- transaction rollback fault-injection;
- corruption / migration handling;
- schema upgrade tests.

These are reliability improvements, not new orchestration features.

---

## 6.4 Operator cleanup tools

If real use creates stale or abandoned entries, narrowly scoped maintenance capabilities may be added.

Examples:

- inspect task events;
- archive old closed tasks;
- diagnose an interrupted task;
- explicitly mark an abandoned task.

Destructive maintenance must remain explicit.

No automatic code rollback should be added.

---

# 7. V2 — Execution Automation

V2 should be considered only if real project use demonstrates that manual worker startup is a meaningful bottleneck.

V2's goal:

> remove manual process launching without changing engineering authority.

Conceptually:

Grok

→ create/delegate Task

→ Engineering MCP execution layer

→ start Codex worker

→ capture AgentRun

→ worker returns structured result

→ Grok resumes integration

V2 introduces a new abstraction:

## AgentRun

Task and AgentRun must remain separate.

Task:

> persistent engineering intent.

AgentRun:

> one concrete model/session execution attempt.

A Task may survive:

- worker crash;
- session restart;
- infrastructure retry;
- replacement AgentRun.

Possible AgentRun fields:

- run ID;
- task ID;
- role;
- bound model;
- reasoning effort;
- session/thread ID;
- start time;
- finish time;
- execution status;
- result reference;
- failure classification.

---

# 8. V2 Model Binding

Model choice should remain server/deployment policy.

For the current workflow:

Junior:

- GPT-5.6 Luna
- high reasoning

Principal:

- GPT-5.6 Sol
- xhigh reasoning

The caller should request an engineering capability, not select a model.

Future model replacements should require changing role configuration, not rewriting workflow semantics.

---

# 9. V2 Principal Write Authorization

Sol should remain read-only by default.

If diagnosis determines that implementation and diagnosis cannot safely be separated, Sol may recommend:

`SOL_DIRECT`

This recommendation must not automatically grant repository write access.

A future explicit owner-side authorization may transition:

Principal diagnosis

→ explicitly authorized Principal repair.

Such repair must:

- receive a narrow write scope;
- acquire writer authority;
- preserve the One Writer Rule;
- exit after the bounded repair;
- remain exceptional.

Sol must never grant write authority to itself.

---

# 10. V2 Runtime Supervision

Automatic execution requires additional reliability mechanisms that are intentionally absent from V1.

Possible capabilities:

- heartbeat;
- stale-run detection;
- writer lease;
- run token;
- process supervision;
- cancellation;
- bounded infrastructure retry;
- startup reconciliation.

These mechanisms exist to recover execution metadata.

They must not automatically trust partially modified repository state.

Core rule:

> recover task metadata automatically; reconcile dirty repository state conservatively.

---

# 11. V2 Crash Recovery

When Engineering MCP controls worker startup, it becomes responsible for distinguishing:

- clean interrupted run;
- dirty interrupted run;
- stale worker;
- repository divergence;
- task-context staleness.

Possible recovery states may include:

- recoverable clean interruption;
- recovery required;
- repository diverged;
- failed runtime.

Automatic retry should only occur when repository state is demonstrably unchanged.

Dirty repository state must never be automatically discarded or overwritten.

No automatic:

- `git reset --hard`;
- `git clean`;
- destructive restore;
- blind restart over partial edits.

Repository reality wins over execution history.

---

# 12. V2 Idempotency

Automatically created tasks and runs need idempotency protection.

A network interruption must not cause:

- two equivalent Luna tasks;
- duplicate Sol Max diagnosis sessions;
- multiple writers for one intended operation.

Future delegation APIs should support stable idempotency/request keys.

Late results from superseded runs must not overwrite the current Task state.

---

# 13. V2 Event-Driven Completion

Grok should not repeatedly poll worker status.

A future execution layer should surface meaningful state changes:

- completed;
- blocked;
- failed;
- interrupted.

The Senior should return to the task only when engineering judgment is needed.

Automation should reduce bookkeeping, not create more coordination chatter.

---

# 14. V3 — Isolated Parallelism

V3 should only be considered if real workload demonstrates that serialization is the dominant bottleneck.

Parallelism is not a default goal.

Potential V3 model:

- Grok primary worktree;
- isolated Luna worktree(s);
- explicit task-to-worktree assignment;
- per-worktree writer ownership;
- integration back into the Repo Owner's branch.

Possible future mechanisms:

- worktree provisioning;
- path reservations;
- integration queue;
- conflict detection;
- bounded cherry-pick / merge workflow.

The system must never simply relax One Writer Rule inside one working tree.

Parallelism requires isolation first.

---

# 15. V3 Multi-Junior Execution

Multiple Luna workers may eventually be useful for:

- large mechanical migrations;
- independent test-writing slices;
- clearly disjoint modules;
- high-volume cleanup after a confirmed architecture change.

But concurrency introduces:

- integration overhead;
- overlapping assumptions;
- stale baselines;
- review backlog;
- conflict resolution;
- greater Senior coordination cost.

Therefore:

> parallelism is justified only when execution throughput, not engineering judgment, is the actual bottleneck.

---

# 16. Future Review Integration

Chat integration may eventually be considered for:

- automatically packaging L2/L3 review evidence;
- transferring final diff summaries;
- transferring Requirement Coverage;
- carrying validation evidence;
- returning independent merge-gate verdicts.

However Chat should remain logically independent from the local engineering execution loop.

The system should not turn Chat into another always-on implementation agent.

Its unique role remains:

> preserve original intent and independently assess merge evidence.

---

# 17. Future Review Package

A future machine-readable Review Package may include:

- original requirement references;
- outcome;
- requirement coverage;
- changed areas;
- scope changes;
- validation;
- existing-test semantic changes;
- known risks;
- unverified behavior;
- applicable ADR;
- applicable Principal diagnosis;
- Git baseline and final commit.

This should be an evidence index, not a full transcript.

---

# 18. Knowledge Integration

Engineering MCP does not replace repository knowledge governance.

Long-term authority remains distributed intentionally:

## Git

What changed and what code currently exists.

## Tests

Evidence of required behavior and invariants.

## `AGENTS.md`

Long-term engineering and AI governance.

## `AI_PROJECT_STATE.md`

Concise current cross-session project snapshot.

## ADRs

Durable rationale for important architectural decisions.

## Engineering MCP

Active and historical coordination state for delegated engineering Tasks.

MCP Task history should not become another architecture-document system.

---

# 19. Data Retention

Closed Tasks may eventually accumulate.

Future retention should distinguish:

- active operational state;
- useful recent audit;
- old historical coordination metadata.

Possible future policies:

- keep active Tasks indefinitely until CLOSED;
- retain recent closed Tasks for audit;
- archive or compact old closed Tasks;
- never feed full historical task lists into new agent sessions by default.

Historical Task data should be queryable but not automatically injected into context.

---

# 20. Observability

If real use justifies it, Engineering MCP may collect lightweight operational metrics such as:

- task count by type;
- completion rate;
- blocker frequency;
- revision frequency;
- Junior first-pass acceptance;
- Principal escalation rate;
- run duration;
- token usage when execution APIs expose it.

Observability must not become automatic engineering policy.

For example:

High Sol usage may indicate poor routing.

Low Sol usage may simply mean the system is working well.

Metrics should inform human/Senior policy adjustment, not automatically downgrade technical risk.

---

# 21. Quota Policy

Engineering correctness takes precedence over quota optimization.

A future execution layer must never silently do:

Sol unavailable

→ downgrade to Luna

or:

Sol xhigh unavailable

→ silently use a lower capability.

Resource exhaustion does not reduce technical risk.

Instead return an explicit resource constraint and allow the Repository Owner to decide the next action.

---

# 22. Security and Trust Boundary

Role authority must remain external to the model.

A model must not gain authority by passing:

`role="owner"`

inside a task.

Role should continue to derive from:

- process configuration;
- trusted launcher configuration;
- future authenticated local execution identity if required.

Client-side tool allowlists are defense in depth.

Server-side role enforcement remains authoritative.

---

# 23. Repository Binding

Repository binding is a permanent invariant.

A Task created for repository A may not be operated through a process bound to repository B merely because:

- the branch matches;
- HEAD matches;
- files happen to be identical;
- the same database is accessible.

Canonical repository identity is part of Task authority.

Any future project-registration or dynamic-repository system must preserve this rule.

---

# 24. Engineering MCP Must Not Become a Fifth Agent

This is a permanent architectural constraint.

Engineering MCP may:

- validate schemas;
- enforce role permissions;
- enforce lifecycle rules;
- record state;
- inspect Git facts;
- start configured workers in a future version;
- supervise execution.

It should not:

- independently interpret product requirements;
- choose architecture;
- decide technical truth;
- perform LLM-based routing;
- silently rewrite task scope;
- decide whether a model's engineering judgment is correct.

Engineering judgment remains with:

- Chat;
- Grok;
- Sol where specialist diagnosis is needed.

---

# 25. Features That Require Strong Evidence Before Addition

The following should not be added merely because they are technically possible:

- generic agent messaging;
- agent inbox/outbox;
- recursive delegation;
- autonomous planner agents;
- manager agents;
- agent-to-agent freeform chat;
- web dashboard;
- arbitrary model routing;
- automatic risk scoring;
- automatic merge;
- arbitrary shell orchestration;
- background repository mutation;
- multi-host scheduling;
- distributed database;
- agent marketplace/plugin system.

Every major feature should answer:

1. What real workflow problem has appeared?
2. How often does it occur?
3. Why can the existing simpler system not handle it?
4. What new failure modes does the feature introduce?
5. Does it preserve clear Repository Owner authority?

If those questions do not have strong answers, do not add the feature.

---

# 26. Planned Evolution

The intended evolution is:

### V1

Coordination ledger.

Human starts workers.

Status: implemented and validated.

### Real-project adoption

Use V1 on a real long-running project.

Measure actual workflow friction.

### V1.x

Only narrow operational hardening proven necessary by real use.

### V2

Automated worker execution and lifecycle supervision, if manual startup becomes a real bottleneck.

### V3

Isolated parallel execution, only if serialized execution becomes a proven throughput limitation.

This sequence should not be skipped merely because later stages are technically feasible.

---

# 27. Long-Term Success Criteria

Engineering MCP is successful if:

- the user primarily talks to Chat rather than manually managing several models;
- Grok remains an effective Senior Engineer rather than becoming an orchestration secretary;
- Luna absorbs substantial bounded execution work with a high acceptance rate;
- Sol is used rarely but productively for genuine technical uncertainty;
- agent-session changes do not lose engineering state;
- task handoffs do not require large prompt copying;
- repository ownership remains clear;
- model failures do not silently corrupt engineering state;
- automation reduces friction without reducing engineering evidence or safety;
- the system remains understandable by one engineer.

The strongest success signal is not maximum automation.

It is:

> high-quality engineering with low orchestration overhead and clear responsibility.

---

# 28. Permanent Design Principle

When choosing between a more autonomous system and a simpler system with clearer authority, prefer the simpler system until real evidence demonstrates that the additional autonomy is worth its coordination and failure cost.

Engineering MCP should remain a thin engineering control plane.

It should never become the project itself.