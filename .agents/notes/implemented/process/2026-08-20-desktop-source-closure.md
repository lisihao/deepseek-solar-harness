# Agent Note: Desktop packaged-source closure

Status: implemented

English | [中文](2026-08-20-desktop-source-closure.zh.md)

## Problem

The [Solar monorepo](2026-08-17-solar-monorepo-p0-p2.md) co-locates core, Desktop, and managed-plugin source, while Desktop still installs sealed package archives during its independent Yarn build. Archive hashes prove stable inputs but do not prove that a public clone contains editable source for every package bundled into the application. User-installed profile plugins and private Remote Module targets also need an explicit boundary so source-completeness claims do not copy personal runtime state into Git.

## Decision

`products/desktop/dsh-plugin-desktop/vendor/manifest.json` owns a `sourcePackages` map covering every `dsh-packages/*.tgz` archive. Each value is a repository-relative tracked `package.json` under the core workspace or `plugins/managed`. The Desktop vendor verifier requires the archive set and source-map keys to be identical, rejects paths outside the repository or absent from the Git index, extracts each archive manifest, and requires its package name and version to equal the mapped source manifest. It also compares every archived non-generated file with the corresponding tracked source, using the repository license only for package-manager-injected `LICENSE` files.

The Remote Modules archive is rebuilt from the generic tracked package so deployment-specific historical examples are absent from the accepted product input. A content change updates both the immutable digest manifest and the Desktop lockfile locator.

The shared client-bundle build identifies CSS Modules by repository-relative path. Its virtual module ID and Lightning CSS filename never include the physical worktree root, so class hashes and generated bundle comments remain stable when the same commit is built from different `/Users/.../Projects` worktrees.

The default Desktop product contains source for every sealed application package and verifies this mapping before build. Sealed archives remain immutable build inputs so the independent Yarn product graph does not silently switch resolution mode. Their digests protect the accepted bytes, while the Desktop verifier proves exact tracked provenance for prose, configuration, scripts, and other non-generated package contents. After the root workspace build, the root artifact gate compares every generated `lib/` member of each sealed core archive with its mapped package build. The Desktop verifier separately compares every installed package member with its archive member, so refreshing a tarball without refreshing the Yarn file locator and installed dependency also fails before packaging.

Optional plugins installed into `~/.dsh` remain user-owned profile extensions unless Solar modifies or bundles them. A modified or bundled plugin enters `plugins/managed` with imported provenance and native checks before it can become a product input. The public Remote Modules row is enabled with an empty `instances` array; private names, URLs, and relay ports live only in local profile settings.

## Verification

`yarn verify:vendor` verifies the complete vendor file set, immutable digests, all tracked source mappings, exact non-generated archive contents, exact archive-to-installed-package contents, and the Anchored Standard delegated-worker gate. `pnpm verify-desktop-vendor-build` runs after `pnpm build` in the root artifact aggregates and rejects missing or stale archived generated files in root-workspace tarballs. The client CSS test compiles the same stylesheet from two physical roots and requires identical virtual IDs and output. Managed-plugin archives retain their component-native build and provenance checks rather than being claimed by the root pnpm build. `yarn check` then builds and typechecks Desktop, runs its focused and package suites, and verifies runtime closure, CLI, loader, and profile boot.

## Alternatives considered

**Remove every sealed archive and resolve Desktop directly from the root workspace.** Rejected for this step because the product intentionally has an independent Yarn graph, while the root uses pnpm. Changing package resolution and proving installable-runtime equivalence is a separate compatibility change, not required to make source review and modification possible.

**Document source locations without an executable map.** Rejected because prose can become stale while an archive is added, removed, or versioned independently.

**Record only a source-tree digest beside each archive.** Rejected because changing the recorded digest can make metadata current without proving that the generated archive bytes came from the current build.

**Import every plugin found in one user's `~/.dsh` profile.** Rejected because optional unmodified plugins are not default application build inputs, and copying a runtime profile would mix private configuration and generated state into product source.

## Consequences

A public clone can inspect and modify the source for every package sealed into the default DSH Desktop application, then build the accepted macOS product with the repository's declared package-manager boundaries. Adding or replacing a Desktop archive requires its tracked source mapping in the same change, and changing a root package cannot leave its sealed generated code stale while the artifact lane passes. Managed-plugin generated bytes remain the responsibility of their native component qualification. Personal plugin choices and Remote Module targets remain portable local configuration rather than public product defaults.
