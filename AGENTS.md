# AGENTS.md — DeepSeek Solar Harness V4

> **Status: D1–D8 and Q1–Q3 confirmed; two plugins authorized for development.** On 2026-10-19 昊哥 authorized parallel development of `dsh-solar-native-collaboration` and `dsh-solar-native-resident`, including persistent TaskGraph, scheduling, native sessions/lanes, tool bridging and model allocation. RLM is explicitly excluded and will be commissioned separately. See [implementation scope and acceptance](docs/native-plugins-contract.md). Existing-app installation, paid probes, Pages, releases, merges, market publication and recurring automation remain separately authorized actions.

## Confirmed decisions (2026-10-19)

| Decision | Confirmed choice |
|---|---|
| D1 | **A:** use the official Desktop app unmodified. |
| D2 | **A:** use the GitHub repository as the market source, with a separate release tag for each plugin version. All V4 features are released as plugins. The GitHub homepage must list every published plugin; the implementing agent is responsible for refreshing the homepage guide when committing plugin-related changes. |
| D3 | **A, clarified 2026-10-19:** official upstream is read-only for reference and updates. Do not push, submit pull requests, or merge changes into `deepseek-ai/deepseek-harness`. Record missing extension points locally, then redesign or defer. |
| D4 | **Updated by 昊哥 on 2026-10-19:** install V4 plugins into the existing official Harness home, `~/.dsh`, by default. This supersedes the earlier separate, empty V4 home decision. Development and tests still use disposable homes. |
| D5 | Keep the existing public repository `lisihao/deepseek-solar-harness` and organize it for V4. Open feature PRs automatically; merge and release only when 昊哥 asks. The native-plugin change includes Ubuntu PR CI for build, unit tests, plugin tests, and the homepage check. Concrete repository-reorganization steps remain in the proposal linked below. |
| D6 | Keep `DeepSeek-Solar-Harness-V4`, package names `@lisihao/dsh-solar-<name>`, author email `haogege1977@gmail.com`, and market display name `Solar 插件市场`. |
| D7 | Initially deferred. The later explicit authorization selects native-collaboration and native-resident; do not start an unrelated demonstration plugin or port. |
| D8 | **B:** follow each new upstream rc and automate compatibility tests with failure notification. The policy is selected; the app's actual update channel and the test job still need verification and implementation respectively. |

These choices settle D1–D8 and Q1–Q3. The current external scope preserves every existing branch, pull request, tag, and Release while adding `v4` and switching the default branch to it. DSH 3.x source was archived and the 27 new remote archive identities were verified on 2026-10-19; its development is frozen. The [archive record](docs/legacy-source-archive.md) lists exact commits and verification limits. In particular, the earlier suggestions to create a separate private repository or start with a manually frozen upstream baseline are not the selected direction.

## What V4 is

