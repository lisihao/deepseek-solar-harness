# Agent Note: Tests that pin the capacity, identity and usage seams before the shared RLM execution core moves

Status: implemented

English | [中文](2026-10-17-shared-rlm-execution-test-slice-a.zh.md)

## Problem

The RLM execution core lives in private methods of `OrchestrationDaemon`. Extracting it, or putting a second consumer such as an independent RLM PhysicalOperator beside it, moves code that decides three things: when a PhysicalOperator's capacity is released and its `end` is published, which operator, model and effort each Resident root, child and message continuation request carries, and which command each `rlm.usage` event names. A static reading of the existing tests found one assertion per property that is weaker than the property:

- `service.spec.ts` calls `dispose` only after the result has settled, and attaches its `end` listener after the start-failure case, so a `dispose` that releases a slot early, or a start failure that publishes an event, passes.
- The daemon-level tests compare `operatorId`, `model` and `modelOrigin` in events, never the `profile.model` and `profile.effort` of the request the Resident provider received, so a dropped or swapped effort passes.
- The usage test counts five `rlm.usage` events and compares their `source` multiset, so a child counted twice and another not at all passes.

## Decision

Tests only. Production semantics, the extraction, a new operator and the web flow are out of scope.

1. **Capacity lifecycle** (`packages/physical-operator/physical-operator/tests/service.spec.ts`, capacity-1 stub). With the result still pending, `dispose` leaves the slot taken, a second `start` gets `OPERATOR_BUSY`, and no `end` is published; the slot is released and exactly one `end` is published when the result settles. A provider that fails before it returns a run publishes neither `start` nor `end`, with both listeners attached first. The case covers `dispose`; a caller's `signal` abort is a separate path and has no case here.
2. **Identity** (`packages/orchestration/orchestration-local/tests/prime-rlm-e2e.spec.ts`). The Resident fake receives the requests the daemon builds. Each request's operator, model and effort is compared with a source no request touched: the sealed execution plan (an artifact of the run) for the root, the runtime's state file for each child and for the root session. An inherited child equals the sealed root and records `parent-inherited`; an explicit child equals what it was asked for and records `explicit`; the message continuation equals the root session's recorded model. The effort is asserted to be defined, so two undefined values cannot match. The Resident fake is used because it carries the profile; under an evaluation scope the API path fixes one model and effort for every request and would hide a wrong profile.
3. **Per-command usage** (`packages/orchestration/orchestration-local/tests/daemon.spec.ts`). The commands that ran are read from the requests the worker received and from the child and goal-continuation dispatch events. The `sourceCommandId` multiset of the `rlm.usage` events equals that set, each command once, with its own `source`, `operatorId` and `model`. Only commands with complete usage are asserted; the evidence for incomplete usage under a scope is unchanged, nothing is filled with zero, and the defaults of optional cache fields outside a scope are not touched.

## Alternatives considered

**A generic characterization or diffing framework across the three seams**, instead of one targeted assertion per weak spot. Rejected: the gap at each seam is a specific missing comparison (a source no request touched, a multiset instead of a per-command match), not a missing harness, and a framework would outlive the extraction it exists to prepare for.

**Asserting identity through the evaluation-scope API path** instead of against the Resident fake. Rejected: that scope pins the same model and effort to every request, so a dropped or swapped profile on one request would still match and the case would pass for the wrong reason.

**Folding a caller's `signal` abort into the same capacity case as `dispose`.** Rejected: they are different call paths into the same release logic, and a case that claims to cover both would not show which one a future regression actually broke.

**One usage case asserting both complete and incomplete command sets.** Rejected: nothing forces them into the same fixture, and splitting them keeps each case's failure pointing at one property.

## Consequences

The three seams each have an assertion that fails for the specific property identified as under-tested, not just for a coarser symptom, and each has a verified negative control showing it does: `dispose` releasing the slot, `dispose` publishing `end`, an extra `start` on start failure, the effort dropped from the profile, a child started with the root's allocation, a continuation or root started without its profile, and `rlm.usage` events that repeat one child and miss another, take the node execution id, or take another id, each turn the matching case red. A second `end` and an `end` after a start failure are rejected by the package's own start/end invariant before the new exactly-once assertion runs, so that assertion is not shown to fail on its own; the invariant already stops the same regression, so the practical guarantee holds, but the two controls document a gap between what they are meant to isolate and what actually turns red first. The cost is narrower scope: no general characterization framework, no `end` event for the API path, no before/after comparison (that belongs to the extraction itself), no capacity test for a root and a child sharing one capacity-1 Resident operator, and no change to recovery. Those wait for a change that touches them.

## Verification

Each case's negative control changes the real owner (the capacity and lifecycle code in `PhysicalOperatorRuntime.start`, or the request and usage code in `daemon.ts`), runs the targeted tests, and restores the bytes, checked by the restored file's hash against the original.
