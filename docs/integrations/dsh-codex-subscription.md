# DSH Codex Subscription: V4 integration and DSH 3.x migration

Status: design for review, 2026-10-19. 昊哥 reports that the official Codex subagent, official Claude Code subagent, and `dsh-codex-subscription` are already installed and working. The current request authorizes this document and related documentation updates only. It does not authorize installation, configuration changes, implementation, paid probes, GitHub changes, or publication.

The migration deliverable is **one independently installable Solar plugin**, provisionally named `@lisihao/dsh-solar-native-collaboration`. It will own the bounded collaboration behavior migrated from DSH 3.x and use the existing providers. It is not an app build, a replacement DSH core, or a copy of the full 3.x execution system. Other unrelated legacy features remain separate candidates.

## Starting point and evidence

| Item | Evidence and limit |
|---|---|
| Existing installation | User-confirmed working on 2026-10-19. Preserve that installation; do not reinstall or disable it as part of this design. The user did not provide an exact installed subscription-plugin version or a feature-by-feature acceptance record. |
| Official Harness baseline | `@deepseek-ai/dsh@0.2.1-rc.2`, tag `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`. The preceding inspection read the official app's matching version metadata. |
| Integrated project | [WSL043/dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription), reviewed release `v3.1.1`, commit `f9ecdd4dbe56b45e85ed8c2eadf79d98be5942d9`. This is the source-analysis pin, not a claim about the installed version. |
| Reference source | Release `v3.1.1` was cloned into a separate temporary bare repository outside V4 and read without running project scripts. No source was copied into this repository. |
| Compatibility | The project's metadata includes Harness `0.2.1-rc.2`. That declaration and the user's successful use are useful evidence, but do not prove every optional feature, future rc, or V4 data-isolation requirement. |
| Legacy comparison | DSH Desktop `3.44.2`, tag `DSH-desktop-v3.44.2`, commit `9330e3d801f206e68a914d65df246de77cdcb021`. Earlier read-only analysis inspected its native subagents, physical-operator adapter, Resident drivers, and orchestration. |
| Current uncertainty | Exact installed plugin versions, active optional backends, and the official app's effective isolated `DSH_HOME` have not been inventoried here. Do not infer them from a successful login or enabled switch. |

The report of working software is accepted as user experience evidence. The private-registry finding below is a source/maintenance boundary issue, not a claim that the user's installation fails. Formal installed acceptance and the D4 isolation boundary remain separate under [AGENTS.md](../../AGENTS.md#hard-boundaries).

## Existing components and retained functions

| Component or feature | Proposed V4 treatment | Owner and boundary |
|---|---|---|
| ChatGPT subscription OAuth and account management | Retain and reuse. Do not build another login or copy credentials. | Subscription plugin and DSH credential service. |
| Account model catalog, model selection, reasoning controls, quota display | Retain and reuse the account's actual supported values. | Subscription plugin and official DSH model/settings surfaces. Do not promise all accounts have the same models or treat quota as a billing ledger. |
| Subscription model as the DSH main model | Retain. | The subscription plugin registers `openai-codex` through the LLM adapter seam; DSH owns conversation history, tools, and execution. This is not a persistent native Codex thread. |
| Official Codex and Claude Code one-shot tasks | Retain both existing bundles. | The official providers own product startup, execution, and cleanup. The migration plugin coordinates bounded requests through the public subagent service. |
| Subscription search | Retain its useful search capability, subject to the public-seam redesign below. | Do not preserve private registry replacement as the V4 integration mechanism. |
| Subscription plugin's optional native Codex backend | Keep available as an optional, separately selected mode. Do not turn it on or change the user's current selection here. | Its source passes the plugin OAuth account and configures a separate native home; that runtime isolation has not been checked here. It is distinct from the ordinary official Codex tool. |
| Images, sketch, connectors, mobile control, cloud compaction, transport previews | Preserve the user's existing installation and choices; exclude these from the first migration plugin's acceptance scope. | Remain third-party capabilities. No forced disabling, automatic enabling, or new claim that each has been tested. Mobile control remains distinct from remote execution scheduling. |

A model supplied through the subscription adapter can use DSH tools because DSH runs the conversation. A native Codex/Claude child receives a standalone task and runs that product's own execution environment. The migration plugin must keep these identities visible instead of presenting every route as the same kind of Codex execution.

## The migration plugin

### Proposed first slice

The proposed package `@lisihao/dsh-solar-native-collaboration` carries the useful bounded part of the former physical-operator collaboration layer:

