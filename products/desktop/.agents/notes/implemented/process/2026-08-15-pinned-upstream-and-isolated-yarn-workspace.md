# Agent Note: Solar monorepo and isolated Desktop Yarn workspace

Status: implemented

English | [中文](2026-08-15-pinned-upstream-and-isolated-yarn-workspace.zh.md)

## Problem

DSH Desktop originally carried an official DeepSeek Harness checkout as a nested Git submodule. That topology preserved source provenance, but it split the Solar product across repositories and made coordinated Desktop, core, and managed-plugin development harder. The migration must unify source ownership without coupling the Desktop Yarn dependency graph to the core pnpm workspace or silently changing the packaged runtime inputs.

## Decision

[`products/desktop/`](../../../../) is now the Desktop product directory in the DeepSeek-Solar-Harness monorepo. The Solar Harness source is the [monorepo root](../../../../../..); a nested `deepseek-harness/` checkout and Desktop-local `.gitmodules` file are forbidden. [ADR-002](../../../../../../docs/architecture/adr-002-monorepo.md) owns the repository topology.

Desktop remains a Yarn 4 workspace using the `node_modules` linker, and its only workspace member is [`dsh-plugin-desktop/`](../../../../dsh-plugin-desktop/). The Solar root retains its pinned pnpm release and workspace. Local `solar:*` scripts cross that boundary explicitly by entering the monorepo root before invoking Corepack.

P1-P2 source co-location does not by itself change product dependency resolution. Normal Desktop builds continue to use the published DSH `0.1.0-rc.6` family recorded in [`upstream.json`](../../../../upstream.json), while sealed product extensions continue to use hash-checked tarballs under `dsh-plugin-desktop/vendor/dsh-packages/`. A later qualified integration phase must change package inputs explicitly and prove runtime compatibility before Desktop consumes same-repository sources.

`yarn check:layout` rejects a nested Harness checkout, a changed package-manager boundary, an expanded Desktop workspace, an invalid Solar root, a changed runtime family, or an unsealed extension reference. The check also binds this decision record to its bilingual hash record.

## Verification

The migration validates the Desktop boundary with `corepack yarn install --immutable`, `corepack yarn check:layout`, and the headless `corepack yarn check` suite from `products/desktop/`. Core and governance validation run independently at the monorepo root. No migration-only verification launches Electron or mutates `/Applications/DSH Desktop.app`.

## Alternatives considered

**Keep the nested submodule.** Rejected because it preserves the repository split that the Solar monorepo is intended to remove and duplicates the core source location.

**Add the Solar root packages to the Desktop Yarn workspace immediately.** Rejected because co-location is not evidence that the pnpm and Yarn graphs can be merged safely, and it would change packaged runtime inputs during a structural migration.

**Copy the core into the Desktop directory.** Rejected because it creates two editable authorities for the same source and obscures which copy owns releases and governance.

**Delete published and sealed package inputs as part of P1.** Rejected because that combines topology migration with runtime integration and makes failures impossible to attribute cleanly.

## Consequences

Core, Desktop, and managed plugin sources can evolve in one Solar repository while retaining explicit product boundaries. Contributors use pnpm at the monorepo root and Yarn in `products/desktop/`. The existing packaged dependency family remains unchanged during P1-P2, so a later source-integration phase still has to qualify and record any dependency-boundary change.
