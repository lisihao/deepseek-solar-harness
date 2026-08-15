# Agent Note: Extract physical operators as a DSH capability seam

Status: implemented

English | [中文](2026-08-15-physical-operator-capability-seam.zh.md)

## Problem

AI4Research contains useful physical-operator concepts, but integrating the whole project as one DSH Bundle would preserve an oversized business boundary and create a second orchestration authority inside the harness. Its existing physical-operator implementation also mixes stable operator identity with a Solar-shaped TaskGraph, filesystem inbox, leases, graph/gate mutations, and a large read-only transition catalog. Copying that runtime would make DSH depend on historical state and implementation defects before the execution substrate can be redesigned.

DSH nevertheless needs one seamless way for agents and plugins to discover a physics capability, call it, cancel it, observe capacity, and replace the backing execution product without changing model-facing contracts.

## Decision

Extract the stable capability boundary, not the AI4Research runtime. The first slice follows the repository's Service Definition / Service Provider / Consumer architecture:

1. `@deepseek-ai/dsh-physical-operator` owns `ctx.physicalOperators`, stable ids, descriptors, live availability, fail-fast capacity, typed errors, and paired execution lifecycle events.
2. `@deepseek-ai/dsh-physical-operator-subagent` maps stable ids to existing `ctx.subagents` providers. The first verified product mappings are `codex` and `claude-code`; both are subscription-only and fail closed unless their provider attests a native-account path with no explicit child environment. Loading the mapping starts neither product.
3. `@deepseek-ai/dsh-tool-physical-operator` exposes one fixed `physical_operator` tool with `list` and foreground `run`. The model chooses a stable operator id and never sees provider transport.

The three roles ship as independent packages and an opt-in Loader composition, not as an AI4Research Bundle. Provider and Consumer depend only on the Service Definition and do not import one another. Accepted runs survive Provider HMR; capacity is preserved by stable id until settlement. Caller cancellation flows through the service into the existing subagent provider, which remains the execution and teardown owner.

This extraction copies no AI4Research Python daemon, scheduler, TaskGraph, state store, file inbox, operator catalog, or business workflow. It modifies no Solar repository or generated DSH runtime. Future substrate work can add sibling Providers or deliberately version the shared contract without re-importing the monolith.

## Alternatives considered

- **Install AI4Research as one DSH Bundle** — rejected because it makes a whole application the plugin boundary and carries orchestration/state authority that DSH does not need for a physical-operator call.
- **Port the existing Python `operator_runtime` and `operatord` unchanged** — rejected because their Solar-shaped persistence, leases, TaskGraph, and file protocol are the exact substrate that still needs redesign.
- **Expose Codex and Claude Code directly as separate physics tools** — rejected because product selection would leak into the model contract and every new execution backend would churn schemas and prompts.
- **Use the generic `subagent` tool without a domain seam** — rejected because it has no stable physical-operator identity, availability/capacity contract, or future typed physics result boundary.
- **Add queueing, routing, receipts, and artifact schemas immediately** — deferred until the old substrate defects and required physics semantics are specified; inventing them during extraction would freeze another guess.

## Consequences

DSH now has a small, replaceable physical-operator capability seam that can use the already implemented Claude Code and Codex products without Core changes. Keyless Loader evidence exercises the complete tool-to-subagent route, while a second real-product composition proves both product mappings register, report native-subscription authentication, and stay lazy with an empty `PATH`. Unit evidence proves missing or explicit-environment attestations are rejected at discovery and execution; a host live canary remains the evidence for current subscription entitlement.

This is intentionally only the first substrate slice. Selection/scoring, durable command receipts, persistence and crash recovery, queues and fairness, quota/cooldown, progress, typed physics schemas, content-addressed artifacts, provenance, and actor-host migration remain deferred. Their later design must extend or replace the appropriate role rather than expanding a monolithic Bundle.
