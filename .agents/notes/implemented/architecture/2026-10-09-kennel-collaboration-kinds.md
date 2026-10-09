# Agent Note: Kennel collaboration kinds

Status: implemented

English | [中文](2026-10-09-kennel-collaboration-kinds.zh.md)

## Problem

Members take work one at a time, and the kennel needs them to also debate, comment on, and review one another's work. Debate was wired into the dispatcher by name: its own candidate module, two Session events, and a prompt sentence. Each further way of working together would need the same edits in the dispatcher, the Session event vocabulary, and the invariant companion, and the dispatcher would learn every policy.

## Decision

The dispatcher offers work and control candidates itself and treats every other way of working together as a **collaboration kind** registered with `ctx.kennelCollaborations`. The Service Definition and the kind contract live in `@deepseek-ai/dsh-orchestration`; [`ui-gouzi`](../../../../packages/orchestration/ui-gouzi/README.md) provides the registry and consumes it; each kind is a plugin that registers itself in `ctx.effect`.

A kind has a name, a `guidance` sentence, `offer(facts)`, `start(request)`, and optionally `outcome(record, run, results)`. `facts` carry the members, their execution entries, this Session's runs newest first, the member the user addressed, the work offers the dispatcher gives the model, the work tasks this Session admitted, and the collaborations it started with their outcomes (see [review conclusions](2026-10-09-kennel-review-conclusions.md)). The dispatcher adds the `guidance` of every kind that offered a candidate to the selection instruction and logs two generic events, `kennel/dispatch-collaboration` before the start and `kennel/dispatch-collaboration-admitted` with each member's assignment after it. Both are `ignorable`.

A candidate id must name everything the offer depends on. The Host does not give kinds a separate confirm step: it calls `offer` again with fresh facts, before logging and before starting, and refuses a selected id that is no longer offered. A kind therefore cannot forget to re-check a member, an entry, a model, or its target. The Host also owns resource limits and passes them in the request, so a kind needs no limits of its own. `bindKennelMember` and `qualifiedKennelMembers` give kinds the same entry and model rules the dispatcher uses for work.

Two kinds ship. `debate` ([`debate-orchestration`](../../../../packages/orchestration/debate-orchestration/README.md)) is the earlier [kennel Debate](../feature/2026-10-09-kennel-debate.md) moved behind the seam. `review` ([`kennel-review`](../../../../packages/orchestration/kennel-review/README.md)) offers a finished kennel task, has other members read it with read-only file access, and asks for a conclusion and comments. A review is an ordinary TaskGraph run with a node per reviewer, so the room, grants, and scheduling already apply. Members who did the task never review it; a message addressed to one member makes that member the only reviewer.

## Alternatives considered

**One generic collaboration with a mode field.** Debate and review differ in roster, graph, and budget; a mode field would move their policy into the shared code and make every new kind edit it.

**A separate service per kind (`kennelDebates`, `kennelReviews`).** The dispatcher would name each service and event, which is the problem this note removes.

**A confirm method on each kind.** Each kind would have to repeat the checks the offer already makes, and a missed check would start work on a changed member.

## Consequences

Adding a way of working together is a plugin that injects `kennelCollaborations` and registers a kind; it changes neither the dispatcher nor the event vocabulary. The candidate JSON the model reads grows with each kind, bounded by the dispatcher's input limit. Kind names are global and `work`, `control`, and `clarify` are reserved. The kinds that ship are only available where their packages are mounted; Desktop receives `kennel-review` when its package inputs are next sealed. A review's conclusion is read and acted on only through its kind's `outcome` and the `rework` kind; the registry itself has no notion of a verdict.
