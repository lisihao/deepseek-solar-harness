# Agent Note: Host-verified memory turn closure

Status: implemented

English | [中文](2026-08-21-host-verified-memory-turn-closure.zh.md)

## Problem

Memory Evolve asked the model to write project and daily progress at the end of every user turn, but the Host did not verify that the tool calls happened. A model could finish without writing anything, and the review counter lived only in process memory. Application reload therefore erased review cadence, while an empty memory panel could not distinguish a quiet session from a missed obligation. Anchored Standard also removed the memory tools from its promoted resident catalog, so the snapshot could require a write or review that the next request could not perform.

## Decision

`dsh-memory-evolve` owns a closure after every completed, top-level user-message turn. Turn and step boundaries are durable `session/event` facts in DSH; there is deliberately no mirrored `agent/settled` lifecycle event. The closure and review counter therefore register global `session/event` listeners, act only on `turn/end`, resolve the owning Agent from the session id, and filter subagent sessions themselves. Successful `memory` tool results for `daily` and `project` satisfy the obligation. For each enabled track without such a result, the Host appends a bounded summary from the final assistant text. Project closure is recorded as unavailable when the session has no working directory. The Host never promotes the summary into global, user, or key memory; those curated tracks keep their confirmation and review rules.

The plugin stores one durable session record in `turn-state.json`: successful model-authored log writes, the last counted review turn, turns since review, the last closed turn, and a receipt naming each track's `model | host` source and `ok | unavailable` result. The memory tool records a model write only after the store accepts it. Turn numbers make duplicate `turn/end` delivery idempotent. `memory_review_status` is always registered and projects the last receipt, while review suggestions remain conditional on review being enabled. Review completion resets only the durable counter and preserves the closure receipt.

Anchored Standard retains its exact two-tool bootstrap request and keeps only discovery tools resident after the first durable assistant message or tool call. An independently installed Memory Evolve profile must discover its tools on demand; the default Desktop composition uses Mnemon instead.

DSH Desktop does not seal or load `dsh-memory-evolve`. The [controlled Desktop composition](../architecture/2026-08-22-controlled-desktop-plugin-composition.md) disables stale explicit rows without deleting their user data and makes Mnemon the sole product memory implementation. This note's closure semantics apply only where Memory Evolve is independently installed outside the default product composition.

## Alternatives considered

**Keep prompt-only end-of-turn writes.** This preserves full model control over prose quality but cannot prove that a weak-following model wrote anything, and it leaves an empty panel ambiguous.

**Write every track unconditionally from the Host.** This would duplicate successful model writes and allow machine-generated summaries to enter curated global or key memory without confirmation. The closure covers only enabled log tracks and treats a successful model result as authoritative.

**Expose the full Standard tool catalog after Anchored promotion.** That restores reachability but discards the measured small-catalog trajectory. Keeping only the memory closure tools resident preserves the initial anchor and the on-demand discovery policy.

**Store a receipt event only in the session log.** Session events are durable but do not preserve the plugin's review counter or give the memory UI one local state source across application reload. The compact plugin state record owns both facts.

## Consequences

Every completed top-level user turn has an inspectable memory outcome, and the same turn cannot be added twice after replay or restart. The Host summary is intentionally bounded and less semantically curated than a model-authored entry; this is accepted for daily and project logs, which are read on demand and do not enter the prompt snapshot. Curated memory remains model- and user-governed.

The durable file adds one small per-session record and keeps only the latest closure receipt. Review cadence survives application reload; an unreadable or unsupported turn-state file fails plugin activation with its path instead of silently discarding evidence. The default Desktop product does not create this record because it does not load Memory Evolve; Anchored Standard keeps the first request on the Minimal tool pair and the promoted resident catalog on discovery tools.

## Verification

The independent Memory Evolve implementation owns verification of its durable closure behavior. In this repository, Desktop tests pin the exact first-request pair, the discovery-only promoted catalog, the absence of Memory Evolve from default composition, and the disabled state of a stale explicit row. Vendored-input verification rejects a retired Memory Evolve archive.
