# Agent Note: The user names the members of a collaboration

Status: implemented

English | [中文](2026-10-09-kennel-named-members.zh.md)

## Problem

A [collaboration kind](2026-10-09-kennel-collaboration-kinds.md) chose its members itself: the first members in registry order for a Debate or a review. The user could only address one member. A user who writes "have gamma and beta review that" or "alpha and delta, debate this" had no way to say so.

## Decision

The Host reads the user's message for the names of enabled members and tells every kind, in `facts.mentioned`, which members it names in order of first mention. The match is case-insensitive, an ASCII name must not sit inside a longer word, a longer name wins over a name inside it, and a name that more than one enabled member has is ambiguous and left out. A kind decides what the names mean, and `kennelRoster` in `@deepseek-ai/dsh-orchestration` is the shared rule:

- The named members are used, in the order named. A Debate takes the first as proposer and the last as judge, so naming the members chooses their roles.
- Fewer names than the collaboration needs are completed from the other qualified members in registry order, after the named ones, which gives a Debate its judge.
- A named member that cannot take part (not qualified, a changed generation) or more names than the collaboration takes offers nothing. The dispatcher already tells the model never to replace a named target; offering a different roster would do exactly that, and offering nothing makes the AI ask.
- A review drops the authors from the names: they cannot review their own work. A message that then names nobody gets the default reviewers, which is the case when the author is named only as the subject. A member the user addressed directly still reviews alone and overrides the names.

The AI still selects a candidate by id and the Host still re-offers before it starts, so the named roster is checked like any other. The candidate id carries the members, so a message whose names resolve differently gets a different id.

## Alternatives considered

**Let the model name the members.** The model returns an id only. Letting it return members would let it invent a roster the Host never qualified.

**Offer a candidate for every combination of members.** The number of candidates grows combinatorially and the model has to pick among near-identical choices.

**A parameter on the kind chosen in the UI.** Useful, but it needs a member picker in the composer. Names in the message work from any client and need no new UI; a picker can fill the same names later.

## Consequences

A member whose name is a common word or a short ASCII word can be named by accident in a message that happens to contain it; the effect is limited to messages where the AI selects a collaboration. Two members with the same name cannot be named at all. Names are matched against the user's text, not the member's role or avatar. The composer has no member picker for collaborations.
