# Agent Note: Workbench scheduling evidence and demand code in DSH

Status: proposed

English | [中文](2026-09-30-workbench-scheduling-migration.zh.md)

## Problem

The Smart Collaboration allocator ([Smart Collaboration allocation](../../implemented/feature/2026-09-26-smart-collaboration-allocation.md)) picks a collaborator, model, and effort from quota, capacity, a three-step model tier, and a newest-first tie-break. It has no outcome evidence. Its tier comes from model names and catalog descriptions, and nothing records whether a chosen model finished the work, how often it was redone, or what it cost.

Codex Workbench already has code for the missing inputs: independent Radar and AI Frontier collectors with last-valid-generation storage, a task-demand advisor built on OpenSquilla, content-addressed priority snapshots on a 4-hour collection and 12-hour activation cycle, exact-tier degradation alerts, and a local performance ledger. Rewriting that in DSH would repeat months of work. Moving Workbench's task database, planner, Hooks, or delivery state machine would import a second control plane.

The sources are not one version. The reading recorded in [the source manifest](../../../../distribution/workbench-scheduling-sources.json) found:

- The MacBook main (`ff51e1e`) lacks the newest work. The Mac mini main (`b358d53`) also lacks `priority_snapshots.py` and `model_alerts.py`, which exist only in the uncommitted working tree of the unified-scheduling attempt a3 (24 changed files, cut from the older `6c040a5`).
- The Radar and AI Frontier collector sources are byte-identical in all three. The collector tests in the MacBook main and in a3 are stale: 5 of 27 fail against the same code, while the Mac mini's pass 27 of 27 on Python 3.12.
- `quota.py`, `claude_quota.py`, `performance.py`, `planner.py`, `routing.py`, and `routing_v3.py` changed on the Mac mini main after a3's base (a3 changed them too, except `quota.py`), so a3's patch cannot be applied there without a three-way merge.
- The Workbench repository has no `LICENSE` file. The Radar collector derives from `wineandchord/codex-radar` (MIT, notice shipped with the source). OpenSquilla code and model-weight licenses were not audited.

## Proposal

**One decision maker.** DSH already has it: `ctx.modelAllocation` (`@deepseek-ai/dsh-model-allocation` and `-local`) decides for TaskGraph nodes and for Smart Collaboration, and model selection stays the owner's authority when pinned. No new scheduling Service Definition is added. Evidence enters the allocator as data:

- `ModelAllocationRequest` gains an optional evidence reference (snapshot ids and digests for the catalog, performance, priority, and alert inputs) and an optional demand estimate. Omission keeps today's behavior.
- The allocation result records the evidence references it used in the existing `ModelAllocationPlan` and `physical-operator/routing-decision` event, so a decision replays from those records alone.
- Quality evidence never lowers the quality floor when quota is low, and an empty candidate set returns a structured wait or no-eligible reason.

**Evidence Provider (Python, collector code copied).** `python/scheduling-evidence` holds `codex_radar_provider` and `ai_frontier_provider` from the Mac mini main, their 27 passing tests, and the upstream MIT notice. A TypeScript package spawns them as a versioned stdin/stdout JSON child process with a timeout, an output cap, a fixed interpreter and `PYTHONPATH`, and cleanup on disposal, and keeps content-addressed snapshots with an atomic active pointer under `$DSH_HOME`. A network failure or an invalid schema never replaces the last valid generation. The collectors need Python 3.11 or newer; DSH CI pins 3.10 for `python/sdk` only, so a separate 3.12 job runs their tests.

**Demand Provider (optional).** `python/scheduling-demand` adapts the OpenSquilla advisor and worker from a3, with its pinned source identity and weight checks. It returns a tier and confidence or an explicit unavailable result. It never decides a model.

**Rewritten in TypeScript, not copied.** Priority snapshots, degradation alerts, comparable-evidence ranking, the capability catalog semantics, and the local outcome projection are rewritten against DSH's storage, events, and sealed plans. `routing.py` and `routing_v3.py` are read for hard gates and receipt fields only, so the old v1/v2 plus v3 double decision does not come across. Cross-language hashing needs golden vectors, since Python canonical JSON and `JSON.stringify` differ in key order, floats, and Unicode.

**The two a3 gaps are in scope.** New work reads one active priority manifest atomically and passes the current alert quarantine to allocation, and every activation first projects a new local performance generation from DSH's execution and acceptance events through an idempotent cursor, so the ledger keeps learning.

**Phases.** S1 collectors and snapshots, S2 demand and the pure ranking core with differential tests, S3 the allocator wiring with a keyless snapshot, S4 the periodic cycle and alerts on an injected clock, S5 delivery. The first enabled mode is shadow: it records a recommendation and changes no call.

## Alternatives considered

**A new scheduling Service Definition.** The Workbench design names one, but DSH's allocator already is the single decision service; a second would split one decision across two owners.

**Port all of Workbench's routing.** It carries a double decision and Workbench's task contract. Extracting the gates and receipts is smaller and keeps DSH's TaskGraph, physical-operator, and model-selection authority.

**Rewrite the collectors in TypeScript.** It discards tested scrapers and duplicates schema validation for no behavior gain; a process boundary keeps the Python code unchanged.

**Apply a3's patch to the Mac mini main.** Six files changed on both sides. A patch is not a merge.

## Acceptance criteria

- The manifest lists every source file with its sha256 in each source, its action, and its destination; the copied collector files hash-match the Mac mini main.
- The collector tests run and pass in CI on Python 3.12, with a nonzero test count.
- Offline operation keeps the last valid generation, and a tampered digest refuses activation.
- A keyless snapshot through the real allocator shows changed comparable evidence changing the choice, and missing or incomparable evidence abstaining.
- The same input, policy, and snapshots give a byte-identical decision receipt.
- Unloading the plugin leaves no timer, child process, or event subscription.
- No claim of better quality or speed is made without a same-task, same-budget, same-harness comparison.

## Risks

- Workbench history does not transfer: its results came from another harness and stay a separate cold-start reference, not DSH samples.
- The fusion thresholds (0.6, planner weight 0.55, classifier weight 0.45) and the collection and activation ranges are unverified starting values and need replay.
- The periodic collection adds an outbound network dependency and a Python runtime that some installs lack; both are optional Providers, and the allocator works without them.
- The repository-root license gap is covered only by the owner's request to migrate; it should be settled before any redistribution.
