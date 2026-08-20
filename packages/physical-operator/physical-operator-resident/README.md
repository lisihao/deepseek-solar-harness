# @deepseek-ai/dsh-physical-operator-resident

English | [中文](README.zh.md)

Dual-mode Provider for one stable physical-operator id. Omitted or explicit `ephemeral` requests keep using the existing one-shot subagent Provider; explicit `resident` requests use `ctx.residentOperators` with the physical execution id as the durable command receipt identity.

The package owns routing only. It stores no session, receipt, prompt, result, scheduler state, task graph, or product credentials.

## Configuration and routing

Each mapping declares a stable physical `id`, its existing `ephemeralProvider`, optional `residentProvider`, presentation metadata, and shared `maxConcurrency`. Omitting `residentProvider` publishes only `ephemeral`; including it publishes both modes. Availability is checked for the requested mode: a missing ephemeral subscription attestation cannot incorrectly block a qualified Resident execution. The router rejects blank fields, duplicate ids, unavailable subscription attestations, missing workspaces, and unsupported modes without fallback.

The ephemeral leg calls `ctx.subagents`. The resident leg calls only the `ctx.residentOperators` Service Definition; it forwards the bounded task label and optional provider-neutral model/effort preference but never imports the local daemon Provider. Provider and Consumer therefore remain independently replaceable behind capability seams.

## Model Experience

Indirectly, through `physical_operator`, which lists supported modes and returns bounded output plus opaque continuity metadata.

#### KV Cache effect

The added optional `mode` field changes the tool schema once when this Consumer version is deployed.

## Known Limitations and Deferred Work

- Capacity is shared across both modes for a stable operator id; protocol version 4 does not queue.
- Availability is summarized at the stable operator level; product qualification still fails loud at resident execution time.
- Model callers cannot invoke Resident management methods; those remain trusted-plugin and CLI surfaces.
