# Debate

English | [中文](README.zh.md)

`@deepseek-ai/dsh-debate` defines the provider-neutral `ctx.debates` seam for a bounded multi-agent debate. It is a Service Definition only: an existing TaskGraph or RLM Consumer may submit a debate, while a Provider resolves roster slots to physical operators. This package does not own a Scheduler, database, daemon, UI, or model call.

## Contract

- `DebatePolicyV1` fixes the permitted roster roles: constructive proposer, skeptical falsifier, evidence auditor, and decision judge. A policy must contain a judge and at least two participant roles.
- The round protocol is fixed as blind independent first drafts, claim-ledger follow-up, and high-severity-unresolved escalation. Providers enforce the bounded `DebateBudgetV1` before dispatch.
- Claims, evidence refs, dissent, unresolved gaps, convergence reasons, usage/cost, and provider provenance are durable JSON-compatible records. `usageStatus` and `costStatus` distinguish known, partial, and unknown accounting; missing counters are never projected as zero. Dissent is retained; convergence never means forced unanimity.
- `start`, `list`, `inspect`, `readEvents`, and `control` are the complete seam. `control` carries an expected revision for optimistic concurrency and explicit approval, pause, resume, stop, or reject decisions.

## Provider boundary

Providers must validate untrusted JSON with the exported `validateDebatePolicy`, `validateDebateStartRequest`, `validateDebateControlRequest`, and `validateDebateEventReadRequest` functions. Unknown fields, wrong versions, unsupported role identifiers, parent-identity mismatches, unsafe budgets, and unbounded event pages fail closed. Every start request names the canonical TaskGraph workspace. `commandId` is the adapter idempotency identity; the package does not persist receipts.

The Debate package is a Consumer/Provider seam for the existing execution system. It may be called from a TaskGraph node or an RLM session through `execution`, but it cannot create graph nodes, dispatch a physical operator, mutate scheduler state, or bypass the parent run's permissions. The Provider owns those integrations and must preserve their authority boundaries.

## Model Experience

### Provider-neutral `ctx.debates` run contract

#### What the model sees

Nothing directly. The `ctx.debates` Service Definition has no model adapter and does not call a model. A Consumer owns any tool or prompt surface, while a Provider may map participant and judge slots to qualified physical operators under the parent Scheduler's quota and policy decisions.

#### Token effect

None at the Service Definition layer. The Consumer owns tool-schema tokens and the Provider owns role-turn prompts and bounded results.

#### KV Cache effect

None at the Service Definition layer. Providers may account for cache-read/write tokens in `DebateUsageV1` and `DebateCostSummaryV1`; the contract does not assume that a cache is durable or shared between slots.

## Known Limitations and Deferred Work

- No daemon, SQLite store, event writer, UI, local registry, or real model Provider is included.
- Dynamic role injection and true mid-turn hot swapping are not part of this contract. A new roster or capability generation must be submitted by the owning TaskGraph/RLM integration before the next turn.
- Convergence scoring is represented as versioned evidence, not computed here; a Provider must not treat `unknown`, budget exhaustion, or unresolved blocking claims as success.
- The package does not guarantee that debate improves answer quality. Consumers should compare it with standard and RLM modes using their own end-to-end evaluation fixtures.
