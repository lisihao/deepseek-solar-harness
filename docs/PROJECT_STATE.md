# Project State

This file records the current execution path, durable architecture decisions, blocking gaps, and the single next implementation slice for the Solar branch. It does not replace the current-state [architecture map](architecture.md), package contracts, generated subsystem references, or rationale in [Agent Notes](../.agents/notes/README.md).

## Current execution path

The durable orchestration daemon owns compilation, scheduling, attempts, recovery, and the content-addressed artifact store. A run compiles Intent and a logical TaskGraph, resolves Capability Capsules, optionally snapshots the Continuous Harness, compiles a bounded Context Packet, resolves RLM and model allocation, seals a Node Execution Plan, dispatches a Resident or model-worker attempt, and retains terminal Evidence and events. The public contracts live in [`@deepseek-ai/dsh-orchestration`](../packages/orchestration/orchestration/src/index.ts); the owner-local execution path lives in [`orchestration-local`](../packages/orchestration/orchestration-local/src/daemon.ts).

The current [`ContextPacketV1`](../packages/orchestration/context-compiler/src/types.ts) is an immutable per-attempt projection with source refs, optional materialized source text, lineage, redactions, token budget, compiler identity, and a content digest. It is compiled once before dispatch and does not represent a dynamic state address space or the state objects exposed later during a long RLM execution.

The persistent [`RLM runtime`](../packages/orchestration/rlm-runtime/src/index.ts) owns durable root and child sessions, child execution options, messages, goals, heartbeats, command receipts, and host requests. Child sessions inherit sealed parent execution options, but the runtime does not yet carry a provider-neutral address-space reference, working-set revision, state-access policy, or access receipts.

The orchestration store is a single-writer SQLite database plus a content-addressed artifact directory. Its cluster replica exports the configured replica tables and all stored artifacts, validates every row and artifact digest, and installs a complete newer leader image. The current store schema is version 4 in [`orchestration-local/src/store.ts`](../packages/orchestration/orchestration-local/src/store.ts).

## Stable foundations

The following shipped mechanisms are the foundations for the proposed Agentic Transaction Processing work:

- TaskGraph nodes declare capability, effect, read, write, retry, acceptance, RLM, autonomous, operator, and workspace-isolation bounds.
- Capability resolution emits an immutable binding plan with a catalog revision, capsule refs, effective scopes and effects, blockers, and a plan digest.
- Context compilation emits an immutable packet and preserves model-visible source lineage.
- Node execution plans seal the selected context, capability, model, operator, authority, RLM, harness, and verification inputs for one attempt.
- RLM root and child sessions have durable identities, bounded recursion, idempotent command receipts, explicit messages, goals, heartbeats, and host rebind after daemon recovery.
- Orchestration events and immutable artifacts support reconstruction, cluster replication, and evidence retention.
- Physical operators expose stable identity, availability, product version, protocol hash, resolved model metadata, durable accepted receipts, and optional model-tool bridges.
- Continuous Harness entries and refinements are versioned and can be snapshotted, queued, applied at turn boundaries, or rolled back.

These mechanisms provide strong per-attempt sealing and durable execution. They do not yet provide run-level semantic isolation, commit-time governed effects, dynamic state-access receipts, or a complete Agent Transaction contract.

## Active architecture proposals

The [Declarative State Access Plane proposal](../.agents/notes/proposed/architecture/2026-09-04-declarative-state-access-plane.md) defines the missing read-side capability for Agentic Transaction Processing. It separates the complete journal, the authorized state address space, the dynamic working set, and the provider-specific attention set; introduces typed access intents, grants, and receipts; specifies child permission attenuation; and reserves a native KV-block provider interface while selecting logical materialization for the first implementation.

The existing [Domain KV storage and workspace proposal](../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) owns durable storage media and domain-record semantics. It does not own model-visible state selection, access authority, working-set revisions, or attention control, and is not superseded by the Declarative State Access proposal.

Semantic Isolation, governed effect commit, and the broader Agent Transaction Engine remain architectural work discussed outside the shipped source. Declarative State Access is designed to compose with those mechanisms through semantic-epoch references, authority revisions, observed read-set digests, and effect read bases; it does not claim those mechanisms are already implemented.

## Blocking gap

A long-running attempt can persist its initial Context Packet and later RLM state, but it cannot currently prove which exact artifacts, evidence, tool results, child results, messages, or claim-ledger versions were exposed after dispatch. It also cannot dynamically reduce or expand a bounded model-visible working set through an authoritative, idempotent, recoverable command contract.

This gap has four consequences:

1. Complete durable history and active model context are coupled too tightly; retaining more evidence increases context pressure unless callers perform lossy compaction or custom retrieval.
2. Child RLM sessions inherit execution options but lack a machine-checked proof that their readable state is a permission- and capability-narrowed subset of the parent.
3. Retry, resume, and host rebind can restore execution state without an exact dynamic read history; fabricating that history from a transcript would be incorrect.
4. A future governed effect cannot bind its commit decision to a provider-observed read set, so commit-time freshness checks cannot distinguish initial context from state exposed later in the transaction.

## Single next implementation slice

```text
MODE = EVOLVE

TASK =
Implement Declarative State Access V1 as one dependency-closed logical-materialization slice. Add @deepseek-ai/dsh-state-access and @deepseek-ai/dsh-state-access-local; integrate Artifact, Evidence, Child Result, Agent Message, and Claim Ledger objects into one state-aware RLM root/child path; add state.navigate, state.focus, state.release, and state.inspect through the typed host bridge; persist and replicate address-space, working-set, command, lease, and receipt state.

TARGET =
A state-aware RLM attempt compiles ContextPacketV2 and NodeExecutionPlanV2 with an immutable address-space reference, initial working-set reference, state-access policy, and logical provider offer. A child receives an attenuated address space. Focus and release produce idempotent working-set revisions and access receipts. Recovery rebinds the same references, and an effect-intent test fixture can bind the observed read-set digest without implementing external effect commit.

ACCEPTANCE_CRITERIA =
1. Public State Access schemas and strict model/wire validators are implemented with branded refs and content digests.
2. The logical provider materializes only admitted objects and labels every source with version, digest, sensitivity, and lineage.
3. ContextPacketV1 and legacy execution/evidence records remain readable; new state-aware attempts emit explicit V2 records.
4. RLM model tools use caller-stable command IDs, request-digest conflict detection, durable accepted/settled/indeterminate states, and provider reconciliation.
5. Child address-space construction proves subset, authority, capability, policy, and semantic-epoch constraints.
6. Capability resolution includes ContextAccessContractV1; physical operator catalogs expose AttentionControlOfferV1 without claiming native KV support.
7. SQLite migration and cluster replica changes preserve existing data and reject missing tables, invalid rows, stale terms, and artifact digest mismatches.
8. Tests cover wrong focus, unauthorized objects, cross-epoch reads, replay drift, child escape, full/global budget abuse, context misses, full fallback, provider-application crash, cluster failover, and legacy recovery.
9. Model-visible access results are logged and a keyless snapshot exercises the assembled RLM path.
10. Full repository governance verification and attestation pass for the exact delivered commit.
```
