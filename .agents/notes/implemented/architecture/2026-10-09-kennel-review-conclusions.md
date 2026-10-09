# Agent Note: Kennel review conclusions take effect

Status: implemented

English | [中文](2026-10-09-kennel-review-conclusions.zh.md)

## Problem

A [review](2026-10-09-kennel-collaboration-kinds.md) ended as text in the room. Nothing said whether the reviewed task was approved, and the author never saw the comments unless the user copied them.

## Decision

A review's conclusion is the first line of each reviewer's reply, `结论：通过` or `结论：需要修改`. The `review` kind reads it in its `outcome` and adds the reviewers up for the reviewed task: any reviewer asking for changes makes the task `negative`, every reviewer approving makes it `positive`, and a reviewer who failed, gave no recognizable conclusion, or has not answered leaves it `unclear` (`pending` while the run is unfinished). The prompt and the reader are built from the same two constants, so they cannot drift.

The outcome is derived, not stored. The Host reads the Session log for the collaborations the Session started, asks each kind for the outcome of the run's current results, and the room shows it on the task it is about. A stored verdict would need an observer of run completion and would go stale when a run is cancelled or resumed; deriving it follows the run.

The consequence is a second kind, `rework`. It is offered only when a review's outcome is `negative`, once per review, and only to the member that did the task, on the same project and in the same mode, if the dispatcher still offers that. The user has to ask for it; the dispatcher never starts it. The author receives the comments of the reviewers who asked for changes, and the Host builds the task graph with its own `workGraph`, so a write task is reworked with the same isolation and verification as the member's own messages. The kind never composes permissions. The reworked task is an ordinary finished task and can be reviewed again.

To let kinds act on history, the seam gives them the dispatcher's work offers, the work tasks admitted in the Session (with the offer that took each, read back from the Session log), and the earlier collaborations with their outcomes. Using the dispatcher's own offers keeps one definition of which member can take which task in which mode.

## Alternatives considered

**Reopen or block the reviewed task.** A review is advice from other members; the task stays what it was. Blocking would give a reviewer's text authority over a task that already passed its own acceptance.

**Start rework automatically on `negative`.** It would create write tasks nobody asked for, with no bound on review-and-rework loops or cost. The user asked for rework to be a choice.

**Store the verdict in a new Session event.** It would need an owner to notice completion and would duplicate what the run already holds.

**Majority vote.** One reviewer finding a real problem should not be outvoted; the user chose the conservative rule.

## Consequences

The room shows outcomes only while the Session is loaded, because it reads the Session log. A task done by a set of members can be reviewed but not reworked. The conclusion is a text convention: a reviewer who words it differently counts as unclear, never as approval. After a rework the original task shows both the review and the rework, and only a new review of the reworked task can approve it. Real Codex and Claude Code replies have not been exercised here, so how often they follow the first-line convention is unmeasured.
