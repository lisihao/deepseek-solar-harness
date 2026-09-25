# Agent Note: Runtime-context projection and local duplication ownership

Status: implemented

English | [中文](2026-09-21-runtime-context-projection-and-local-duplication.zh.md)

## Problem

Runtime-context snapshots originate in system-prompt, while Debate and TaskGraph carried identical downstream projections. Separate Session-event invariants, physical-operator providers, and durable parsers also contained matching fragments whose surrounding state, failure attribution, or dependency direction differed. A broad clone exemption or a utility without a valid owner would hide those distinctions.

## Decision

`@deepseek-ai/dsh-system-prompt` owns `captureRuntimeContextSnapshot(messages, sourceSessionId)` and `RuntimeContextSnapshotV1`. The function reads the newest active runtime-context snapshot, detaches its named sections with the source Session and snapshot-message identities, and returns `undefined` after a clearance marker. Debate and TaskGraph retain only their typed calls to this projection.

`dsh-task-template` owns `validateMethodLayer`. A top-level template validates its version, validates and orders history, then supplies that validated version to the common method-layer validation; an archived revision uses the same helper with its ordinary version validation. The parsing error order stays unchanged.

Narrow `jscpd` ignored spans remain only where sharing would cross an ownership boundary: task-template-context stages and publishes its own trace with package-attributed failures; the Resident Provider owns its ephemeral fallback because its configuration, availability, and teardown differ from the standalone subagent Provider; and the task-template store keeps its strict prototype predicate because cosmokit accepts class instances and settings is not its dependency owner.

## Verification

Focused system-prompt, orchestration, physical-provider, task-template-store, and invariant tests pin the retained behavior. `pnpm run duplication` reports zero clones.

## Alternatives considered

**A generic Session-invariant staging helper.** Rejected because the shared listener mechanics would centralize independently owned trace state and package-specific publication failures.

**A shared physical-operator or JSON utility.** Rejected because the Provider families have distinct lifecycle ownership, and the available cosmokit predicate has broader class-instance semantics than the durable store format permits.

**A global clone exemption.** Rejected because unrelated future clones must continue to fail the duplication gate.

## Consequences

New downstream request consumers use the system-prompt projection instead of recreating snapshot provenance. The local exceptions remain exact, explained ownership decisions; they do not weaken detection elsewhere. Method-layer parsing retains the established durable-document failure behavior while one field validation implementation serves current and archived records.
