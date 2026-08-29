# Agent Note: Product Server continuity and remote installation

Status: implemented

English | [中文](2026-08-30-product-server-continuity.zh.md)

## Problem

Desktop could choose several Product Servers only during startup. A later Leader change required an application restart, billing represented only the selected Server, and the Mac mini had no repeatable path from a fixed GitHub release to an atomically managed Product Server. The release smoke also stopped the Host while leaving its durable test daemons behind.

## Decision

The Frontend remains thin: it never boots a local Host. An Electron-owned monitor periodically qualifies the complete configured Server catalog through Remote Sync. When the schedulable Leader changes, it disposes the previous browser generation and access session, then mounts the new remote origin in the same application process. Manual deployment-role and presentation changes retain their ordered restart boundary.

The loopback billing bridge requests every configured Server ledger under an explicit per-source deadline, keeps partial failures as explicit source records, de-duplicates alternate ingress paths by ledger identity (or deployment identity when unavailable), aggregates unique Server totals, and adds the inactive MacBook baseline exactly once. `dsh-web-billing` consumes only the plain `desktopFrontend.sources` projection and has no dependency on Desktop runtime code.

The macOS Product Server installer accepts a stable `DSH-desktop-vX.Y.Z` tag and exact 40-character commit. It clones GitHub on the target Mac mini, builds and runs the release-shaped smoke there, drains the Host and both durable daemons through owner IPC, atomically switches `current`, preserves the preceding target as `rollback`, activates a LaunchAgent, and verifies HTTP, Remote Sync 1.4, resident providers, and the read/execute/interrupt/materialize/artifact capabilities. A failed activation repeats the drain before restoring and re-verifying the previous release. PID signalling is only a fenced crash fallback after executable and instance-root identity match. No MacBook artifact is copied.

## Verification

Focused Desktop tests cover Leader rebinding, multi-Server billing, the Electron redirect, and both footer control surfaces. Script tests cover fixed-release argument validation, LaunchAgent generation, required Remote Sync capabilities, and bounded daemon quiescence. Desktop type checking verifies the Electron main/runtime boundary. The release-shaped Product Server smoke remains the integration gate and now owns complete cleanup.

## Consequences

Leader changes no longer require an application restart, while the authoritative Server continues to own execution and durable state. Billing remains an estimate from each plugin ledger and exposes unavailable sources rather than silently dropping them. Mac mini deployment becomes reproducible and recoverable, but it is performed only from a published fixed release; this change does not deploy the development worktree.
