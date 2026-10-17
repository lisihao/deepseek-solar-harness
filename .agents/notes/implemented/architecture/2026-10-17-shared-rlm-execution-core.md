# Agent Note: A daemon-owned shared RLM execution core

Status: implemented

English | [中文](2026-10-17-shared-rlm-execution-core.zh.md)

## Problem

RLM root turns, asynchronous children and continuations share cancellation, usage accounting and terminal-result rules. Keeping their execution inside the TaskGraph daemon makes a second consumer liable to duplicate those rules or gain Scheduler and attempt-store authority it does not need.

## Decision

Each daemon creates one `createRlmExecutionCore` after its services are registered and before recovery or dispatch. The core executes Resident and API roots, children, message continuations, goals and Autonomous turns. Its goal-usage queue belongs to that daemon instance.

The daemon constructs one execution context per attempt. Root, child and continuation calls share its controller, physical-run list and cancellation scope. The daemon retains progress tracking, Scheduler state, recovery and the bound callback that persists the current attempt's native turn id. Recovery constructs a new context for the recovered attempt; it does not retain the previous process's in-memory objects.

The core receives a restricted store view for RLM events, artifacts and Autonomous state. Resident start, model-worker execution, WP1 admission and metering, capacity, and harness-boundary processing remain host-owned dependencies. `UnknownPhysicalOutcomeError` has one definition in `rlm-continuation.ts`, shared by the daemon and core so unknown outcomes keep their error identity and replay protection.

## Alternatives considered

**Extract only roots and continuations.** Leaving child dispatch in the daemon would keep one part of the same lifecycle coupled to its caller and require another implementation for a second consumer.

**Pass the full orchestration store.** That would let the core change arbitrary attempts. A callback already bound to the current run, node and attempt supplies the one required turn-id write.

**Import the unknown-outcome error from the daemon, or copy it.** The former creates an import cycle; the latter splits the class identity used by existing failure handling. The shared continuation module avoids both.

## Consequences

The daemon remains the only consumer. This extraction adds no independent RLM operator, admission route, scheduling owner or recovery capability. A future consumer still needs its own explicit admission and ownership design.

Keyless daemon tests cover two instances with identical execution identities, cancellation and unknown outcomes, and persistence of a retained native turn across daemon recreation. The isolation test fails when its usage queue is deliberately shared globally; the retained-turn test rejects a deliberately wrong turn id. The assembled `prime-rlm-terminal` example loads the new module through source and built-library launch modes. These checks establish local behavior and loading, not live-model benefit, complete RLM recovery semantics or installed-app availability.
