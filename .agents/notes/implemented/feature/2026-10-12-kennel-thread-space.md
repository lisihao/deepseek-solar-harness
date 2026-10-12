# Agent Note: The kennel's own thread space

Status: implemented

English | [中文](2026-10-12-kennel-thread-space.zh.md)

## Problem

Kennel conversations were ordinary sessions listed under their workspace, mixed with project work, and the sidebar entry reused only the latest kennel session of one workspace. A click from inside that session changed nothing, a failed or hung open left the button disabled or its error easy to miss, and a second conversation about another topic had no place.

## Decision

Every kennel conversation is a **thread**. The kennel lists its threads itself, in the room's side column, across all projects, newest first, and each shows the project it works in. The workspace browser no longer lists them: `ui-workspace` offers a generic `ctx.sessionListFilters.hide(predicate)`, registered through `ctx.effect`, that withholds matching sessions from the grouped list, the flat list, and search; the browser knows no session kind, and the kennel registers a rule for its preset.

A thread still belongs to a Workspace. The room compares a dog's registered project scopes with the conversation's directory, so "新话题" asks for a project, and the thread list shows it. Hidden threads keep their workspace membership.

A thread is created with the kennel preset in the `sessions.create` request, so the Host writes it on the session header at creation. The cold session list also reports the newest logged preset selection, taken from the `sessionListMetadata` projection (`stateVersion` 2), so a thread whose preset was selected in a second step, as every thread was before this change, is recognized after a restart as well; the first list after the upgrade refolds each cold session once.

The sidebar entry answers every path: inside a kennel thread it changes nothing and says so; elsewhere it opens the most recently updated thread of any project; with no thread it creates the first in the current conversation's workspace, then a valid recent one, then the newest. Opening is bounded (20 seconds) and reports a timeout or failure beside the button, which is enabled again.

## Alternatives considered

**Hide kennel sessions by marking them as subagent sessions or archived.** Both change what those sessions mean elsewhere. A filter owned by the browser's own extension point does not.

**One kennel conversation per project, as before.** It is what made the click ambiguous. Threads are the user's topics, not one per directory.

**Move kennel threads out of Workspaces entirely.** The room needs a directory for project scopes, and the Host accepts a session without a Workspace only as an ungrouped one the browser would list again.

## Consequences

The kennel's thread list replaces the workspace list as the way to reach kennel conversations; reaching one from the workspace browser or its search is no longer possible. Archiving a thread is registry-global like any session archive. The change reaches the Desktop only when the sealed `web-app` and `ui-gouzi` archives are rebuilt; a workspace browser without the filter service keeps listing kennel threads. This extends [workspace-scoped kennel navigation](../bug-fix/2026-10-04-kennel-workspace-navigation.md), which chose the target workspace and created through the existing workspace-scoped operation; that part is unchanged.
