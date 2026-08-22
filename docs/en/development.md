# Development and Verification

[简体中文](../zh-CN/development.md) | **English** | [Documentation Center](./README.md)

## Environment

The published plugin retains its Node.js 20 engine floor for older compatible DSH hosts. This source checkout's DSH 0.1.1-rc.2 verification toolchain requires Node.js `^22.19.0 || >=24.0.0`: rc.2 imports the Node Zstd API and uses `Promise.withResolvers`, so Node 20 cannot load a complete rc.2 profile. CI runs the full Linux chain on Node.js 22.19 and 24, plus the Windows chain on Node.js 24, all with pnpm 10.13.1. Verify DSH and Mnemon compatibility through the full validation chain whenever dependencies are upgraded.

Install dependencies:

```sh
pnpm install
```

## Standard Commands

```sh
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest run
pnpm run build      # declarations + host/client bundles
pnpm run verify     # typecheck + tests + reproducible build + package validation
```

## Directory Structure

```text
src/
+-- index.ts                  # Host composition root
+-- config.ts                 # settings schema
+-- process.ts / runner.ts    # local CLI execution
+-- service.ts                # durable-memory facade
+-- memory-bodies.ts          # Memory Space registry
+-- runtime-memory.ts         # hot-memory authority
+-- documents.ts              # managed Documents
+-- subagent.ts               # bounded workers
+-- lifecycle.ts              # root-Agent hooks
+-- review-activity.ts        # activity score
+-- tools.ts / commands.ts    # model and human interfaces
+-- rpc.ts / settings.ts      # Web bridges
+-- storage-scope.ts          # storage inventory
+-- shared/contracts.ts       # canonical Host/Client wire contracts
+-- client/                   # React workspace and locales
tests/                        # Vitest suites
scripts/                      # deterministic build and package checks
lib/                          # generated, ignored publish artifacts
docs/zh-CN/                   # Chinese documentation
docs/en/                      # English mirror
cordis.patch.yml              # DSH profile bundle patch
```

## Build Artifacts

```text
tsdown (directly from src/)
  -> lib/index.js             Node ES2024 ESM
  -> lib/client.js            DSH browser module wrapper

tsc -p tsconfig.types.json
  -> lib/types/**/*.d.ts      declarations only

lightningcss plugin
  -> CSS Modules compiled and injected as scoped <style>
```

The Host keeps all package dependencies external. The client keeps React, ReactDOM, the JSX runtime, Cordis, and DSH UI primitives external; only `markdown-to-jsx` is allowed to be bundled from `node_modules`.

`lib/` is a publishing input but is ignored by Git. Never edit it manually. `pnpm run verify:build` builds twice and compares every output hash, so unstable CSS export ordering or other generated churn fails verification.

`src/shared/contracts.ts` is the canonical boundary for configuration shapes, RPC channels, settings protocol, and Client-visible DTOs. Files under `src/client/` may import parent modules only through that contract. Host modules may re-export shared types for compatibility, but must not redefine wire DTOs.

## Test Layers

The existing Vitest suites cover:

- configuration parsing, CLI discovery, and process serialization;
- Memory Space discovery, activation, routing, and merge;
- recall-payload compatibility and graph parsing;
- Runtime JSON/Markdown consistency, locks, capacity, UTF-8, and revisions;
- Document paths, frontmatter, search, LRU, archiving, and conflicts;
- worker tool isolation, the schema subset, and structured receipts;
- lifecycle cues, scoring, idle debounce, cancellation, and watermark retention;
- RPC authority, read-only behavior, and settings revisions;
- the Web workspace, bilingual copy, and key interactions;
- core activation without Web-only services and Agent-cwd routing for Headless;
- Client/Host source boundaries, deterministic build hashes, package contents, exports, and TypeScript resolution.

These are primarily integration tests using temporary directories, fake runners, and a mock Host. In addition, `verify:headless` builds the package, installs it into an isolated real DSH Headless profile, serves a local mock model, and asserts that representative Mnemon tools reach the model request. Automated end-to-end testing of the real DSH + Mnemon WebUI remains separate.

## Real WebUI Verification

Use an isolated environment before release to avoid contaminating personal memory:

```text
temporary DSH_HOME
temporary MNEMON_DATA_DIR or custom storageScope
temporary workspace
independent Web port
local link installation
```

Recommended scenarios:

1. Empty root: the UI reports no errors and can create the first Memory Space.
2. Regular conversation: only a short cue appears; recall and writes are not forced.
3. Historical question: the Agent independently recalls and returns the correct space provenance.
4. Explicit distillation: the worker deduplicates, selects a scope, and writes content that can be recalled again.
5. Multiple spaces: reads cover only active spaces; writing to an inactive space activates it automatically afterward.
6. Runtime: USER / MEMORY add, replace, remove, and projection consistency.
7. Documents: create, retrieve, update, manually archive, and leave original project files unchanged.
8. Score-based review: light tasks do not trigger it; after reaching the threshold it waits for idle; a new turn can cancel it while preserving the watermark.
9. Read-only: write tools, write commands, and write RPC are rejected while reads remain available.
10. Sidebar: all four primary tabs, four Memory Space secondary tabs, stable headings, filters, and progressive loading work.
11. Conversation UI: Turn memory appears only for completed turns with activity; links land correctly; canceling Save to memory performs no write.
12. Settings: Sidebar / Buildin, storage scopes, and both conversation switches apply live without refresh.
13. ZIP: export can be previewed and merged into an isolated custom root; damaged checksums are rejected.
14. Versions: checking never installs; link/manual sources offer no unsafe update; successful updates trigger a fresh status check.
15. Status and browser console: no unhandled errors or warnings.

