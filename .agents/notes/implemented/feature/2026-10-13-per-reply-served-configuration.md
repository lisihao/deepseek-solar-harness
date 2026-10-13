# Agent Note: Per-reply served configuration

Status: implemented

English | [中文](2026-10-13-per-reply-served-configuration.zh.md)

## Problem

A user can change the model or reasoning effort between steps, and a native operator route may run a model the user never named (Smart Auto). The conversation showed no per-reply record of what produced a given answer: an API reply logged provider and model but not the effort, and a native reply logged only the operator name.

## Decision

The agent loop records the reasoning effort the request was built with on the `assistant/message` source, as the optional `reasoningEffort` field next to `provider` and `model`. A native reply keeps its stored source unchanged (provider `dsh-physical-operator`, model = operator id). The Host rewrites only the public view of that reply, in `session.history` pages and the live stream, to `<operator>:<native model>` plus `reasoningEffort`, taken from the dispatch of the same turn and step: the profile the daemon resolved for the command (`turn.accepted` progress) first, else the dispatch's own `residentProfile`. A reply with no recorded profile keeps the operator name.

The conversation node carries the closing reply's source as `provenance`, and `ui-conversation` passes it to `conversation.chat.assistant-actions` entries as the `served` owner prop without naming any model. `ui-model-selection` registers the caption entry: it names the model and effort with the model directory's display names, shows `operator · native model` for a native reply, and renders nothing when it cannot name the model. The caption is on the closing reply of a turn only; intermediate tool steps carry none.

## Alternatives considered

**Write the native model into the stored reply.** It would change a durable record that the lane and handoff logic match on (`source.model === operatorId`) and would need a migration for older logs. A public-view rewrite leaves the log untouched and degrades to the operator name where no profile exists.

**Resolve names in `ui-conversation`.** It does not depend on `ui-model-selection`, and the reverse dependency exists. A slot owner prop keeps display names in the package that owns the directory.

**Caption every step.** Tool steps repeat the closing reply's configuration and clutter the strip; a mid-turn change is visible in the model menu's "in effect" note.

## Consequences

`reasoningEffort` is optional and additive: older logs and older clients read replies without it, and rolling back only removes the caption. Headless and ACP snapshot logs gain the field wherever a request carried an effort. Web aria baselines gain the caption line.

At narrow widths the caption shares one row with copy, branch, and the clock, so it truncates and the full text is in its tooltip. A reply recorded before this change shows a caption without an effort. The assembled snapshots cover the API path; the native `operator · model` caption is covered by unit tests and the Host history test, not by an assembled snapshot.
