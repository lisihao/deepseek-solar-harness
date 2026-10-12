# Agent Note: Workspace-scoped kennel navigation

Status: implemented

English | [中文](2026-10-04-kennel-workspace-navigation.zh.md)

## Problem

The kennel is a separate chat using the selected workspace. Searching all sessions for a kennel can instead open one from another workspace. Creating a session through a void start operation and then watching the global current session loses the identity of the requested result: another navigation can satisfy the blank-session watcher, while a start without an explicit workspace can leave the user selecting a workspace again.

## Decision

The [kennel navigation owner](../../../../packages/orchestration/ui-gouzi/README.md) resolves the target from the current session's workspace membership, falling back to a valid recent workspace and then the newest known workspace only when none is selected. Reuse is restricted to that workspace's latest unarchived kennel session. Histories in other workspaces remain separate.

The outward browser `ISessions` interface explicitly declares workspace-scoped `create({ workspaceId, agentPreset? })`, backed by the existing implementation and writer. Creation awaits [`SessionRuntime.create`](../../../../packages/client/runtime/src/client/sessions/service.ts) operation with an explicit workspace id; its returned id identifies the newly created session, and its list entry and workspace binding are available when the operation resolves. The kennel sends the preset in that creation request, so the Host records it on the session header at creation (a later selection is only a log event, which the cold session list does not read), and opens the returned session. This uses the runtime's existing session-creation guarantee rather than inferring identity from a global current-session transition. The original chat stays selected until creation succeeds; a missing target, or a creation the Host refuses (a rejected preset included), is reported without clearing that selection.

## Alternatives considered

**Reuse the latest kennel across all workspaces.** This can silently replace the selected workspace with another workspace's kennel and mix navigation histories. Reuse follows workspace membership instead.

**Start a session without awaiting its identity, then observe any current blank session.** A global watcher can bind the preset to an unrelated navigation result and can time out after creation without proving which session it awaited. The existing typed creation result gives the exact session identity through that explicit declaration of the existing operation; `connectWorkspace` can reuse an originating or unrelated ordinary blank session instead of creating the independent chat.

**Clear the original chat before creating the kennel or selecting the preset.** Failure would leave the user without the original selection and can require another workspace choice. Opening only after the Host has created the session preserves the current chat on failure.

## Consequences

A kennel click retains the selected workspace without asking the user to select it again. Each workspace keeps its own kennel conversation, while the kennel remains an ordinary session composed from the existing preset. This changes browser navigation and explicitly declares the existing workspace-scoped create operation on `ISessions`; it changes neither the creation implementation nor its writer and introduces no second Scheduler.

The typed creation result establishes session identity, not task execution or acceptance. This decision does not demonstrate installed UI behavior, actual GUI acceptance, or a remote native worker reading repository contents.

Reusing one kennel session per workspace has since been replaced by the cross-project [thread space](../feature/2026-10-12-kennel-thread-space.md); choosing the target workspace and creating through the workspace-scoped operation are unchanged.
