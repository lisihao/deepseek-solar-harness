# Agent Note: Make Smart Collaboration TaskGraph-native and traceable

Status: implemented

English | [中文](2026-08-20-taskgraph-smart-collaboration.zh.md)

## Problem

Smart Collaboration could route a complex request directly into one long-lived Resident Codex or Claude Code Session before the main Agent could construct a TaskGraph. Native child agents could still appear inside that product, but DSH then recorded one physical execution rather than the graph, worker count, dependency state, or scheduling decisions. Reusing a native thread also allowed an old conversation and `fork_turns: all` descendants to carry unrelated history into a new task.

The [physical-operator capability seam](../architecture/2026-08-15-physical-operator-capability-seam.md) owns product execution and continuity, while orchestration must remain the authority for parallel fan-out, dependencies, scope conflicts, retry, Evidence, and explainable completion.

## Decision

Smart Collaboration classifies a complex or explicitly parallelizable request as a TaskGraph candidate and leaves it on the primary model turn so `@deepseek-ai/dsh-tool-orchestration` can compile and start a durable graph. Explicit product preference and bounded single-operator work retain the direct Resident route. Every routing decision is appended to the DSH Session with the selected `auto | direct | codex | claude-code` policy, route, source message, and reason; TaskGraph compilation carries the same policy as admission metadata.

The local Scheduler dispatches independent nodes up to `maxParallel`, normally four, without a phase-wide barrier. Dependencies, overlapping write/effect scopes, and the worker bound serialize only affected nodes. Pending and ready nodes persist `DEPENDENCIES_PENDING`, `SCOPE_CONFLICT`, or `MAX_PARALLEL_REACHED` so waiting is observable rather than inferred from inactivity.

Model allocation records two independent routing preferences with each admission. `plannerVerifierPreference=codex-sol` prefers a qualified Codex Sol lane for planning and verification gates; `best-high-tier` retains provider-neutral high-tier scoring. `executionPreference=luna-first` prefers a qualified Codex Luna lane for coding leaves; `balanced` retains ordinary product, tier, quota, and capacity scoring. The Codex-optimized pair is the product default, but explicit operator/model requests remain authoritative and unavailable preferred families fall back within the already qualified candidate set rather than changing Graph authority.

Continuous Harness keeps three separate scopes. Session entries stay inside one RLM family, workspace entries stay inside one canonical repository, and user-global entries use the stable `global` identity in the owner-local Harness store so they remain visible across repositories. Resolution precedence is `global < workspace < session`; each attempt still seals one immutable snapshot, so later refinement cannot mutate an accepted plan.

Each orchestration attempt requires the built-in `context.clean-task` capability. Its instruction Capsule tells the native operator to treat the Context Packet and declared upstream references as the complete task context and to create child agents with empty history rather than `fork_turns: all`. The attempt uses a unique Resident lane; the daemon keys Sessions by operator, canonical workspace, and lane, so parallel nodes can execute through one qualified Codex or Claude Code host without sharing a native thread. Existing state migrates into the `legacy` lane.

Desktop projects the same durable facts. The Physical Operators panel distinguishes qualified hosts from active worker lanes. Each Orchestration run names the admitted collaboration policy, TaskGraph route, active and maximum workers, ready nodes, clean-task Capsule state, operator dispatch, lane isolation, and scheduler wait reasons in its summary and event Trace.

## Alternatives considered

**Keep routing every non-trivial Smart Collaboration request directly to one Resident product.** This preserves the shortest dispatch path but hides fan-out inside product-specific behavior, leaves DSH without a TaskGraph record, and cannot expose or govern actual parallel workers.

**Reuse one native thread and add only a cleanup sentence.** A prompt cannot erase native thread history or prevent a child runtime from copying it. A distinct lane establishes the isolation boundary before product execution begins.

**Represent each worker as another installed Codex or Claude Code host.** Product qualification and worker activity are different facts. Duplicating host rows would misstate installation state and still omit the TaskGraph node that owns each execution.

**Schedule in phase barriers.** Waiting for every node in a phase makes unrelated slow or blocked work stall the graph and recreates the deadlock-prone behavior this scheduler is intended to avoid. Dependency and scope edges provide the required ordering directly.

## Consequences

Complex Smart Collaboration produces a durable, restart-safe TaskGraph whose parallelism and waiting are visible to the user. Four lanes per native product provide bounded local fan-out, while scope conflicts and explicit dependencies prevent overlapping mutations. Context isolation costs a fresh native thread per attempt and therefore gives up automatic reuse of unrelated product history; upstream Evidence and Context Packets become the deliberate continuity mechanism.

The admission heuristic remains prompt-facing rather than a trained scheduling oracle. A complex request can stay on the primary turn if the model declines to call orchestration, and a user can still force a direct or preferred-product policy. Fairness across graphs and dynamically learned parallel bounds remain outside this decision.

## Verification

Routing tests pin Smart Collaboration TaskGraph admission and the four visible policy labels. Allocation tests compare Codex Sol against provider-neutral high-tier planning and Luna-first against balanced execution, including the rationale retained in the sealed plan. Harness tests prove one global entry is visible from two repositories while workspace entries remain isolated. Scheduler tests pin parallel non-conflicting dispatch, scope-conflict waiting, fresh per-attempt lanes, clean-task Capsule injection, and completion without a phase barrier. Resident store tests pin concurrent lanes, single-flight within a lane, and schema-v3 history migration into `legacy`. Desktop tests pin admission, worker, Capsule, operator, and lane details in the visible Trace.
