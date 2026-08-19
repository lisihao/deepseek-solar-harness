# Agent Note: Desktop bottom product marker

Status: implemented

English | [中文](2026-08-19-desktop-bottom-product-marker.zh.md)

## Problem

The persistent DSH product identity and running version occupied an additive sidebar action. The expanded sidebar spent two rows on static text, while the collapsed rail reduced the identity to a version fragment. Product identity must remain available without consuming navigation space or duplicating the packaged version in presentation code.

## Decision

The Desktop Client mounts one non-interactive marker directly under `document.body` in compatibility and advanced modes. The marker renders `solarBrandLabel(productVersion)` as one line, where `productVersion` is the stable version validated from the Electron-owned page marker. No sidebar slot carries product branding.

The marker owns a 24-pixel strip at the bottom of the window. A body data attribute reserves that space so the fixed marker does not cover the application root; overflow is ellipsized on narrow windows. The Cordis effect removes the element and reservation attribute together when the Client generation disposes.

## Verification

Client tests verify the complete versioned label, body-level mount, absence of a branding slot registration, and effect disposal. Style tests verify reserved body space, fixed bottom placement, one-line overflow behavior, and the existing theme underlay. Desktop package checks and installed-application acceptance verify the packaged version and rendered marker together.

## Alternatives considered

**Keep the marker in `sidebar.footer.action`.** This retains the navigation-space cost and still hides most of the identity when the rail is collapsed.

**Overlay the marker without reserving space.** This covers the lowest application controls and makes third-party bottom-aligned UI unreliable.

**Put the complete string in the native title bar.** Compatibility and advanced windows use different native chrome, and macOS hidden-inset presentation does not provide a stable full-width title surface.

## Consequences

The sidebar contains only actionable Desktop entries, while product identity and the actual running package version remain visible across presentation modes. Every window gives 24 pixels of vertical space to the marker, and narrow windows may show an ellipsis while preserving the complete accessible label and tooltip.
