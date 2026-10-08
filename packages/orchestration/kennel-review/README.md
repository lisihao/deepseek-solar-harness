# `@deepseek-ai/dsh-kennel-review`

English | [中文](README.zh.md)

This package registers the `review` collaboration kind with the [kennel registry](../ui-gouzi/README.md) (`ctx.kennelCollaborations`). A review has other members read a kennel task that finished, and reply with a conclusion and comments. It is the second kind after `debate` in [`debate-orchestration`](../debate-orchestration/README.md), and shows what a kind consists of: an `offer` that returns candidates and a `start` that begins one.

## What is offered

A candidate names one finished task of the Session: a completed run that has a passed `work` node and is bound to at least one member. The newest `maxTargets` such tasks are considered, each with up to `maxReviewers` reviewers.

- A reviewer is an enabled member that holds the task's project on an entry that supports file tools and generation limits, and runs its pinned model. Members who did the task never review it. Reviewers follow registry order.
- When the user addressed one member, that member is the only reviewer, and only when the member did not do the task.
- The candidate id names the run, its revision, and every reviewer's generation, entry, and model, so a task that changed or a reviewer who changed makes a choice stale; the dispatcher then refuses it.

## What starts

The kind reads the accepted result of the task's `work` node from its events, then compiles and starts one TaskGraph with a node per reviewer. Each node is pinned to its reviewer's entry and model, reads the workspace, and has no write, execute, network, or cost budget. The graph is admitted with `gouziRecipient` for one reviewer or `gouziRecipients` for several, so the daemon checks availability, workspace, and grants for each. Reviewers run in parallel and do not see one another's comments. Each reply starts with a `结论：通过` or `结论：需要修改` line, followed by one comment per point; the room shows it attributed to the reviewer. The review never changes the task it reviews.

The Host's resource limits (context tokens, task timeout, generation and file-tool limits) come with the request, so the package has no limits of its own. `maxReviewers` and `maxTargets` are the only configuration.

## Model Experience

### Review node

#### What the model sees

A reviewer sees its member name, the names of the members who did the task, the task title, the bounded preview of the task's accepted result, the user's message, and an instruction to check the result against the task, read workspace files where needed, and open with a `结论：通过` or `结论：需要修改` line. It has file-read tools and no write, shell, or network tools.

#### Token effect

Each reviewer adds one bounded prompt: the task title, the result preview, and the user's message, within the Host's context and generation limits. Reviewers run in parallel and each pays for its own prompt.

#### KV Cache effect

No cross-node cache contract is assumed; each review node is an independent request.

## Known Limitations and Deferred Work

- A review reads the preview of the task's result, not the full evidence artifact, and the delivered files only through the reviewer's file tools. A result that the daemon truncated is reviewed as truncated.
- The conclusion line is a convention in the reply text. The room shows it as text; no code reads it as a verdict, and a review does not reopen or block the task it reviews.
- Only tasks started by kennel dispatch (a `work` node) can be reviewed. Debates and other reviews are not offered.
- Reviewers are chosen in registry order; the user cannot pick them yet other than by addressing one member.
