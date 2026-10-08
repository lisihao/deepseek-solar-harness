# Agent Note: Confirmed Gouzi directory adoption and direct project execution

Status: implemented

English | [中文](2026-10-06-gouzi-directory-adoption.zh.md)

## Problem

A user-selected project can contain untracked work, have no Git commit, or lack origin. Requiring a clean committed sender repository prevents a member from working in that selected directory and can substitute a cloned snapshot for the actual project. Inspection must not modify a directory merely because the user opened a picker.

## Decision

The [Host adoption executor](../../../../packages/orchestration/ui-gouzi/README.md) accepts existing directories. `resolveRepository` is read-only. Confirmed adoption inspects every selection again and checks member capacity before sequential `prepareRepository` calls, deduplicated by resolved source. Preparation initializes Git only for a directory outside a Git repository; it never stages files, commits, creates origin, or changes an existing origin. Preparation failures create no member or host pairing and consume no slot. The response identifies completed preparations; their metadata remains in place rather than deleting a possibly shared `.git` directory.

Each `GouziProjectSource` uses the selected directory's exact realpath as `source`, its SHA-256 hex digest as the opaque 64-character `projectId`, and an optional canonical origin as informative `repository` metadata. The first selected project is explicitly labelled as the default in confirmation. Provisioning persists the project map and `defaultProjectId` in the member's cluster configuration; project identity deduplication preserves the first selected source.

[Directory execution](../../../../packages/orchestration/orchestration-local/README.md) uses the versioned `gouzi-project` workspace identity with a project id and optional relative subdirectory. The receiving member resolves it only through its registered project map and runs in that selected directory. A mounted member service and a grant bound to member identity, generation, authority epoch, and request hash are required. No sender absolute path, fake repository identity, or invented commit grants access. Ordinary remote Git execution retains its clean exact-commit materialization and isolated checkout semantics.

Shared directory locks and command receipts live outside user projects. Concurrent conflicting execution and expired unresolved locks refuse reuse; settlement releases metadata without removing user files. Unknown command outcomes require reconciliation rather than automatic replay. Remote Sync execution uses protocol 1.5 and the SSH Gouzi agent uses protocol 2; incompatible remote agents fail explicitly. This source change does not deploy a remote installation.

This decision supersedes the Git/origin restriction in the [project-validation note](../bug-fix/2026-10-04-gouzi-project-validation.md), while retaining its read-only checks, stale-result fencing, and executor revalidation rationale. That older note remains a record of the earlier execution restriction.

Members with registered projects execute in the persisted default real directory; repository-only member configurations retain clean exact-commit Git materialization and the same grant checks. For directory commands, identical in-flight requests share admission. Recovery inspects the durable Native command receipt before qualification: an existing receipt restores the original turn and current revision without another execute, even when qualification is unavailable or member acceptance recording failed. `inspectWorkspace` only reads the durable lease. A lease without a Native receipt is indeterminate. A correlated `ResidentCommandRefusal` plus a successful absent-receipt read releases only that lease; unknown transport outcomes and failed inspection retain it. Query-time absence cannot exclude a prior request still being admitted. The required `command.inspect` capability keeps protocol v14/schema6 unchanged; an older daemon lacking it fails loudly rather than expanding automatic retirement.

## Alternatives considered

**Require a clean Git repository with origin.** That condition supports reproducible remote snapshots but excludes the ordinary, uncommitted, and no-origin directories the user explicitly selects for a member.

**Initialize during browsing or validation.** Inspecting a suggestion or cancelling the wizard does not confirm adoption. Delaying preparation until all paths and capacity pass prevents those reads from modifying projects.

**Clone a snapshot or fabricate a commit for directory execution.** A clone omits untracked and uncommitted work, while an invented commit misrepresents execution inputs. The explicit project identity records directory execution without changing ordinary remote Git semantics.

**Roll back earlier Git initialization after a later failure.** Preparation cannot safely infer exclusive ownership of metadata after concurrent external changes. Retaining and reporting completed preparation preserves user files and leaves the failure visible.

## Consequences

Members work in mutable selected directories, so their inputs are not immutable commit snapshots. The shared directory lock serializes conflicting commands, and the main instance remains the scheduling and grant authority. A preparation failure may leave Git metadata in an earlier selected directory, but cannot leave a created member or consume its slot. Starting a provisioned member remains a separate lifecycle step whose failure retains its provisioning state.

Focused Host tests cover ordinary and no-origin selection, read-only checks, invalid later paths, capacity refusal before preparation, preparation failure without membership, partial-preparation reporting, deduplication, and prepared provisioning inputs. Cross-provider, protocol, composition, and installed-product acceptance remain separate evidence; passing Host tests does not establish them or imply deployment.
