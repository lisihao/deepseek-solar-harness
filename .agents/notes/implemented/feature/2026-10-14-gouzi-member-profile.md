# Agent Note: Role goal and the user's notes in every member task

Status: implemented

English | [中文](2026-10-14-gouzi-member-profile.zh.md)

## Problem

A kennel member received only its name. The role the user picked when adopting (research, development, testing, and so on) changed nothing a member did, because the one-line goal of each role template existed only in the browser, and there was no place to tell one dog how it should work. The user wanted each dog to carry a personality and standing preferences, as the bots of other products do.

## Decision

A [member](../../../../packages/orchestration/orchestration/src/gouzi.ts) carries optional `profile`: notes the user wrote, 1 to 2000 characters without control characters. `adopt` and `edit` accept it (`edit` clears it with `null` or blank text), and the wizard's role step and the edit form show a text box.

Every task a kennel member receives opens with `kennelMemberBrief`: who the member is, the one-line goal of its role template (`GOUZI_ROLE_GOALS`, which the browser's table is pinned to by a Host test; a `custom` role states none), and the notes, quoted as style and preference that do not change the scope or limits of the task. It applies to chat, read, write, [review, and rework](../../../../packages/orchestration/kennel-review/README.md) tasks and to Debate, where the lines become further instructions of the member's role persona, so a notes field never reaches only some kinds of task. The text is built on the main instance, so a remote member needs no upgrade.

Tasks must be reproducible from the Session log. The [dispatcher](../../../../packages/orchestration/ui-gouzi/README.md) snapshots the notes of every offered member into the `kennel/dispatch-request` event as `profiles` (absent when no member has notes), and refuses to start when the selected member's notes changed or were cleared after the decision, as it already does for a changed model. A collaboration candidate id names members, entries, and models but not notes, so the dispatcher compares every member's notes of the candidate it logged with the notes the kind offers again, before and after logging, and refuses the start on any difference. A collaboration candidate carries its members' notes in the logged `members`, and a rework takes them from the logged candidate. The notes stay out of what the scheduling model sees, including the members of a collaboration candidate, because they would fill the input once per candidate and are not part of choosing a member.

Storage is a nullable `gouzi_members.profile` column added by state schema 7. Before the first migration to schema 7 the store writes one `VACUUM INTO` snapshot of the state to `state.sqlite.before-schema-7` and never overwrites it. An earlier version checkpointed the write-ahead log and copied the file, which lost commits still in the log whenever another connection held an older read; the snapshot is written beside the final name, checked for integrity and schema version, and renamed into place, and a copy that cannot be made stops the start before the migration.

## Alternatives considered

**Notes inside each work offer.** The offers are one per member, project, and mode, so the logged event would repeat a 2000-character text dozens of times and the scheduling input would overflow. One map per request avoids both.

**Send the notes through the grant or the member protocol.** It would bind the feature to the member's version, and a member on an older build (such as the Mac mini on 3.36.0) could not use it. The task text is already the Host's to write.

**Keep the column out of the schema version.** The [member model note](2026-10-08-gouzi-member-model.md) already settled this: an older program would write members without the setting, so released state needs an explicit versioned failure.

**Memory the dog learns from its own work.** A member's replies are not written into the Session log, so there is nothing to learn from, and a memory that cannot be reconstructed from the log would break the rule that model-visible input is logged. This note covers what the user writes only.

## Consequences

Existing members now receive their name and role goal in every task, which changes the text they work from; a member without notes gets no notes line. The schema 7 migration is one-way, like schemas 5 and 6: the kept 3.42.2 backup of the app cannot open the migrated kennel database, and the copy `state.sqlite.before-schema-7` is what a manual rollback restores. The cluster replica carries the state schema version and a node refuses a replica from another one, so schema 7 nodes and older nodes cannot replicate with each other until both are upgraded; the Gouzi tables are not in the replica. The role goal in a task is fixed Chinese text, so changing a template needs a matching change in both tables.

The notes are the user's own text sent to the member's model; the member's runtime applies the same authority and limits as before, and the notes cannot widen them. Installed-product behavior with a real member, and the Desktop `gouzi-e2e`, are exercised with the release, not by this note.
