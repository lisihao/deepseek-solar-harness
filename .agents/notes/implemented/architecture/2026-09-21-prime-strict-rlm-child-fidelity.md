# Agent Note: Prime-strict RLM child fidelity

Status: implemented

English | [中文](2026-09-21-prime-strict-rlm-child-fidelity.zh.md)

## Problem

An explicitly selected RLM run needs its children to execute with the parent's selected operator, model, reasoning preference, tool authority, managed Skills, retry rule, and context references. A generic child allocation, a live Skill lookup, or an ambient Resident tool surface can change that execution after the root has been admitted. The accepted TaskGraph template/context receipts and first-class DSH tool authority remain part of ordinary execution and cannot be weakened by an RLM-only rule.

## Decision

`prime-strict` seals `parent-inherit`: an omitted child model uses the root's exact selection and records `parent-inherited`. `dsh-optimized` seals `allocator-default` explicitly and records that origin. An explicit child model or thinking preference is validated against the current physical-operator catalog before native child dispatch.

The RLM root seals `RlmChildExecutionOptionsV1` with the TypeScript REPL bridge, Host-issued managed Skill bindings, the resolved retry policy, and capability-context references. The local kernel accepts only `name`, `model`, and `thinking` for `rlm()`. It exposes a compact Skill descriptor to the model, retains the binding outside the model-visible result, and sends that exact binding back to the Host for `skills.call`.

An RLM Resident turn uses `native_tool_policy: disabled` with exactly `typescript_repl`. The Resident daemon rejects every other bridge expansion in that mode. Regular Resident turns keep the accepted `dsh-tools-authoritative` route and task-context receipt handling.

This decision implements the strict-child row of the [proposed full Prime runtime record](../../proposed/architecture/2026-08-24-prime-agent-compatible-typescript-runtime.md). It does not claim the unimplemented rows of that proposal.

## Durable upgrade and rollback

`@deepseek-ai/dsh-rlm-runtime-local` writes store version 5. Loading versions 1 through 4 converts legacy child origins, keeps a settled receipt with no proven result as `indeterminate`, and does not dispatch that receipt again. A constructor that observed a migration persists version 5 before registering the live runtime owner.

An older Provider does not read version 5. Rolling back a machine with a legacy state file requires restoring its private pre-upgrade backup before starting the older binary; the upgraded state is not a downgrade format.

## Verification

Focused runtime tests cover versions 1 through 4, strict inheritance, sealed Skill binding, and indeterminate recovery without replay. The keyless TaskGraph E2E exercises strict child inheritance, explicit incompatible-thinking rejection before native dispatch, the optimized allocator route, and the preserved RLM bridge. A keyless runnable-example snapshot records the Loader-mounted strict-child output.

## Alternatives considered

**Use allocator selection for every omitted child model.** Rejected because explicit Prime RLM would silently run a different native profile.

**Resolve managed Skills from the live Harness catalog on every call.** Rejected because a later update could change an already admitted root's executable authority.

**Allow the complete DSH bridge on a disabled RLM turn.** Rejected because `disabled` would no longer limit the RLM-native authority to its TypeScript REPL.

**Apply the disabled policy to every Resident turn.** Rejected because ordinary E13 routes retain their accepted tool authority and task-context behavior.

## Consequences

The trace makes child inheritance and deliberate economy selection distinguishable. Explicit RLM gets a bounded Prime-compatible execution subset, while standard and first-class DSH tool routes retain their accepted behavior. The durable migration is intentionally one-way, so deployment retains a private state backup for rollback. The full Prime compatibility matrix remains governed by its proposed record.
