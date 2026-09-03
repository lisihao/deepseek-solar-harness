# Agent Note: Observable Debate transcript

Status: implemented

English | [中文](2026-09-01-debate-observable-transcript.zh.md)

## Problem

The Debate Provider persisted the roster, each round's agent turns, convergence, and final synthesis, but the host adapter returned only the final synthesis. The Desktop projection also discarded historical turn previews, and its panel rendered neither the retained latest preview nor the per-round agent output. Users therefore could not verify who participated, which role each agent played, or how the discussion progressed.

## Decision

The persistent Debate snapshot remains the single authority. Every Run persists its public topic, and the host adapter emits the public roster, each newly settled round turn, convergence, and the decision judge's final moderator summary while the approved run progresses. Reconnection and Desktop reload reconstruct the discussion from the snapshot rather than treating an assistant message as a second transcript authority.

The browser projection retains bounded public role mandates and bounded per-round explicit output summaries with their Artifact references, claims, Evidence references, usage, timestamps, and errors. The panel renders the public topic, a semantic participant table, every round in agent order, and the decision judge's synthesis as the moderator summary. Markdown headings and lists stay structured; claims render as individual items, while internal role and slot identifiers remain diagnostic data.

The host appends one ignorable `debate/trace` Session event for each durable Debate event, keyed by `(runId, sourceSequence)`. This bounded projection lets the generic trajectory show rounds, roles, requested and actual models, fallbacks, public output, claims, Evidence, convergence, and synthesis without creating additional `assistant/message` records or feeding trace data back into model history. Replay deduplicates the projection by the same source identity.

Run lifecycle and convergence disposition are separate facts. A terminal convergence result enters `synthesizing` while the moderator prepares the final result, and the Run commits `completed`, `budget_limited`, or `max_rounds` only after synthesis settles; a terminal Run cannot dispatch another round.

Only explicit agent output summaries are exposed. Browser event data is projected through an event-type allowlist, so persona-private instructions, hidden reasoning, unknown Provider fields, and chain-of-thought remain outside the projection. Large outputs remain content-addressed Artifacts. A settled turn must provide either a public bounded preview or an Artifact reference; otherwise the Provider records it as an invalid failed turn instead of presenting an empty discussion result.

## Verification

Focused Consumer tests pin topic and roster-first streaming, per-round output order, convergence, moderator-last synthesis, trace deduplication, and the absence of raw HTML or internal identifiers. Host, client, and trajectory projection tests cover multiple agents across multiple rounds, requested and actual models, fallback, bounded previews, role mandates, Artifact references, event-field filtering, invalid empty results, and reconstruction from persisted state. The keyless Debate composition fixture proves the complete visible sequence without invoking a paid model.

## Alternatives considered

**Show only the final synthesis and require users to inspect raw Artifacts.** Rejected because it hides the defining multi-agent behavior and prevents users from evaluating each role's contribution.

**Copy agent responses into additional assistant messages.** Rejected because it would create a second model transcript authority and feed Debate internals back into later model context. The bounded, ignorable `debate/trace` projection carries only the public inspection facts and keeps the Debate snapshot authoritative.

**Expose full model transcripts or private reasoning.** Rejected because the user-facing contract requires discussion results, not hidden reasoning, and large content already has an Artifact path.

## Consequences

Debate output explains its topic, participants, progression, convergence, and moderator conclusion with one consistent hierarchy. Both the Debate panel and the generic trajectory remain bounded and replayable after DSH restarts, while model history contains only the intended final assistant response. The current Provider settles participant output at round granularity, so the UI can update as rounds settle but does not claim token-level streaming.
