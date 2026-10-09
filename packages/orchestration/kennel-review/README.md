# `@deepseek-ai/dsh-kennel-review`

English | [中文](README.zh.md)

This package registers the `review`, `rework`, and `rereview` collaboration kinds with the [kennel registry](../ui-gouzi/README.md) (`ctx.kennelCollaborations`). A review has other members read a kennel task that finished, and reply with a conclusion and comments; rework hands the task back to its author with the comments of a review that asked for changes; rereview has the same reviewers check the reworked task. They follow `debate` in [`debate-orchestration`](../debate-orchestration/README.md) and show what a kind consists of: an `offer` that returns candidates, a `start` that begins one, and optionally an `outcome` that says how the collaboration ended.

## What is offered

A candidate names one finished task of the Session: a completed run that has a passed `work` node and is bound to at least one member. The newest `maxTargets` such tasks are considered, each with up to `maxReviewers` reviewers.

- A reviewer is an enabled member that holds the task's project on an entry that supports file tools and generation limits, and runs its pinned model. Members who did the task never review it. Reviewers follow registry order.
- When the user addressed one member, that member is the only reviewer, and only when the member did not do the task.
- When the message names members, those members review, in the order named, and nobody else: the authors are dropped from the names, a named member who cannot review leaves no review to offer instead of a different one, and naming more than `maxReviewers` is refused. A message that names only the authors, as the subject of the review, gets the default reviewers.
- The candidate id names the run, its revision, and every reviewer's generation, entry, and model, so a task that changed or a reviewer who changed makes a choice stale; the dispatcher then refuses it.

## What starts

The kind reads the accepted result of the task's `work` node from its events, then compiles and starts one TaskGraph with a node per reviewer. Each node is pinned to its reviewer's entry and model, reads the workspace, and has no write, execute, network, or cost budget. The graph is admitted with `gouziRecipient` for one reviewer or `gouziRecipients` for several, so the daemon checks availability, workspace, and grants for each. Reviewers run in parallel and do not see one another's comments. Each reply starts with a `结论：通过` or `结论：需要修改` line, followed by one comment per point; the room shows it attributed to the reviewer. The review never changes the task it reviews.

The Host's resource limits (context tokens, task timeout, generation and file-tool limits) come with the request, so the package has no limits of its own. `maxReviewers` and `maxTargets` are the only configuration.

## Conclusion

The first line of a reply is the conclusion: `结论：通过` or `结论：需要修改` (an ASCII colon and spaces are accepted). Anything else on the first line leaves that reviewer's conclusion unclear. The review's `outcome` adds the reviewers up for the reviewed task:

- Any reviewer asking for changes makes the task `negative` and the room shows `评审：待修改（names）`.
- Every reviewer approving makes it `positive` (`评审：已通过`).
- A reviewer who failed, answered without a conclusion, or has not answered leaves it `unclear`; while the run is unfinished it is `pending`.

The outcome is computed from the run's results each time it is read, not stored, so it follows the run. It never blocks, reopens, or deletes the reviewed task.

## Rework

When a review asked for changes, the `rework` kind offers the task back to the member that did it, once per review. The member must still be offered by the dispatcher on the same project in the same mode (a write task is reworked as a write task), and the candidate id names that offer, so a changed member makes the choice stale. The dispatcher offers it only to a message that is not addressed to another member, and the user has to ask for it; nothing is reworked automatically. The author gets the task title, the comments of the reviewers who asked for changes (not the approving ones), and the user's message, and the Host builds the task graph exactly as for the member's own messages, including file scopes, isolation, and verification for a write task. The reworked task is an ordinary finished task. The original task then also shows `已按评审意见返工`, which reports progress and not approval. A task is handed back at most `maxReworks` times (default 2), counting the rework of a rework, so a review-and-rework loop ends and the last comments stay on the task.

## Rereview

Once a reworked task has finished, the `rereview` kind offers to send it back to the reviewers of the review that asked for changes: the same members in the same order, only if every one of them can still review the task, and never in place of a different batch. It is offered once per reworked task, and not when the message names reviewers or addresses a member (that is an ordinary review) or the task was already reviewed some other way. Each reviewer gets the comments of the reviewers who asked for changes and is asked to check them one by one before looking for new problems. Its reply uses the same conclusion line, and the room shows the result on the reworked task as `复审：…` (`复审：已通过` when everyone approves). A rereview that asks for changes can be reworked again until `maxReworks` is reached. Nothing starts automatically.

## Model Experience

### Review node

#### What the model sees

A reviewer sees its member name, the names of the members who did the task, the task title, the bounded preview of the task's accepted result, the user's message, and an instruction to check the result against the task, read workspace files where needed, and open with a `结论：通过` or `结论：需要修改` line. It has file-read tools and no write, shell, or network tools.

#### Token effect

Each reviewer adds one bounded prompt: the task title, the result preview, and the user's message, within the Host's context and generation limits. Reviewers run in parallel and each pays for its own prompt.

#### KV Cache effect

No cross-node cache contract is assumed; each review node is an independent request.

### Rework and rereview nodes

#### What the model sees

The author of a rework sees its member name, the original task title, the comments of each reviewer who asked for changes under that reviewer's name, an instruction to change the work and say what was and was not changed and why, and the user's message. It works with the same tools and limits as the member's own tasks in that mode. A reviewer in a rereview sees what a first reviewer sees plus the earlier comments that asked for changes, and an instruction to check them one by one first.

#### Token effect

One bounded prompt for the author, plus the comments, which are limited by the reviewers' own output limits. A rereview adds the same comments to each reviewer's prompt.

#### KV Cache effect

No cross-node cache contract is assumed; the rework is a new task.

## Known Limitations and Deferred Work

- A review reads the preview of the task's result, not the full evidence artifact, and the delivered files only through the reviewer's file tools. A result that the daemon truncated is reviewed as truncated. A reviewer's own comments are different: when the daemon cut them off in its event preview, the conclusion and the rework or repeated review read them whole from the retained output, and a reply whose retained output cannot be read carries a note that it is cut off.
- The conclusion is read from the first line of the reply. A reviewer who words it differently is counted as unclear, not as approval.
- Outcomes are read from the live Session's log, so the room shows them only while the Session is loaded.
- Rework covers a task that one member did and that the same member is still offered for in the same mode. A task done by a set of members is reviewed but not reworked.
- A rereview needs the whole first batch. If one of them is gone, the user asks for an ordinary review and names the reviewers.
- Only tasks started by kennel dispatch (a `work` node) can be reviewed. Debates and other reviews are not offered.
- Reviewers are chosen in registry order; the user cannot pick them yet other than by addressing one member.