- V4 is the **official DeepSeek Harness Desktop** (`/Applications/DeepSeek Harness.app`, bundle id `com.deepseek.dsh`), used unmodified, plus **the Solar plugin market**: a collection of many independent plugins, each versioned and installed on its own, listed in one Discover market index. (D1)
- Every V4 feature is a plugin and is released as a plugin. There is no "V4 core" and no single all-in-one plugin.
- Upstream baseline: `@deepseek-ai/dsh@0.2.1-rc.2` (npm dist-tag `next`; git tag `dsh-v0.2.1-rc.2`, 2026-10-17), which ships Cordis `4.0.5`. The baseline is recorded once, in `upstream.json`, and follows each new upstream rc (see [Upstream baseline](#upstream-baseline-d8)).
- Platform: macOS arm64 on this MacBook. No Windows or Linux product support.

## Repository and branches (D5)

- V4 lives in the existing public repository `lisihao/deepseek-solar-harness`, on its own branch **`v4`**, verified as the repository's default branch on 2026-10-19. The default branch's `README.md` is the GitHub homepage, and the market generator reads plugins from the default branch.
- DSH 3.x stays in the same repository on `solar` and `master`, with its existing branches, pull requests, `DSH-desktop-v*` tags, and Releases retained. Its source archive is verified and development is frozen, as recorded in [the archive index](docs/legacy-source-archive.md). V4 never merges into or from `solar` or modifies the DSH 3.x installed app. Legacy runtime records are not imported implicitly; the official Harness home is shared only by the explicit D4 decision below.
- The local V4 checkout is `~/Projects/DeepSeek-Solar-Harness-V4`, kept outside `~/Projects/DeepSeek-Solar-Harness` so that DSH 3.x agent memory and rules do not load into V4 sessions. Task worktrees branch from the V4 branch.
- The V4 branch tree holds only V4 content. Released plugin packages belong under `plugins/*`; unreleased plugin work belongs under `incubator/*`, outside the root workspace globs. The market generator reads the union of root `package.json` `workspaces` and `pnpm-workspace.yaml` `packages` (negated globs are dropped), so only `plugins/*` can contribute a bundle to the market.
- PRs open automatically when a feature is source-verified; merge and release happen only when 昊哥 asks. The native-plugin change includes Ubuntu PR CI for build, unit tests, plugin tests, and the homepage check. No recurring compatibility job is activated by that workflow.

## Hard boundaries

In this file, **upstream** means the official `deepseek-ai/deepseek-harness` repository only. V4 is a personal project in `lisihao/deepseek-solar-harness`; public visibility does not authorize contributions to official upstream. All V4 feature and baseline-update PRs described here target the personal repository. An open-source project that a plugin wraps is **the integrated project**; its rules are in [Integrating an open-source project](#integrating-an-open-source-project).

1. **Plugins only.** Every feature is a bundle package that the official plugin manager installs, enables, disables, and removes. Never patch upstream: no `pnpm patch`, `patch-package`, vendored or copied upstream source, runtime monkey-patching of upstream modules, or edits to files inside the installed app.
2. **No Desktop build.** Never fork, rebuild, re-sign, or reseal the Desktop application or its runtime. A V4 delivery never produces an `.app`.
3. **Missing seam → redesign or defer.** When a feature needs an extension point that the baseline does not offer, redesign it on existing seams, or defer it and record the missing seam in `docs/blocked-seams.md`. Keep the finding in this personal project; do not start an official-upstream contribution workflow, push to official upstream, submit an upstream PR, or merge changes into it. A missing seam is never a reason to patch upstream. (D3)
4. **Published packages only.** Build and test against the published npm packages at the baseline version. Never vendor upstream.
5. **Harness home and installation.** Authorized V4 installs use the existing official Harness home, `~/.dsh`, by default, as explicitly directed by 昊哥 on 2026-10-19. Preserve existing settings, credentials, sessions and unrelated plugins; back up affected profile configuration before installation. This replaces the old GUI-isolation prerequisite, not the requirement for installation authorization. Development and tests still use a throwaway `DSH_HOME`. Sharing the home does not authorize importing or converting legacy records. (D4)

## Plugin contract

- **Manifest.** Each plugin is one package under `plugins/<name>/`, named `@lisihao/dsh-solar-<name>`, whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, `"type": "module"`, a built `lib/` entry, `files` limited to what runs, `locale/en.json` and `locale/zh.json` with `meta.title` and `meta.description`, and an icon. Packages never use the `@deepseek-ai/` scope. (D6)
- **Shared host modules.** `@deepseek-ai/cordis` and every `@deepseek-ai/dsh-*` package a plugin imports are `peerDependencies` (and `devDependencies` for tests), never `dependencies`, so the plugin shares the host's module instances. Other libraries go in `dependencies`; prefer a maintained library over hand-rolled code.
- **Compatibility declaration.** `engines.dsh` is a bounded range covering the DSH versions the plugin passed its tests on (D8). The exact bound is fixed after the first plugin shows how the installed app reacts to an unmet range at startup.
- **Lifecycle.** Every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer. Disabling a plugin leaves the Harness working and its other plugins unaffected.
- **Configuration.** Deployment-varying choices are validated `Config` fields settable from the profile patch, not constants. Misconfiguration fails at load.
- **Data.** A plugin writes only under its own directory, `$DSH_HOME/solar/<plugin>/`. Every persisted file carries a format version; a reader refuses an unknown version with a named error instead of guessing.
- **Session events.** Avoid plugin-defined session events; prefer plugin-owned data files. Observed in rc.2 `packages/session/session-format-v1-to-v2/README.md`: an unknown v1 event refuses migration even when marked `ignorable: true`, so a plugin event can block a future upstream session-format migration. A plugin that still needs one must state why and confirm the current baseline's read and migration rules first.
- **Model-visible ⟺ logged.** Anything a plugin adds to a model request must be reconstructable from the session log.
- **UI text** shows no internal ids, no bare status words, and is inspected on the rendered app at default and narrow widths before it is reported done.

## Repository layout (target, on the V4 branch)

```
AGENTS.md                CLAUDE.md -> AGENTS.md
README.md                homepage: what V4 is, how to add the market, published plugins (generated section)
upstream.json            baseline version, git tag, commit
plugins/<name>/          one bundle package per plugin: package.json, cordis.patch.yml, src/, tests/, locale/, README.md
                         plus UPGRADING.md when the plugin wraps an open-source project
market/                  plugins.txt (market source list) and the generated index.json
tools/                   build, plugin-test, install, release, and homepage scripts
docs/integrations/<project>.md  analysis and design for each integrated open-source project
docs/development-loops.md  responsibilities, coordination, acceptance, and human decisions for the three development loops
docs/extraction-candidates.md   DSH 3.x features and their extraction status
docs/blocked-seams.md    features waiting for an extension point the baseline lacks
```

pnpm workspace, TypeScript `strict`, Vitest, Node `^22.19 || >=24`, ESM only.

## Develop → test → install

Each stage is one command (scripts are written after approval):

1. **Build**: compiles the plugin to `lib/`.
2. **Unit test**: Vitest for pure logic, only where it answers a real question.
3. **Plugin test** (required for every plugin): with a scratch `DSH_HOME`, the published baseline `dsh` CLI installs the *built* package by absolute path, boots a profile with it, and asserts the plugin's observable behavior. It runs the built `lib/` under plain Node, never `tsx`. Tests are keyless by default; a real model call needs a provider-behavior reason and 昊哥's cost approval.
4. **Install acceptance** (delivery only): with the app fully quit, install through the app's bundled `dsh plugin --profile desktop add <spec>` (or its Plugins page, or from the Solar market in Discover), relaunch, confirm the plugin is listed as enabled, and exercise the feature in the running app. Record each check as run or not run.

Local installs during development come from a stable path (the main V4 checkout or a fixed packed-tarball directory), never from a task worktree, which gets deleted. A plugin change never requires an app build; a plugin update reinstalls only that plugin.

## Release and the market (D2)

- **Unit.** The release unit is one plugin version (SemVer per plugin). There is no product-wide release and no app artifact.
- **Version.** A plugin's `package.json` version changes only in its release PR. A release PR contains the version bump, the changelog line, and the regenerated homepage section, nothing else; behavior fixes land in their own PR first.
- **Tags.** A release is the git tag `@lisihao/dsh-solar-<name>@X.Y.Z` on the merged release commit, created in the same step as the index regeneration, so no index run sees the bumped version untagged. Never create a bare `vX.Y.Z` or `X.Y.Z` tag: the market generator applies those to every package.
- **Market source.** `market/plugins.txt` lists `https://github.com/lisihao/deepseek-solar-harness`. The generated `index.json` is served from GitHub Pages; users add its URL as an index source in Discover.
- **Default-branch exposure.** The generator also lists each package's version on the default branch when no tag lists that version, and it has no exclusion for unreleased packages (checked in rc.2 `apps/plugin-market-generator/src`). Unreleased plugin work therefore stays under `incubator/<name>/`, outside the root workspace globs, until an authorized first release moves it to `plugins/<name>/`.
- **Approval.** The current repository-setting authorization is limited to switching the default branch to `v4`. Release tags, index regeneration and publication, Pages, and branch-protection changes remain separately authorized actions.
- **Unverified until the first release:** installing a plugin from a git tag that points into this monorepo's subpackage, and whether built `lib/` must be committed at the release tag.
- **Market constraints (rc.2 `apps/plugin-market-generator` README).** Index sources are npm package names or https git repository URLs; tarball URLs are rejected. The index must be served over https.

## Homepage plugin list

- The default branch's `README.md` shows every published plugin: name, one-line description, latest released version, and how to install it (add the market index in Discover, then install; or the `dsh plugin` command).
- The table sits between generated markers and is produced by a script from plugin release tags, using each published plugin's latest released version. An unreleased working-tree version must not hide an existing release or be presented as published. Hand edits inside the markers are not allowed.
- Before committing a plugin addition, change, release, or removal, the implementing agent regenerates the homepage section and the market guide and includes any resulting changes in the same commit and PR. Unchanged generated output needs no artificial edit. CI fails when the README differs from the generated output.

## Upstream baseline (D8)

- V4 follows each new upstream rc. The selected future CI job would install the newest upstream rc in a scratch home and run every plugin test; no such job is implemented or activated yet.
- Moving `upstream.json` to a new rc is its own PR: update peer and dev versions and `engines.dsh` bounds, rerun every plugin test and the install acceptance.
- The official app updates itself. Which npm dist-tag its updater follows (`next` or `alpha`) is unverified; the scheduled job must test the channel the installed app actually takes. If the Host fails to start after an update, the app's native recovery disables third-party bundles.
- Upstream published rc.1 and rc.2 on 2026-10-17 and an alpha on most days before that.

## Integrating an open-source project

Applies whenever 昊哥 names an open-source project to integrate. The result is one or more market plugins.

The [DSH Codex Subscription integration and DSH 3.x migration plan](docs/integrations/dsh-codex-subscription.md) records the installed-provider boundary and search constraints. The later [two-plugin implementation contract](docs/native-plugins-contract.md) owns current development scope and acceptance. Reuse the working third-party plugin and official providers; do not silently change their installation or authentication.

1. **Read before running.** Clone the project into its own directory outside this repository and read it. The analysis phase runs none of its install, build, or test scripts.
2. **Design document first.** Before any code, write `docs/integrations/<project>.md`: repository URL, exact version or commit, license (the market redistributes, so the license must permit it), how the project is built, which of its parts V4 uses, which DSH extension points each part maps onto (for non-JS projects, how it runs: subprocess or MCP server; check upstream `packages/mcp` first), the plugin split, the boundary, and how each non-npm dependency (pip package, binary, model file) reaches the user's machine through the normal market install and where it lives under `$DSH_HOME/solar/<plugin>/`. pnpm does not run pip and the plugin manager refuses blocked build scripts, so this path must be designed, not assumed; check the Python runtime the official app bundles before adding another (unverified until the first such integration). 昊哥 reviews the document before implementation.
3. **Plugin form only.** The integration is plugins in this repository under the plugin contract above.
4. **Clean upgrade boundary.** Consume the project unmodified as a pinned dependency (npm, pip, binary, or git commit) behind a thin adapter inside the plugin. Do not copy and modify its source. A workspace-level `pnpm patch` does not reach the app's profile, so it is not a valid fix. If a change is unavoidable, use either a pinned fork (tagged or published) that the dependency points at, or an override inside the adapter, and record it as a numbered `UPGRADING.md` entry naming the mechanism, the reason, and the integrated project's issue, if any.
5. **`UPGRADING.md` per integrating plugin.** It states where the version pin lives, which adapter files call the project's API, which project APIs and behaviors the plugin relies on, the upgrade steps, the test that proves an upgrade still works, and every carried patch.
6. **Usable, not just installed.** Done means the feature ran in the installed app through its normal user path, recorded as run. A passing scratch-profile plugin test alone is not done. While install acceptance is blocked (boundary 5), no integration may be reported usable.

## Extracting a DSH 3.x feature

One feature per PR, in this order:

1. **Upstream first.** Check whether the baseline already provides it, built in or as an official/experimental bundle (e.g. `subagent-codex`, `subagent-claude-code`, `agent-team`, `browser-use-*`, `workflow`, `goal`, `schedule`, `session-search`). If it does, use upstream and drop ours.
2. **Seams.** List the extension points the feature needs and confirm each exists in the baseline. DSH 3.x's `distribution/upstream-source-edits.json` (136 edited upstream files) shows which features depended on edits; those need a redesign or deferral recorded locally in `docs/blocked-seams.md` (boundary 3).
3. **Port, not copy.** Rewrite against the baseline APIs (DSH 3.x forked at rc.5); delete code that existed only to support upstream edits.
4. **Data.** A new plugin starts with its own empty namespace in the selected Harness home; importing DSH 3.x data is an explicit, versioned import step inside the plugin.
5. **Test, install, accept** as above. Update `docs/extraction-candidates.md`.

The two named native plugins are authorized; unrelated extraction candidates remain unscheduled. (D7)

## Workflow and gates

- Follow [Three-loop development workflow](docs/development-loops.md) for delivery, usage feedback, and maintenance/compatibility. 昊哥 selected one coordinating chat plus three separate loop chats. Each loop chat first reads this file and the workflow, confirms its role, and then waits for an assigned task.
- **Current activation boundary:** the two native plugins and their necessary build/test tooling are authorized for development. The separate loop chats remain read-and-confirm only. Do not start automated tasks or periodic monitoring; creating a loop chat does not activate its loop.
- The global acceptance rules apply at delivery: a test or probe that fails without the change, a real run in the installed app, every check marked run or not run, merge only the reviewed head, one PR one goal.
- Lessons already paid for in DSH 3.x, and the rule here that covers each:
  - Behavior fixes bundled into release PRs → a release PR holds only version, changelog, and the regenerated homepage section.
  - Docs and comments claiming unobserved behavior → READMEs state only observed behavior; unknowns say "unknown".
  - Source-mode runs passing while the shipped mode fails → plugin tests run built `lib/` under plain Node.
  - Docs left describing retired code → a code change updates its plugin README and the homepage in the same PR.
  - UI showing internal ids → the UI text rule above.
  - Repackaging the whole app for every change, including to get new model entries → plugins only, no app build.
  - Commit author not linked to the GitHub account (DSH 3.x `gmaill.com`) → commits use `haogege1977@gmail.com`; check `author.login` on the first pushed commit.
- Run only the checks that answer an open question. No coverage percentage gate, no bilingual-doc requirement, no governance profile.
- Git: one branch and worktree per task; never commit to the V4 branch directly.
- Docs are English, one README per plugin: what it does, configuration, data paths, how it was verified. The homepage may add a Chinese section.

## Confirmed repository decisions (Q1–Q3)

| # | Confirmed decision | Effect |
|---|---|---|
| Q1 | The selected V4 branch is `v4`; the authorized transition makes it the default branch. | The V4 homepage and market source are on `v4` after the transition. |
| Q2 | Archive all DSH 3.x code and then freeze it after final Git verification; retain existing pull requests. | Preserve `solar`, `master`, all existing branches, pull requests, tags, and Releases. Do not copy DSH 3.x source into V4. |
| Q3 | Keep unreleased plugins under `incubator/<name>/`. | `incubator/*` stays outside root workspace globs; only an authorized first release moves a plugin to `plugins/<name>/`. |

The limited repository transition and the preserved legacy state are recorded in [docs/repo-reorganization.md](docs/repo-reorganization.md).

## Authorized preview distribution follow-up

On 2026-10-21 昊哥 requested public package archives, copy/paste installation commands on the GitHub homepage, and usage guides for the selected installed/developed plugins. The preview catalog and installer under `distribution/plugins/` and the homepage implement that bounded request. They do not authorize market tags/Pages, npm publication, unrelated feature merges, account setup, model probes, or automatic installation of every snapshot entry. Preserve each package's exact artifact and source acceptance boundary.
