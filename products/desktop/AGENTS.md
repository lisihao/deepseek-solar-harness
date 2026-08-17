# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).

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
- The root `package.json`, `dsh-plugin-desktop/package.json`, lockfile workspace
  metadata, Electron artifact metadata, and runtime-reported product version
  MUST resolve to the exact same value. A mismatch fails closed.
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
  the candidate, preserve the prior application at a timestamped backup path,
  move the verified candidate into place, and retain the backup until a later
  explicit cleanup request. Never recursively delete the prior application.
- A local development artifact may be ad-hoc signed only after packaging; a
  formal release must retain its Developer ID signature and notarization.
  Codex MUST verify the installed signature after copying.
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
- installed application path and recoverable backup path;
- test/build/package results, installed process and listener evidence, and HTTP
  probe result;
- local commit, remote branch SHA, and GitHub PR or release URL;
- any skipped step with `warn`, `error`, or `pending`, never `ok`.

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
