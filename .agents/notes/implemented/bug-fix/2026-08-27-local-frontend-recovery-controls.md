# Agent Note: Local Frontend recovery controls

Status: implemented

English | [中文](2026-08-27-local-frontend-recovery-controls.zh.md)

## Problem

The Frontend deployment loaded its role controls from the remote Client bundle. When the selected Server or its tunnel was unavailable, the controls needed to leave Frontend mode could disappear with the content they were meant to recover.

## Decision

Electron owns a native Deployment menu for every macOS window generation. A Frontend generation also replaces an initially unreachable remote page with a local recovery document while continuing the existing reconnect loop. Both local surfaces invoke the same deployment adapter operations as the tray and remote Desktop footer.

The local recovery document contains no Server data, credentials, session state, or general browser bridge. Its actions navigate to the two exact deployment URLs that the Electron main process already intercepts.

## Alternatives considered

**Keep the remote footer and tray only.** Rejected because the remote footer shares the failed Server dependency, and a tray-only recovery path is not discoverable enough for the primary window.

**Start a local Host automatically after a timeout.** Rejected because Frontend mode must fail visibly instead of creating a second runtime authority without an explicit user action.

## Consequences

Users can leave an unavailable Frontend deployment from the application menu or the visible recovery page without restoring the remote Server first. Electron owns a small static recovery document and a macOS menu template in addition to the existing tray controls. Successful remote navigation replaces the recovery document; no offline write queue or local fallback Host is introduced.
