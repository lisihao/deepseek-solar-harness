# Agent Note: Kennel review conclusions take effect

Status: implemented

English | [中文](2026-10-09-kennel-review-conclusions.zh.md)

## Problem

A [review](2026-10-09-kennel-collaboration-kinds.md) ended as text in the room. Nothing said whether the reviewed task was approved, and the author never saw the comments unless the user copied them.

## Decision

A review's conclusion is the first line of each reviewer's reply, `结论：通过` or `结论：需要修改`. The `review` kind reads it in its `outcome` and adds the reviewers up for the reviewed task: any reviewer asking for changes makes the task `negative`, every reviewer approving makes it `positive`, and a reviewer who failed, gave no recognizable conclusion, or has not answered leaves it `unclear` (`pending` while the run is unfinished). The prompt and the reader are built from the same two constants, so they cannot drift.

The outcome is derived, not stored. The Host reads the Session log for the collaborations the Session started, asks each kind for the outcome of the run's current results, and the room shows it on the task it is about. A stored verdict would need an observer of run completion and would go stale when a run is cancelled or resumed; deriving it follows the run.

The consequence is a second kind, `rework`. It is offered only when a review's outcome is `negative`, once per review, and only to the member that did the task, on the same project and in the same mode, if the dispatcher still offers that. The user has to ask for it; the dispatcher never starts it. The author receives the comments of the reviewers who asked for changes, and the Host builds the task graph with its own `workGraph`, so a write task is reworked with the same isolation and verification as the member's own messages. The kind never composes permissions. The reworked task is an ordinary finished task. A task is handed back at most `maxReworks` times, counting the rework of a rework, so a review-and-rework loop ends with the last comments on the task.

The `rereview` kind closes the loop. Once a reworked task has finished it offers to send the task back to the same reviewers of the review that asked for changes, in the same order, carrying the comments that asked for changes so they check those first. It is offered once per reworked task and only when every first reviewer can still review it, because another batch would not be "the same reviewers"; a message that names reviewers or addresses a member is an ordinary review instead. Its outcome is the same sum, worded `复审`, so the reworked task shows its own conclusion and a negative one can be reworked again.

To let kinds act on history, the seam gives them the dispatcher's work offers, the work tasks admitted in the Session (with the offer that took each, read back from the Session log), and the earlier collaborations with their outcomes. Using the dispatcher's own offers keeps one definition of which member can take which task in which mode.

## Alternatives considered

**Reopen or block the reviewed task.** A review is advice from other members; the task stays what it was. Blocking would give a reviewer's text authority over a task that already passed its own acceptance.

**Start rework automatically on `negative`.** It would create write tasks nobody asked for, with no bound on review-and-rework loops or cost. The user asked for rework to be a choice.

**Store the verdict in a new Session event.** It would need an owner to notice completion and would duplicate what the run already holds.

**Start the rereview automatically when the rework finishes.** It is another batch of model work nobody asked for, and the user may want different reviewers; the user has to ask.

**Majority vote.** One reviewer finding a real problem should not be outvoted; the user chose the conservative rule.

## Consequences

The room shows outcomes only while the Session is loaded, because it reads the Session log. A task done by a set of members can be reviewed but not reworked. The conclusion is a text convention: a reviewer who words it differently counts as unclear, never as approval. After a rework the original task shows both the review and the rework, and only a review or rereview of the reworked task can approve it. A rereview needs the whole first batch; if one of them is gone the user asks for an ordinary review and names reviewers. Real Codex and Claude Code replies have not been exercised here, so how often they follow the first-line convention is unmeasured.
