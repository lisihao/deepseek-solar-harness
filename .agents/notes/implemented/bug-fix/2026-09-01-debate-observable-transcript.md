# Agent Note: Observable Debate transcript

Status: implemented

English | [中文](2026-09-01-debate-observable-transcript.zh.md)

## Problem

The Debate Provider persisted the roster, each round's agent turns, convergence, and final synthesis, but the host adapter returned only the final synthesis. The Desktop projection also discarded historical turn previews, and its panel rendered neither the retained latest preview nor the per-round agent output. Users therefore could not verify who participated, which role each agent played, or how the discussion progressed.

## Decision

The persistent Debate snapshot remains the single authority. The host adapter emits the public roster, each newly settled round turn, convergence, and the decision judge's final moderator summary while the approved run progresses. Reconnection and Desktop reload reconstruct the same view from the snapshot rather than a second transcript store.

The browser projection retains bounded public role mandates and bounded per-round explicit output summaries with their Artifact references, claims, Evidence references, usage, timestamps, and errors. The panel renders participants first, then every round in agent order, and labels the decision judge's synthesis as the moderator summary.

Only explicit agent output summaries are exposed. Browser event data is projected through an event-type allowlist, so persona-private instructions, hidden reasoning, unknown Provider fields, and chain-of-thought remain outside the projection. Large outputs remain content-addressed Artifacts. A settled turn must provide either a public bounded preview or an Artifact reference; otherwise the Provider records it as an invalid failed turn instead of presenting an empty discussion result.

## Verification

Focused Consumer tests pin roster-first streaming, per-round output order, convergence, and moderator-last synthesis. Host and client projection tests cover multiple agents across multiple rounds, bounded previews, role mandates, Artifact references, event-field filtering, invalid empty results, and reconstruction from a persisted snapshot. The keyless Debate composition fixture proves the complete visible sequence without invoking a paid model.

## Alternatives considered

**Show only the final synthesis and require users to inspect raw Artifacts.** Rejected because it hides the defining multi-agent behavior and prevents users from evaluating each role's contribution.

**Copy every agent response into new Session events.** Rejected because it creates a second transcript authority and complicates replay. The existing Debate snapshot already owns the durable turns.

**Expose full model transcripts or private reasoning.** Rejected because the user-facing contract requires discussion results, not hidden reasoning, and large content already has an Artifact path.

## Consequences

Debate output now explains its participants and progression before presenting the moderator's conclusion. Output remains bounded, replayable after DSH restarts, and independent of the TaskGraph and physical-operator authorities. The current Provider settles participant output at round granularity, so the UI can update as rounds settle but does not claim token-level streaming.
