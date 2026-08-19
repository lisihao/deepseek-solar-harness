# Agent Note: Desktop packaged branding verification

Status: implemented

English | [中文](2026-08-19-desktop-packaged-branding-verification.zh.md)

## Problem

Source tests alone cannot prove that the installable Desktop application contains the current Solar branding implementation. A package assembled from stale or foreign build output can reintroduce the legacy sidebar rail even when the checked-out source mounts the product marker below the window content.

## Decision

The Electron Builder `afterPack` gate inspects the physical `app.asar.unpacked/lib/client.js` emitted into every Desktop application. The bundle must contain the bottom-bar installer and body reservation markers, and it must not contain the legacy sidebar-rail marker. Missing, unreadable, or forbidden bundle content fails packaging before signing.

Installed-application acceptance also inspects the Client bundle served by the running Web profile and verifies the live DOM. The accepted UI contains one body-level product marker, contains no branding entry inside the sidebar, and displays the same stable version as the source manifest and application bundle.

## Verification

Focused tests cover valid packaged content, every required bottom-bar marker, and every forbidden legacy marker. The package hook exercises the same verifier against the completed platform application before signing.

## Alternatives considered

**Rely only on source-level Client tests.** These tests cannot detect a different repository or stale output replacing the application after the source checks pass.

**Check only the application version.** Two packages can carry the same SemVer while containing different Client bundles, so version equality does not establish branding integrity.

**Inspect only the packaged file after release.** A post-release warning permits a known-invalid artifact to exist; the fail-closed package hook prevents signing it.

## Consequences

Desktop packaging now treats the bottom product marker as an artifact-level contract. Any intentional branding implementation change must update the required and forbidden bundle markers together with focused tests and live installed-application acceptance.