1. An explicit choice of the available official Codex or Claude Code executor for one task. The current main model remains selected by the user; delegation does not replace it.
2. A structured handoff containing the task, working directory, allowed scope, expected result, and requested verification. It is presented as the actual delegated text, so the model-visible input remains reconstructable from official tool/session logging.
3. Capability-aware dispatch: reject unsupported model overrides, continuation, or input shapes rather than silently ignoring them or switching products.
4. A readable task acknowledgement and result linked to the official child identity, showing actual completion, refusal, failure, or cancellation. A returned answer alone does not certify the requested code or tests.
5. Plugin lifecycle cleanup: remove the plugin's own tool and settings contributions on disable; cancel and await cleanup of its own live activations where required, without stopping unrelated children or unregistering official providers.

The first slice is a design proposal, not a scheduled implementation. D7 remains unchanged. A single model-visible tool, tentatively `solar_delegate`, is sufficient; its final name and UI wording are fixed during implementation review. It must not shadow `subagent_codex`, `subagent_claude_code`, or the standard DSH delegation tools.

The plugin does not create another scheduler, native CLI driver, account vault, daemon, model directory, or full trace database. It uses `ctx.subagents.startActivation()` with the actual parent and parent delivery, then follows that activation's returned result and lifecycle. The public service and existing session records remain the execution authority. After publication, cancelling a published activation requires its disposal path; aborting only a startup request is not proof that the child stopped.

An explicit task directory is not filesystem isolation by itself. Use an already prepared task worktree for conflicting writes, and do not claim that registering a child automatically creates one. Read admission/capacity failures as failures; do not increase parallel limits, change models, or bypass permissions to make dispatch succeed.

### Extension points and dependencies

| Purpose | Existing seam or component | Integration rule |
|---|---|---|
| Main-model inference | Subscription plugin's `openai-codex` adapter, registered with `ctx.llm.registerAdapter()` | Reuse the selected route; do not register a competing adapter under that id. |
| One-shot external work | Official `codex` and `claude-code` providers through `ctx.subagents` | Use documented activation/capability/lifecycle APIs; no private provider fields or protocol patching. |
| User/model entry | Official tool registration and supported settings/profile composition | Register only the migration plugin's own contributions and disposers. Do not alter another tool's implementation. |
| Search | `ctx.web.registerSearchProvider()` and `WebRuntimeConfig.searchProvider` | Select an explicit provider through supported configuration. Never access or replace the private provider map. |
| Output and evidence | Official tool results, child catalog, and completion notices | Preserve reported facts and link evidence; do not manufacture private native reasoning, token totals, or execution success. |

The official packages imported by the new Solar plugin belong in `peerDependencies` and test `devDependencies`, as required by V4. Existing bundles remain separately installed providers; importing and invoking their `apply()` again would risk duplicate registration and is not the proposed composition. Declare supported versions and fail clearly when an essential provider is absent.

The subscription plugin is an independently installed, pinned integration dependency. Do not rename or republish it under the Solar name merely to claim a migration. The new plugin contains our collaboration behavior and any reviewed thin adapter, while its README and `UPGRADING.md` identify the external versions and APIs it relies on.

## Search redesign

### Confirmed issue

In `v3.1.1`, `src/index.js` reads `ctx.web.searchProviders`, uses it to resolve the configured DSH provider, and later assigns a Proxy router back to it. `src/search-router.js` intercepts the registry's `get()` behavior. In the official rc.2 implementation that registry is a private field. Unload-time restoration does not turn this into a public extension point.

The assignment is installed during plugin loading; changing the search selection or switching features off is not evidence that the private-field access disappears. An outer Solar wrapper that restores or replaces the registry again would introduce another runtime patch and is not an acceptable fix.

### Recommended first resolution: explicit search selection

Change the **integrated project**, not official Harness:

1. Preserve its standalone Codex search provider and register it through `ctx.web.registerSearchProvider()`. The reviewed provider id is `codex-subscription`.
2. Remove both private-map reads and the Proxy replacement, including fallback code that resolves another provider from that map. Removing only the assignment is insufficient.
3. Select the desired search provider through the official web service's `searchProvider` configuration in the profile. The existing DSH search provider remains a separately configured alternative. Any later settings UI must use a supported settings/configuration entry point, not private service or loader internals.
4. Keep registration and disposal scoped to the integrated plugin. If the selected provider is missing or unavailable, preserve the host's explicit error rather than silently changing accounts or providers.
5. Before an authorized switch or removal, explicitly select the intended surviving provider. This is configuration work with a known target, not an automatic global rewrite on plugin disposal.

