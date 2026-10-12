# Agent Note: Validate Gouzi projects before adoption

Status: implemented

English | [中文](2026-10-04-gouzi-project-validation.zh.md)

## Problem

A local workspace list and a native folder picker also expose ordinary directories. Treating those paths as executable repositories lets a user reach final adoption before Git reports an error, and a recent ordinary directory can be selected implicitly.

## Decision

The [Gouzi UI owner](../../../../packages/orchestration/ui-gouzi/README.md) checks candidate paths through the existing host repository resolver before allowing selection. The current execution protocol requires a Git repository with a valid `origin`; it does not initialize directories or add ordinary-directory execution. A failed request never implies usability. Checks that finish after the picker is replaced or unmounted cannot update its selections.

The adoption executor resolves every requested path again before pairing a host or creating a member. Explicit repository and path rejection returns `GOUZI_PROJECT_UNAVAILABLE` with the offending path and required repository condition. Unexpected process and transport failures remain request failures. No new host-service method or orchestration authority is introduced.

## Alternatives considered

**Initialize every chosen directory.** This modifies user projects and invents a repository origin without establishing the execution identity required by the current protocol.

**Trust picker validation at adoption.** Project contents and remotes can change after the check, and direct HTTP callers can bypass the picker.

## Consequences

Users receive project-specific reasons before confirmation; default selection only uses checked usable candidates. Ordinary directories remain unsupported. Repository availability at adoption does not guarantee a later task can reproduce dirty or uncommitted inputs. Owning Host and browser tests cover refusals, no creation effects, pending checks and stale results; the assembled product composition remains a separate acceptance obligation.
