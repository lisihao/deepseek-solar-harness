# Agent Note: A native lane per configuration, and a handoff for what the lane has not seen

Status: implemented

English | [中文](2026-10-13-native-lane-per-profile-and-session-handoff.zh.md)

## Problem

A Resident native lane is locked to the model and effort of its first accepted command, and a resumed native thread sees only the current task, the runtime context and the task templates. A user who changed the native model or effort in one session was refused with `EXECUTION_PROFILE_CONFLICT`, and a user who went from Codex to DeepSeek and back found that Codex had not heard the requirement change in between. The [proposal](../../proposed/architecture/2026-10-13-same-session-model-switching-and-context-reuse.md) designed the whole switch; this note records phase 1, the part that shipped.

## Decision

**A lane per configuration.** `packages/physical-operator/tool-physical-operator/src/lanes.ts` chooses the lane of a native dispatch. The first configuration of a session keeps the daemon's default lane, so no stored session is migrated or reset. A native model the user names uses the lane whose profile matches, or gets `<agent id>~<model>~<effort>`. A choice without an explicit native model reuses the newest lane, which keeps the profile reuse of [resident execution profiles](2026-08-16-resident-execution-profiles.md). The Resident store, its schema 6 and protocol 14 are unchanged, because the store already keys a session by `(operator, workspace, lane)`.

**The lane and the handoff interval are frozen on the dispatch.** `physical-operator/dispatch` gains an optional `residentLaneId` (absent means the default lane, which is every log written before this change) and `handoff` (`afterSeq`, `beforeSeq`, `maxChars`). Both are written before the command is sent, so a recovery after a crash reuses them even when the user has since named another model. The dispatch is chosen in the agent loop before the task message is appended, so `beforeSeq` is the next seq when the message is not in the log yet.

**The handoff is a named context in the existing envelope.** The `session-handoff` context of `OperatorContextEnvelopeV1` carries the user's own words and the replies of other models after the lane's confirmed position, which is its newest dispatch whose reply reached the session. The text depends only on the raw events inside the frozen interval, not on the current surface and not on the configuration, so recomputing it after a compaction or a restart gives the same text and the same digest. The envelope module and the daemon are untouched. The user's words are marked as the user's and keep their authority; replies and summaries are marked as a quoted record. Tool results, skill catalogs, runtime context and plugin messages are left out.

**Size.** `Config.handoffMaxChars` (default 48,000 characters) bounds the text. A gap above the limit keeps the newest messages that fit and says how many earlier ones it left out. Failing the dispatch instead would lock a lane out for good: its confirmed position only moves forward after a delivered reply, so the next attempt would face a longer gap. A lane that has never run also starts from the latest compaction summary.

## Alternatives considered

**Relax the profile lock.** It changes the store and relies on native behavior nobody has verified, and it has no way back to the previous profile's thread.

**Build the handoff from the request's current messages.** Compaction changes them, so a recovery after a compaction would produce a different digest and the same command id would conflict.

**Store the handoff text on the event.** The text can be large and is derivable from events that are already in the log.

**A generation counter for execution authority.** The agent loop already runs one dispatch at a time per session, and a recovered dispatch keeps its recorded lane, so the lane and the dispatch order say which lane acts.

## Consequences

A long gap can omit earlier user messages, including a standing constraint; the handoff says how many it left out, and the user can repeat the constraint or compact the session so a summary carries it. A configuration change costs a cold native thread on its first use; coming back to a lane is warm. Rolling back to 3.42.x keeps the data but loses the feature: the older program ignores `residentLaneId` and sends the newest profile to the default lane, which brings `EXECUTION_PROFILE_CONFLICT` back. The explicit tool path (`explicit-tool:<id>`) and the fallback route are not changed beyond using the same lane choice. The "selected versus in effect" display shipped afterwards: `session.models` carries an optional `effective` and the model menu names both when they differ. What still belongs to the proposal: context-size work and per-message usage and configuration. The restart window of an unapplied selection is described there.
