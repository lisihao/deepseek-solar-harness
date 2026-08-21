# Agent Note: Extract physical operators as a DSH capability seam

Status: implemented

English | [中文](2026-08-15-physical-operator-capability-seam.zh.md)

## Problem

AI4Research contains useful physical-operator concepts, but integrating the whole project as one DSH Bundle would preserve an oversized business boundary and create a second orchestration authority inside the harness. Its existing physical-operator implementation also mixes stable operator identity with a Solar-shaped TaskGraph, filesystem inbox, leases, graph/gate mutations, and a large read-only transition catalog. Copying that runtime would make DSH depend on historical state and implementation defects before the execution substrate can be redesigned.

DSH nevertheless needs one seamless way for agents and plugins to discover a physics capability, call it, cancel it, observe capacity, and replace the backing execution product without changing model-facing contracts.

## Decision

Extract the stable capability boundary, not the AI4Research runtime, and support two explicit execution lifetimes behind it:

1. `@deepseek-ai/dsh-physical-operator` owns `ctx.physicalOperators`, normalized `ephemeral | resident` mode discovery, fail-fast capacity, pre-provider execution identity, typed errors, and paired lifecycle events. Omission remains `ephemeral`; unsupported modes fail without fallback.
2. `@deepseek-ai/dsh-resident-operator` adds the provider-neutral `ctx.residentOperators` control seam. A Session is keyed by operator id, canonical workspace, and caller-owned lane, admits one active turn, and exposes trusted management operations. Separate lanes execute concurrently without sharing a native product thread. Models still execute only through the physical-operator Consumer.
3. `@deepseek-ai/dsh-resident-operator-local` runs an independent owner-only Unix-socket daemon as the sole Session/Receipt/Lease/Event/Artifact writer. Command identity and canonical request hash are separate: identical replay returns the same receipt, changed content conflicts, crashes become `indeterminate`, and an authorized retry uses a new id with a unique link to the abandoned receipt. Forward-only table rebuilds copy each historical field by name because SQLite preserves the physical position of columns appended by `ALTER TABLE`.
4. Native product continuity remains authoritative. Claude Code uses the official Agent SDK's persisted session and resume; Codex uses pinned app-server schemas with non-ephemeral thread start/resume. Both fail closed unless current CLI/version/protocol checks prove native subscription authentication, and both receive a credential-scrubbed environment with no API fallback.
5. `@deepseek-ai/dsh-physical-operator-resident` routes one stable id between existing ephemeral subagents and the Resident seam. `@deepseek-ai/dsh-tool-physical-operator` remains the one model Consumer; it registers dynamic selection guidance built from the live descriptor/tag/mode catalog instead of introducing a hidden classifier. `@deepseek-ai/dsh-resident-operators` is an opt-in composition Bundle.
6. The Consumer owns one logged, per-Session routing policy: `auto | direct | codex | claude-code`. Untouched Sessions use `auto`, which leaves complex parallelizable work on the main Agent turn for [TaskGraph-native Smart Collaboration](../feature/2026-08-20-taskgraph-smart-collaboration.md) and directly dispatches bounded operator work. `/operator` changes the durable event; a Session projection supplies the same value to clients so Desktop can render a separate execution-strategy selector adjacent to, but not conflated with, model selection. A direct host dispatch is a one-step override: it records the displaced primary model config, restores that config for the next unmatched message across HMR or process resume, and cannot serve a result after an assistant message has already delivered that dispatch.

Provider, router, and Consumer depend on Service Definitions rather than one another's implementation. DSH/HMR disposal disconnects clients but does not kill the daemon; graceful daemon shutdown drains admitted turns. Tmux is an optional read-only event viewer, never a task transport or authority. DSH Session, Jobs, Web UI, and terminal panes may project bounded state but do not own native product sessions or Resident receipts.

This extraction copies no AI4Research Python daemon, scheduler, TaskGraph, state store, file inbox, operator catalog, persona, Gate, Evidence schema, or business workflow. It modifies no Solar repository or generated DSH runtime.

## Alternatives considered

