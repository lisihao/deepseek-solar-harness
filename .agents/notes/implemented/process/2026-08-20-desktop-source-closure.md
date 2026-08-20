# Agent Note: Desktop packaged-source closure

Status: implemented

English | [中文](2026-08-20-desktop-source-closure.zh.md)

## Problem

The [Solar monorepo](2026-08-17-solar-monorepo-p0-p2.md) co-locates core, Desktop, and managed-plugin source, while Desktop still installs sealed package archives during its independent Yarn build. Archive hashes prove stable inputs but do not prove that a public clone contains editable source for every package bundled into the application. User-installed profile plugins and private Remote Module targets also need an explicit boundary so source-completeness claims do not copy personal runtime state into Git.

## Decision

`products/desktop/dsh-plugin-desktop/vendor/manifest.json` owns a `sourcePackages` map covering every `dsh-packages/*.tgz` archive. Each value is a repository-relative tracked `package.json` under the core workspace or `plugins/managed`. The Desktop vendor verifier requires the archive set and source-map keys to be identical, rejects paths outside the repository or absent from the Git index, extracts each archive manifest, and requires its package name and version to equal the mapped source manifest.

The default Desktop product contains source for every sealed application package and verifies this mapping before build. Sealed archives remain immutable build inputs so the independent Yarn product graph does not silently switch resolution mode. Their existing digests continue to protect the accepted bytes; the source map establishes editable source presence and identity rather than claiming byte-for-byte archive regeneration.

Optional plugins installed into `~/.dsh` remain user-owned profile extensions unless Solar modifies or bundles them. A modified or bundled plugin enters `plugins/managed` with imported provenance and native checks before it can become a product input. The public Remote Modules row is enabled with an empty `instances` array; private names, URLs, and relay ports live only in local profile settings.

## Verification

`yarn verify:vendor` verifies the complete vendor file set, immutable digests, all tracked source mappings, and the Anchored Standard delegated-worker gate. `yarn check` then builds and typechecks Desktop, runs its focused and package suites, and verifies runtime closure, CLI, loader, and profile boot. A clean clone must pass immutable root and Desktop installs before building the macOS application.

## Alternatives considered

**Remove every sealed archive and resolve Desktop directly from the root workspace.** Rejected for this step because the product intentionally has an independent Yarn graph, while the root uses pnpm. Changing package resolution and proving installable-runtime equivalence is a separate compatibility change, not required to make source review and modification possible.

**Document source locations without an executable map.** Rejected because prose can become stale while an archive is added, removed, or versioned independently.

**Import every plugin found in one user's `~/.dsh` profile.** Rejected because optional unmodified plugins are not default application build inputs, and copying a runtime profile would mix private configuration and generated state into product source.

## Consequences

A public clone can inspect and modify the source for every package sealed into the default DSH Desktop application, then build the accepted macOS product with the repository's declared package-manager boundaries. Adding or replacing a Desktop archive now requires its tracked source mapping in the same change. Personal plugin choices and Remote Module targets remain portable local configuration rather than public product defaults.
