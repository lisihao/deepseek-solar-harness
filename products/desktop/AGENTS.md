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

## Mandatory Codex Desktop delivery protocol

These are completion rules for Codex. They apply whenever a task changes the
user-visible Desktop application, its packaged runtime, or its installable
artifact. A documentation-only, test-only, or analysis-only task may skip the
version/build/install cycle, but Codex must state that scope explicitly in its
final report.

### 1. Assign one release version

- Codex MUST assign the delivery a new canonical stable Semantic Version before
  the final package is built. Reusing the currently installed version is not a
  completed Desktop delivery.
- Use PATCH for compatible fixes, MINOR for compatible user-visible features,
  and MAJOR for incompatible product or state-contract changes. Record the
  reason for the selected increment.
- The Desktop workspace root `package.json` at `products/desktop/package.json`
  and `dsh-plugin-desktop/package.json` MUST declare the exact same version.
  The product manifest, Electron artifact metadata, and runtime-reported product
  version MUST resolve to that value. Yarn may record local workspaces as
  `0.0.0-use.local`; lockfile acceptance is dependency-closure consistency, not
  a duplicated Desktop SemVer string. A mismatch fails closed.
- The assigned version MUST be committed with the implementation. Codex must
  not invent a display-only version, append an untracked suffix, or change the
  version after the accepted artifact has been built.

### 2. Show and verify the running version

- The application MUST display its product version after startup in an
  always-available Desktop-owned surface, such as the persistent sidebar
  product marker plus the native tray menu. The value must come from the same
  packaged product-version source; a manually duplicated UI string is
  forbidden.
- Codex MUST launch the newly installed application and compare all three
  values: assigned source version, packaged artifact version, and version shown
  by the running application. The delivery is `error` if any value differs or
  the running value cannot be inspected.
- Merely reading source files, running `--version` against the source checkout,
  or observing that an Electron process exists is not startup-version evidence.
  Acceptance must inspect the application under `/Applications/DSH Desktop.app`.

### 3. Automatically install the accepted MacBook build

- After required checks pass and the final macOS application is built, Codex
  MUST automatically install that exact artifact to
  `/Applications/DSH Desktop.app` on this MacBook. It must not stop at a `dist/`
  directory or ask the user to copy the application manually.
- Installation MUST be recoverable: request an orderly quit, stage and verify
  the candidate, and preserve the prior application outside `/Applications` at
  `/Users/sihaoli/Library/Application Support/DSH Desktop/Backups/<timestamp>/DSH Desktop.app`
  before moving the verified candidate into place. `/Applications` MUST contain
  exactly one DSH application, `/Applications/DSH Desktop.app`; never leave
  `DSH Desktop.app.backup*`, `DSH Desktop.app.failed*`, or similarly named app
  bundles beside it because Finder presents every bundle as an installed app.
- Retain at most one last-known-good backup in the external backup root. After
  the new installation passes D07, move every older backup and failed candidate
  to the macOS Trash so cleanup remains recoverable. Never recursively delete
  the prior application, and never accumulate one backup per delivery.
- Package the macOS artifact first, then apply the repository-supported ad-hoc
  signature and verify that installed signature after copying. The user has
  permanently opted out of the paid Apple Developer Program: unless the user
  explicitly reverses that decision, Codex MUST NOT request, test, configure,
  or execute Developer ID signing, Apple notarization, stapling, App Store
  Connect, or related certificate/profile workflows. Their absence is not a
  `pending`, `warn`, `error`, or incomplete release item; GitHub distribution
  may use the accepted ad-hoc-signed artifact.
- Codex MUST relaunch the installed application and verify the real process,
  loopback listener, an HTTP 200 application response, and the displayed
  version. If replacement or startup verification fails, restore the backup
  when safe and report `error`; do not label the task complete.
- This rule installs only on the current MacBook. It does not authorize Mac mini
  deployment. A later Mac mini deployment must remotely pull a fixed GitHub
  Release rather than receive a local build from the MacBook.

### 4. Required completion evidence

Every applicable Codex final report MUST include:

- assigned version and SemVer increment reason;
- source version, packaged version, and running installed version;
- installed application path and recoverable backup path (or `N/A` for a clean
  install), plus evidence that `/Applications` contains no DSH backup/failed
  app bundles and the external backup root contains at most one rollback copy;
- test/build/package results, installed process and listener evidence, and HTTP
  probe result;
- local commit, remote branch SHA, and GitHub PR or release URL;
- any skipped step with `warn`, `error`, or `pending`, never `ok`.

Apple Developer ID signing and notarization are intentionally outside this
product's delivery scope and MUST be omitted from completion tables rather than
reported as skipped or pending. This standing exclusion changes only when the
user explicitly requests it in a future task.

Codex MUST plan and execute applicable Desktop delivery work in this order:

```text
D00 scope/current versions
  -> D01 choose next SemVer
  -> D02 implement code + visible version
  -> D03 run source gates
  -> D04 commit the identified source
  -> D05 build and verify that commit's artifact
  -> D06 back up and install on the MacBook
  -> D07 launch and verify version/process/HTTP
  -> D08 push, compare remote SHA, and report evidence
```

If code, metadata, or packaged inputs change after D05, the artifact is stale:
Codex must return to D03 and repeat every downstream node. Dispatching work,
creating an artifact, or pushing a branch is not a substitute for D07 acceptance.

`build`, `typecheck`, `test`, and `check` remain headless-safe. Graphical launch
and `/Applications` mutation belong only to the final Desktop delivery step.
Codex may skip automatic installation only when the user explicitly says not to
install, the task is non-app scope as defined above, the host is not macOS, or a
concrete permission/signing failure blocks the operation. In every such case the
final status remains explicit and the exception must be named.
