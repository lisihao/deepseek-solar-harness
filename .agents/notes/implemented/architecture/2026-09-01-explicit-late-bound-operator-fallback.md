# Agent Note: Explicit late-bound operator fallback preserves Debate role semantics

Status: implemented

English | [中文](2026-09-01-explicit-late-bound-operator-fallback.zh.md)

## Problem

Debate has logical roles and personas, while the Scheduler has physical operator and model offers that can become unavailable independently. Treating every unavailable preferred operator as an invitation to search all offers either violates an explicit user selection or hides the reason a different product executed a role. Treating a round as one failure also hides settled role output when another role is blocked.

The [TaskGraph-native Smart Collaboration](../feature/2026-08-20-taskgraph-smart-collaboration.md) decision already owns provider-neutral preference and hard-pin behavior. It does not define the durable admission and provenance contract for an explicitly authorized physical fallback.

## Decision

Graph `operator.preferredIds` is normalized as `preferredOperatorIds` for allocation and remains a hard pin. Omitting `operator.fallbackIds` preserves the old behavior: a preferred operator that cannot qualify fails explicitly, and the Scheduler does not broaden the candidate set. A caller may explicitly authorize deployment-owned alternatives with `operator.fallbackIds`; Debate roster roles expose the same intent as `fallbackOperatorIds`.

The Scheduler considers those explicit alternatives only when every preferred lane is disqualified for one of the non-capacity reasons `OPERATOR_UNAVAILABLE`, `AUTHENTICATION_UNQUALIFIED`, `MODEL_UNAVAILABLE`, or `QUOTA_UNQUALIFIED`. A qualified preferred lane with no free slot produces `MODEL_CAPACITY_BUSY` and remains busy or waiting; temporary saturation does not trigger fallback.

Fallback selection remains inside offers already admitted by the active policy, authentication, quota, source, and effect checks. The fallback field does not authorize a metered API, bypass native-subscription qualification, expand a Graph permission budget, or silently choose an unlisted operator.

The logical roster is unchanged by physical fallback. Role id, role kind, model intent, persona, mandate, and instructions remain the same; only the physical operator and sealed model of that Attempt are late-bound. One physical Provider may therefore host several independent logical roles, such as proposer, falsifier, and judge, without pretending that those roles are different installations or requiring cross-provider diversity.

The sealed allocation plan records `fromOperatorId`, optional `fromModel`, and a stable `reasonCode`. The Debate turn projection records requested and actual operator/model, fallback reason, allocation-plan reference, Attempt, and structured blockers. These fields make a fallback observable in the durable Trace rather than a hidden retry.

Round projection is per role. A settled proposer, a blocked falsifier, and a dependency-blocked judge retain their independent states, outputs, attempts, routing, and blockers. A run can be failed or awaiting recovery without rewriting successful role results as failures; explicit recovery decides what happens to blocked or indeterminate work.

This note partially supersedes the fallback sentence in [TaskGraph-native Smart Collaboration](../feature/2026-08-20-taskgraph-smart-collaboration.md): that note continues to own collaboration preference and graph admission, while this note owns explicit fallback authorization, capacity semantics, provenance, and per-role outcome projection.

## Alternatives considered

**Fall back to any qualified offer when a preferred operator is unavailable.** Rejected because it turns a hard operator selection into an implicit provider switch, gives the user no control over which product may run, and makes the resulting Trace unable to explain the route.

**Treat temporary capacity saturation as operator unavailability.** Rejected because a busy but qualified lane should recover without changing product or model semantics; using fallback for every full slot causes avoidable route oscillation and can consume another quota pool.

**Copy the role into a separate roster entry for every physical Provider.** Rejected because role and persona are logical facts, while Provider and model are execution facts. Per-attempt late binding allows one Provider to carry multiple roles without duplicating debate policy or weakening role-level Trace.

**Permit metered API offers as an automatic fallback.** Rejected because an explicit physical fallback is not consent to incur metered cost. Metered execution requires a separate policy decision and admission path; this contract never grants it implicitly.

**Collapse the whole round when one role fails.** Rejected because it discards independently settled evidence and makes an unavailable Claude role look like a failed Codex role. The Scheduler and Debate Provider preserve each slot's terminal fact and let dependency failure remain distinct from physical unavailability.

## Consequences

Users retain predictable hard-pin behavior by default and can opt into a narrowly defined fallback list when a Debate role may move between subscription-backed operators. A Codex-only roster can carry proposer, falsifier, and judge roles when Claude is unavailable, while the Trace still shows the requested role and the actual physical route.

The durable model gains explicit routing and blocker fields, and every fallback requires a late allocation decision at the Attempt boundary. This adds provenance to plans and projections and makes partial rounds more informative, but a busy preferred lane can wait instead of using spare fallback capacity. The contract also deliberately leaves automatic metered API fallback and in-turn capability changes outside this path.

## Related

The allocation and Graph contracts live in [`model-allocation`](../../../../packages/orchestration/model-allocation/src/index.ts) and [`orchestration`](../../../../packages/orchestration/orchestration/src/index.ts); Debate role and turn projections live in [`debate`](../../../../packages/orchestration/debate/src/types.ts).