**Behavioral tradeoff requiring review:** this first resolution keeps subscription search and explicit source selection, but does not retain transparent routing by the current model or automatic fallback to an arbitrary configured provider. It must not be accepted as fully equivalent to the current automatic search behavior without 昊哥 agreeing to that narrower behavior.

### If automatic routing must be retained

The public rc.2 web service exposes registration and configured search execution; the inspected interface does not expose a general named-provider lookup or execution API. A router selected as the active provider cannot call `ctx.web.search()` to reach the previous provider: that can select the router again. Temporarily rewriting global selection around individual requests is also unsuitable for concurrent sessions.

Prefer a reviewed release from the integrated-project author that uses public seams. If the exact automatic behavior needs a new official extension point, draft a narrowly scoped proposal for named-provider execution or equivalent provider composition, with explicit selection, cancellation, lifecycle, and recursion behavior. Such an API is a proposal, not an existing capability. Submission to the official project requires approval under D3.

Until a supported mechanism is available, record automatic cross-provider routing as deferred. Do not duplicate DSH's account/credential handling merely to reproduce its existing provider privately.

### Distribution of a fix

Preferred: pin an author-published corrected version after source review and acceptance. If that is unavailable and 昊哥 chooses a maintained fork, pin a tagged/published fork of the integrated project and record the carried change and upgrade steps. This permission to consider a fork applies to the integrated plugin, never to official Harness.

Do not patch the installed package, use `pnpm patch`/`patch-package`, copy integrated-project source into the Solar adapter, or load an unchanged bundle and try to undo its private-field mutation afterward. A candidate that replaces the third-party bundle must be tested without loading both versions, which would compete for provider/tool registrations. No installed package is replaced by this document.

## Cooperation with the installed official subagents

| Route | Model/session owner | Authentication | Proposed use |
|---|---|---|---|
| Subscription main model | DSH session and tools; subscription model service | Plugin-managed ChatGPT OAuth | Ordinary DSH conversation and tool use; no native Codex thread continuity claim. |
| Official Codex provider | Fresh native Codex task | Native Codex configuration/authentication | Default Codex delegation target for the migration plugin's first slice, subject to the user's existing configuration. |
| Official Claude Code provider | Fresh native Claude Code task | Native Claude Code configuration/authentication | Claude delegation target; subscription plugin does not provide Claude authentication or a Claude main-model adapter. |
| Optional subscription Codex backend | Fresh native Codex task via the official runtime | Source passes subscription plugin OAuth through app-server token sharing and sets a separate `CODEX_HOME`; installed behavior has not been checked here. | Optional later alternative when explicit account/model controls justify it. Do not assume that it is currently selected. |

The optional subscription backend registers `codex-subscription-subagent`. Its switcher changes eligible standard `spawn` tool configuration, not every provider or every dedicated Codex tool. Fork/custom tools are excluded. Do not activate that switcher just because the migration plugin is enabled. If it is later selected, inventory the effective tools and keep each call bound to one explicit backend; an unavailable backend must not silently reroute to another account or product.

Official Codex and Claude providers fix optional model choices at provider-instance configuration and do not accept arbitrary per-call `agentOptions`. The optional subscription backend has its own model/effort support, but that must not be generalized to the ordinary official providers. Existing human-approved configuration remains in force.

External tasks require self-contained instructions and do not accept continuation. The migration plugin must not present a fresh task as a continuation of the previous native conversation. Native input prompts and approval settings are separate from the DSH parent's settings; clarify a rejected request instead of escalating permissions automatically.

## What to migrate from DSH 3.x

The following is a scoped migration recommendation, not a claim that the remaining packages have all been assessed or scheduled. Package paths are relative to the legacy source snapshot.