Capacity limits, CLI timeouts, revision conflicts, and Host restarts should be verified in a dedicated fault-injection environment.

## Maintaining Documentation Visuals

Public UI screenshots live under `docs/assets/screenshots/`, shared by both language editions. Language-specific architecture diagrams live under `docs/assets/diagrams/zh-CN/` and `docs/assets/diagrams/en/`. When layout, primary copy, or defaults change:

1. Use a real DSH Web profile, but first check that the frame contains no token, credential, or private personal data.
2. Use 1600×900 standard widescreen for primary screenshots and video; narrow viewports are no longer release hero assets.
3. Record complete downward and upward page scrolling, plus filter, repeated-click, toggle, expand, dialog, and exact-navigation button states.
4. Stop writes, component updates, and settings changes before final confirmation. A read-only Agent Query over public test data may run for real, including its wait and result states.
5. Replace screenshots with the same responsibility instead of accumulating versioned filenames. Add an asset only for a new user task.
6. Refresh the README poster, GIF / MP4 demo, and both `ui-guide.md` files.
7. Confirm PNG / JPEG extensions match actual encoding and that text is readable at original resolution.
8. Remove unreferenced assets, stale Buildin layouts, and obsolete terminology.
9. Run link/image checks, then open both READMEs and UI guides manually.

README demo assets are `docs/assets/media/dsh-mnemon-memory-system-demo.*`. The demo should cover Status, Runtime, Documents, Memory Spaces, Provider and dialog interactions with full vertical scrolling and key button-state changes. Automation must not submit memory, update components, or save settings, but it may complete a safe read-only Agent Query.

## Modifying Subagent Schemas

Mnemon's one-run result tools use the compact JSON Schema subset accepted by DSH tool parameters:

```text
type, oneOf, properties, required, additionalProperties,
items, enum, const, and annotation keywords
```

Do not add unsupported keywords such as `maxItems`. `assertDshOutputSchema()` recursively rejects unknown schema keys before registering the result tool; result-count and similar limits are enforced by both the persona and the Host parser.

## Modifying Storage Formats

Runtime, Documents, and the Memory Space registry each have a version field or fixed structure. Changes require:

1. Define how the old format is parsed;
2. add a migration or rejection path;
3. preserve temporary-file and atomic-rename behavior;
4. add tests for concurrency and damaged inputs;
5. update the Chinese and English storage, operations, and Roadmap documents;
6. verify upgrade and rollback against a copied data root.

There is currently no formal schema-migration framework, so persistent formats must not change silently.

## Maintaining Documentation Internationalization

`docs/zh-CN` and `docs/en` should contain matching filenames with the same section responsibilities. When changing defaults, workflows, or limitations:

- update both languages;
- keep commands, configuration keys, paths, and code symbols exactly the same;
- cross-link corresponding language pages with relative paths;
- prefer accessible SVGs with no scripts or external resources for architecture overviews; keep directory trees, commands, formulas, and short protocols as copyable `text` / ASCII;
- keep only summaries in the root READMEs and place details on one authoritative docs page;
- for every user-visible interface change, also inspect `ui-guide.md`, `getting-started.md`, `configuration.md`, and `operations.md`.

When the Web locale changes, the Chinese key set remains the type source of truth. The English dictionary must satisfy `Record<MnemonKey, string>` and preserve the same placeholders.

## Release Checklist

```text
[ ] pnpm run verify
[ ] confirm the worktree contains no generated lib changes
[ ] confirm package validation reports only runtime files, declarations, root documents, and cordis.patch.yml
[ ] install the built/local bundle into an isolated Web profile
[ ] confirm `verify:headless` activates the built bundle in an isolated Headless profile
[ ] run real Mnemon CLI and WebUI smoke tests
[ ] verify Chinese and English workspaces
[ ] verify global/workspace/custom paths as applicable
[ ] record tested DSH and Mnemon versions
[ ] back up any data root used for upgrade testing
```

`package.json.files` publishes `lib`, the patch, both root READMEs, `SECURITY.md`, and the License. The documentation site and media stay in GitHub and are intentionally excluded from npm.

## Publishing to npm

After publication, `dsh plugin --profile web add dsh-mnemon` resolves by registry name — the same path as dsh-better-sidebar. Steps:

```sh
pnpm run verify
npm pack --ignore-scripts
npm publish dsh-mnemon-<version>.tgz --access public --ignore-scripts
```

Publishing the already-packed tarball ensures npm receives the same artifact that was inspected. The GitHub release workflow follows this sequence after checking that the tag matches `package.json`.

Credential convention: write NPM_TOKEN only to the user-level `~/.npmrc` (`npm config set "//registry.npmjs.org/:_authToken" "${NPM_TOKEN}" --userconfig ~/.npmrc`) and remove it after publishing. Do **not** commit the credential line to the repository `.npmrc`: pnpm 11 deliberately ignores unexpanded environment-variable credentials in project-level `.npmrc` (with a warning), and that file travels with the repo.

2FA note: when the npm account has publish-level two-factor authentication, an interactive `pnpm publish --access public` prompts for the OTP; scripted/CI publishing needs a Classic **Automation** token or a Granular token allowed to bypass 2FA (a plain token from `npm login` cannot publish and fails with 403 Two-factor authentication required).

Before publishing, check that `package.json` `repository`/`homepage`/`bugs` point at `omdsh-dev/dsh-mnemon` (npm page consistent with GitHub) and that the version has been bumped.
