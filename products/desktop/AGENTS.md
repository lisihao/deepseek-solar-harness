# DSH Desktop product rules

This directory owns the macOS-first Desktop product inside the DeepSeek-Solar-Harness monorepo.

- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- `products/desktop/` and its owned packages use the local Yarn release with `nodeLinker: node-modules`.
- The Solar Harness source is the monorepo root two levels above this directory. A nested `deepseek-harness/` checkout or submodule is forbidden.
- Run core commands through the local `solar:*` scripts. They enter the monorepo root and invoke its pinned pnpm release through Corepack.
- During P1-P2 migration, Desktop continues to resolve published DSH packages and sealed product tarballs. Source co-location alone does not change the runtime dependency boundary; source consumption requires a later qualified integration phase.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep package-input changes separate from desktop behavior changes.
- Keep the topology and package-manager split consistent with [ADR-002](../../docs/architecture/adr-002-monorepo.md) and the [Desktop boundary Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).

## Desktop release and installation

Feature and fix PRs change source only: they do not bump the product version, package the application, or touch `/Applications`. A release is a separate task that runs only when the user asks to release or install Desktop. Graphical launch and `/Applications` mutation belong only to that task; `build`, `typecheck`, `test`, and `check` stay headless-safe.

A release runs these steps in order. If code, metadata, or packaged inputs change after D05, the artifact is stale and the release returns to D03.

```text
D00 scope and current versions
  -> D01 choose the next SemVer
  -> D02 set the version
  -> D03 run the release checks
  -> D04 commit
  -> D05 build and verify that commit's artifact
  -> D06 back up and install on the MacBook
  -> D07 launch and verify version, process, and HTTP
  -> D08 push and tag
```

- **Version.** Use PATCH for compatible fixes, MINOR for compatible user-visible features, and MAJOR for incompatible product or state changes. The root `package.json`, `dsh-plugin-desktop/package.json`, lockfile workspace metadata, Electron artifact metadata, and the runtime-reported version resolve to the same value; a mismatch fails the release. The running application displays that version from the packaged product-version source, never a duplicated UI string.
- **Install.** Request an orderly quit, stage and verify the candidate, and move the prior application to `~/Library/Application Support/DSH Desktop/Backups/<timestamp>/DSH Desktop.app` before moving the candidate into place. `/Applications` contains exactly one `DSH Desktop.app`. Keep one last-known-good backup and move older backups to the Trash; never recursively delete an application bundle.
- **Signing.** Apply the repository-supported ad-hoc signature and verify it after copying. The user has opted out of the Apple Developer Program: do not configure or run Developer ID signing, notarization, stapling, or App Store Connect, and do not report their absence as pending.
- **Verify.** Launch the installed application and confirm the process, loopback listener, an HTTP 200 response, and that source, packaged, and displayed versions match. If replacement or startup fails, restore the backup when safe and report the failure.
- **Report.** State the version and SemVer reason, the three versions, the install and backup paths, check and probe results, the commit, and the PR or tag URL.
- **Mac mini.** A MacBook release never deploys to the Mac mini; the Mac mini pulls a fixed GitHub Release.
