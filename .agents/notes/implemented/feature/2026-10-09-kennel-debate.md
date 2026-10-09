# Agent Note: Kennel members debate as roster roles

Status: implemented

English | [中文](2026-10-09-kennel-debate.zh.md)

## Problem

Debate ran its roster on the main instance's own Codex and Claude Code operators, and the kennel could only send one message to one member. Members could not argue a question among themselves. The intended direction is that members take work and also debate, comment on, and review each other's work.

## Decision

A user message in a kennel Session can start a Debate whose roster slots are members. The [dispatcher](../../../../packages/orchestration/ui-gouzi/README.md) offers one `debate` candidate per project that at least three enabled members hold on a usable entry, never for a message addressed to one member. The AI chooses it only when the user asks for several members to debate, discuss, or review one question, as it chooses any other candidate by identity.

Roles follow registry order: the leading members argue as proposer, falsifier, and for a fourth member evidence auditor, and the last member judges. At least three members are required so the judge never argues. Each member runs the entry that can serve its pinned model, else its first usable entry, on the pinned model or the entry's catalog default. The daemon reports that default as `GouziOperatorCapability.defaultModel`, because the Host process cannot see a member's remote catalog.

The dispatcher does not know Debate policy. [`debate-orchestration`](../../../../packages/orchestration/debate-orchestration/README.md) registers it as the `debate` [collaboration kind](../architecture/2026-10-09-kennel-collaboration-kinds.md), which offers the candidates, assigns roles, derives the ordinary three-round budget from `defaultDebateBudget`, starts the Debate, and approves it in the background because approval returns when the rounds settle. The shared personas, round protocol, convergence rule, and budget moved into `@deepseek-ai/dsh-debate` so the tool and the kennel use one copy.

Each round graph is admitted with the member set from [recipient sets](../architecture/2026-10-08-gouzi-recipient-sets.md), built from the members' current generations. The daemon then checks availability, workspace, and grants for every member, and a round that mixes members with other operators is refused.

## Alternatives considered

**Let the model-facing `debate` tool pick members.** A kennel message never reaches the steward, because the dispatcher consumes it, so a tool would have no caller there and would put member selection in the model.

**Import `@deepseek-ai/dsh-debate` into the kennel plugin.** The kennel plugin would depend on Debate policy and its manifest would change. The service keeps the policy in the Debate packages.

**Allow two members.** A judge would have to be one of the arguers.

## Consequences

Progress shows as the session's TaskGraph runs in the room, attributed to each member, and in the Debate panel; nothing is streamed into the chat. The user cannot choose the members or their roles yet, and roles do not use a member's own role template. A pinned model that no usable entry offers leaves the member out, and fewer than three qualified members offers no Debate. Members also review one another's finished work through the `review` kind. Real Codex and Claude Code catalogs on a remote host have not been exercised here.