| Legacy function and relevant code | Proposed treatment | Boundary or next evidence |
|---|---|---|
| Basic Codex/Claude invocation: `packages/subagent/subagent-*`, `physical-operator-subagent` | Reuse official providers; do not port the old drivers or provider edits. | User reports the official bundles working. Test only the new plugin's use of their published APIs when implementation is authorized. |
| Codex subscription main model, account model/effort controls: parts of `tool-physical-operator`, `ui-physical-operator`, Resident routing | Reuse `dsh-codex-subscription` and DSH's model/settings UI. | This replaces the user need for a subscription-backed DSH main model, not every native Codex execution semantic. Resolve the source-boundary issue above. |
| Bounded native collaboration: stable executor choice, explicit handoff, result presentation | Implement the proposed single Solar migration plugin against current services. | First-slice proposal only; no new daemon, automatic allocator, or native-session persistence. |
| Automatic allocation, quota-aware switching, native model/effort policy | Defer additional automation and use current explicit selection. | Check native capabilities, account separation, and the real user need before extending the migration plugin. No silent model or spending changes. |
| Persistent native Codex/Claude sessions and recovery: `resident-operator*` | Defer as a distinct capability assessment. | Official one-shot providers cannot provide it by adding a wrapper. A future implementation needs verified public lifecycle/process seams and its own persistence design. |
| Claude Code as the DSH main executor | Keep official one-shot delegation for now; assess this separately if requested. | The subscription plugin does not fill this gap. Do not describe GPT-as-main as Claude-as-main support. |
| Task templates and output style: `prompt/task-template*`, `core/output-style` | Assess current official skills/presets/settings first; port only a demonstrated gap as a separate plugin. | Not yet selected as the first plugin and not automatically bundled into native collaboration. |
| TaskGraph and continual execution: `orchestration*`, `continual-harness*` | Compare each required behavior with official workflow, goal, and team packages before designing a separate plugin. | Package-name overlap is not equivalence. Durable scheduling and remote execution remain unverified migration requirements. |
| Debate: `debate*`; RLM: `rlm-runtime*`, `rlm-strategy*` | Separate design and priority decisions. | No wholesale port, no inherited experimental efficacy claim, and no paid run authorized by this plan. |
| Kennel/Gouzi and remote members: `host/gouzi-member`, `ui-gouzi`, remote orchestration | Separate assessment after local collaboration is understood. | Phone control of a DSH host is not multi-host execution, membership, or TaskGraph recovery. |
| ChatGPT browser execution and browser automation | Compare against subscription inference and official browser providers by actual user need. | Subscription model access is not browser automation; do not claim one covers the other. |
| Native event/usage/receipt dashboards | Use official child records and third-party account projections first; add only missing task evidence in a separately scoped change. | No promise of complete native reasoning, raw transcripts, or precise billing. |
| Existing independently maintained third-party packages | Reuse compatible releases and attribute them. | Do not copy their source or relabel their releases as Solar output. |

This sequence preserves useful behavior while removing duplicated infrastructure. It does not migrate the complete physical-operator, Resident, or orchestration package families together.

## Data, build, and upgrade boundary

The integrated project's [MIT license](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/LICENSE) permits redistribution subject to retaining its copyright and permission notice. Any fork/distribution must preserve relevant notices and dependency attribution. Its published package contains built `lib/*.js`, profile patch, locales, and documentation; its build uses `tsdown`, and its tests use Node's test runner. None of those scripts ran during this design work.

The Solar plugin follows the V4 ESM/TypeScript/build/package contract. Its exact dependency pins and compatibility bounds belong in its eventual `package.json` and `UPGRADING.md`; no manifest or scaffold is created now. `UPGRADING.md` must list the provider ids and public APIs used, optional-backend differences, tested baselines, and every carried integrated-project patch.

No Python, pip package, model file, or new native binary is introduced by the proposed first slice. Existing official subagent packages own their native payloads. The subscription plugin's optional native backend resolves the host-matched official Codex package through its dependency graph and currently checks Codex `0.153.4`; do not assume that an installed UI entry alone proves that this optional resolver can find its dependency. Future readiness testing must use the normal plugin-manager path, with no copying out of the app or downloading executables into the repository.

The first slice needs no independent execution database. Host configuration owns selected preferences and official session records own child results. If later behavior requires plugin-owned files, they belong under `$DSH_HOME/solar/native-collaboration/` with a format version and explicit refusal of unsupported formats. Do not store another copy of OAuth tokens or native session histories.

The existing third-party plugin uses DSH credentials and its own `$DSH_HOME/state/codex-subscription/` namespace. This differs from the Solar-owned data-directory convention. Document the third-party dependency boundary explicitly before formal integration acceptance; do not silently relocate its state or claim it already uses the Solar namespace. The user's existing data remains untouched.

Do not copy DSH 3.x `~/.dsh`, settings, credentials, sessions, daemon databases, or native thread ids into V4. Any later legacy-data import is a separately approved, versioned operation on an explicit export. Reading legacy source does not authorize runtime migration.