- **Install AI4Research as one DSH Bundle** — rejected because it makes a whole application the plugin boundary and carries orchestration/state authority that DSH does not need for a physical-operator call.
- **Port the existing Python `operator_runtime` and `operatord` unchanged** — rejected because their Solar-shaped persistence, TaskGraph, and mailbox mix domain authority with reusable daemon mechanisms.
- **Expose Codex and Claude Code directly as separate physics tools** — rejected because product selection would leak into the model contract and every new execution backend would churn schemas and prompts.
- **Use the generic `subagent` tool without a domain seam** — rejected because it has no stable physical-operator identity, availability/capacity contract, or future typed physics result boundary.
- **Delegate only when the user explicitly names Codex or Claude Code** — rejected because it exposes implementation vocabulary as a usability prerequisite and leaves an otherwise capable execution seam effectively dormant.
- **Present Codex and Claude Code as primary chat models** — rejected because they are subscription-backed execution products with separate native sessions, lifecycle, receipts, and results; selecting them as an LLM route would misrepresent the authority boundary.
- **Keep one Claude/Codex CLI process alive forever or use tmux as control** — rejected because native product Session/thread identity, not terminal process lifetime or screen text, is the continuity authority.
- **Use DSH Jobs as the durable owner** — rejected because current Jobs do not survive DSH restart; a later external durable Job Provider may project Resident turns.
- **Add queueing, writable human takeover, affinity scheduling, or remote farms** — deferred; the Resident protocol is local, fail-fast, single-turn per lane, and automation-controlled.

## Consequences

DSH now preserves existing one-shot behavior while adding an opt-in durable control plane without Core changes. The daemon owns SQLite WAL state, owner-only local IPC, content-addressed large results, recovery, bounded structured observation, strict product qualification, and prompt/credential-safe diagnostics. Session projections expose the latest turn and event, `inspectTurn()` recovers an active or settled receipt after client restart, and product Drivers publish bounded progress phases without transcript data. The public execution id doubles as the durable command id, so transport retry cannot create a second product invocation.

The additional state creates operational responsibility: product and protocol versions are pinned qualification inputs; a forced stop may require explicit indeterminate resolution; state is forward-only; and native product permissions remain authoritative rather than inheriting DSH's file sandbox. Writable human takeover, queueing/fairness, affinity scheduling, durable Jobs projection, remote transports, typed physics schemas, provenance, and actor-host migration remain deferred and must arrive as separate seams or versioned contracts.

Smart Auto is proactive but not a new opaque routing authority: the visible main model decides from the current request and live descriptors, while the selected policy is logged and inspectable. It therefore improves the default experience without claiming deterministic optimal routing; trained ranking and cost/capacity optimization remain deferred, while multi-operator DAG scheduling belongs to the linked orchestration decision.

The one-step override prevents Resident continuity from becoming chat-model ownership. Consecutive routed tasks receive distinct dispatch and command identities, while only an interrupted, undelivered dispatch reuses its Receipt. A short follow-up that does not qualify for delegation returns to the primary model instead of replaying the latest settled Resident output.

Electron packaging does not change daemon authority. An Electron host re-enters its fused executable in child-only RunAsNode mode to bootstrap the same standalone daemon entry; the daemon removes the marker before any product Driver process. This keeps DSH/HMR lifetime, daemon lifetime, and Claude/Codex product lifetime separate without making the Desktop shell a second control plane.

## Verification

- Unit, protocol, Loader composition, HMR ownership, receipt conflict/recovery, artifact, redaction, symlink, interrupt/reset, and Unix-WebSocket transport tests pass. The complete repository suite reached 13,457 passing tests; the remaining app-boot/SDK timeout failures reproduce outside this change, while the touched catalog and ACP cases pass in isolation.
- On the MacBook, Claude Code and Codex both qualified as native subscription products with API-key variables removed. Independent DSH clients resumed the same native Claude Session and Codex thread; both retained random nonces across Resident daemon restart. Codex interruption left the Session inspectable, and revision-guarded reset removed only the association, not native history.
- A fresh sandbox profile installed the prebuilt Bundle through `dsh plugin`, exposed the dual-mode route in `--dump-config`, and removed the complete composition layer again. Packed-import verification caught and fixed both the hashed daemon-chunk allowlist and the Claude Agent SDK peer closure.
- Codex daemon transport uses an actual WebSocket upgrade on the owner-local Unix socket. A live canary rejected the earlier incorrect NDJSON-to-`proxy` assumption before it was released.
- Focused Electron bootstrap tests prove the current host environment is not mutated, the detached Electron child receives RunAsNode, and daemon/product environments remove the marker case-insensitively. Packaged-app acceptance remains a Desktop release gate rather than a daemon unit-test claim.
- The schema-v3 migration fixture uses the historical appended `task_label` position and a populated Receipt, while a copy of the MacBook state preserves seven Sessions and twenty-one Receipts after schema-v4 migration.
- A routing regression test delivers one Claude result, remounts the Consumer, and verifies that a short follow-up calls the primary adapter exactly once without starting or replaying a second Claude request. The durable dispatch retains the primary model config used for that restoration.
- The Mac mini remains outside canary admission: Claude Code reports no subscription login, its Codex launcher is broken by a missing Homebrew `simdjson` library, the standalone daemon install is absent, and no DSH runtime is deployed there. The default profile was not changed.