## Implementation order and acceptance, when authorized

1. Confirm only the information needed by the next step: exact installed bundle versions, chosen backend/configuration, and D4's effective isolated home. Reuse the user's reported successful use; do not start with a blanket reinstall or duplicate paid probes.
2. Review the search tradeoff and choose an integrated-project fix path. Prepare a concrete patch/proposal only after implementation or external-proposal work is authorized. Keep current installed software separate from the candidate.
3. Approve the first-slice boundary and final package name, then implement **one Solar plugin**. Use a V4 task branch/worktree; the task's development directory follows the unresolved Q3 decision, while the release package belongs under `plugins/native-collaboration/`.
4. Verify the built package against the published baseline in a scratch home. Exercise actual observable behavior and lifecycle; add only focused tests that answer a real question.
5. Once D4 permits install acceptance and the work is authorized, validate the plugin in the official app using a stable installation artifact/path. Then prepare the source PR, keeping merge and plugin release as separate authorized steps.

| Acceptance area | Required future evidence |
|---|---|
| Registration | One new Solar bundle; unique tool name; official providers and the subscription adapter remain registered once. Disable removes only Solar-owned contributions. |
| Main-model independence | Delegating to Codex or Claude does not change the selected main model, reasoning setting, account, or the optional standard-subagent backend. |
| Handoff and outcome | Exact delegated input is reconstructable; correct provider and cwd are used; unsupported overrides are rejected; parent receives an honest acknowledgement and terminal result. |
| Cancellation and failure | Startup refusal is surfaced; published activation cancellation uses its lifecycle; no fabricated completion, silent fallback, or automatic replay of uncertain work. |
| Search boundary | Corrected source contains no private registry access/replacement. In an isolated assembled host, registration leaves the official registry identity and unrelated providers intact; explicit DSH/Codex selection works; selected-provider failure is visible; removal leaves a deliberately configured surviving provider. |
| Compatibility | Built `lib/`, shared host module instances, supported runtime cohort, and the relevant optional-component readiness are checked. Repeat affected checks when their inputs change. |
| Installed behavior | Exercise the normal official-app path under the isolated V4 home; inspect relevant UI at default and narrow widths. User-reported current success is retained separately from this candidate's test result. |
| Publication | New Solar plugin version/tag, market entry, and generated homepage agree after approved release. External dependencies are attributed and are not presented as newly published Solar plugins. |

Source readiness, installed acceptance, and publication are reported separately. The current documentation work has not run any of these implementation/runtime checks.

## Decisions still required

- Approve or revise the proposed native-collaboration first slice; its name is provisional. The user has confirmed that the migration must be a plugin, not that every legacy subsystem should be included in it.
- Choose whether explicit search selection is an acceptable first correction, or automatic routing must wait for an adequate public seam.
- Choose author-maintained release versus a maintained pinned fork if necessary. Approve each external issue/PR before submission; no such message has been sent.
- Before a future configuration change, choose whether native Codex tasks use the already installed official provider or the optional subscription-authenticated backend. Preserve the current setup until then.
- Resolve relevant Q1–Q3 and the third-party data-boundary interpretation before the dependent implementation/release step. Do not treat these as reasons to repeat D1–D8 or reinstall working plugins.

## Source references

- Integrated release: [package metadata](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/package.json), [compatibility](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/compatibility.json), [main adapter and search composition](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/index.js), [search Proxy](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/search-router.js).
- Optional backend: [provider and switcher](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/subagent-backend.js), [OAuth handoff](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/subagent-auth.js), [runtime resolution](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/subagent-runtime.js).
- Official rc.2: [public web configuration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/web/web/README.md), [private registry and registration API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/web/web/src/index.ts), [subagent service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/README.md), [Codex provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-codex/README.md), [Claude provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-claude-code/README.md).
- DSH 3.44.2: [main-model and collaboration layer](https://github.com/lisihao/deepseek-solar-harness/blob/9330e3d801f206e68a914d65df246de77cdcb021/packages/physical-operator/tool-physical-operator/README.md), [Resident implementation](https://github.com/lisihao/deepseek-solar-harness/blob/9330e3d801f206e68a914d65df246de77cdcb021/packages/physical-operator/resident-operator-local/README.md), [orchestration](https://github.com/lisihao/deepseek-solar-harness/blob/9330e3d801f206e68a914d65df246de77cdcb021/packages/orchestration/orchestration-local/README.md).
