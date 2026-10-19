# DSH Codex Subscription: V4 integration and DSH 3.x migration

Status: integration design, updated after implementation authorization on 2026-10-19. 昊哥 reports that the official Codex subagent, official Claude Code subagent, and `dsh-codex-subscription` are installed and working. Development of the two Solar plugins is now authorized under the [implementation contract](../native-plugins-contract.md). Existing-app installation, third-party configuration changes, paid probes and publication remain outside this source-development scope.

The migration delivers **two independently installable Solar plugins**: `@lisihao/dsh-solar-native-collaboration` owns handoff, cooperation and model allocation; `@lisihao/dsh-solar-native-resident` owns native Drivers, persisted sessions/lanes, tool bridging, TaskGraph, scheduling and recovery. Existing subscription/account/main-model functionality remains with the installed third-party plugin. RLM was explicitly excluded and will be a separate task. There is no app build or V4 core package.

## Starting point and evidence

| Item | Evidence and limit |
|---|---|
| Existing installation | User-confirmed working on 2026-10-19. Preserve that installation; do not reinstall or disable it as part of this design. The user did not provide an exact installed subscription-plugin version or a feature-by-feature acceptance record. |
| Official Harness baseline | `@deepseek-ai/dsh@0.2.1-rc.2`, tag `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`. The preceding inspection read the official app's matching version metadata. |
| Integrated project | [WSL043/dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription), reviewed release `v3.1.1`, commit `f9ecdd4dbe56b45e85ed8c2eadf79d98be5942d9`. This is the source-analysis pin, not a claim about the installed version. |
| Reference source | Release `v3.1.1` was cloned into a separate temporary bare repository outside V4 and read without running project scripts. No source was copied into this repository. |
| Compatibility | The project's metadata includes Harness `0.2.1-rc.2`. That declaration and the user's successful use are useful evidence, but do not prove every optional feature or future rc. |
| Legacy comparison | DSH Desktop `3.44.2`, tag `DSH-desktop-v3.44.2`, commit `9330e3d801f206e68a914d65df246de77cdcb021`. Earlier read-only analysis inspected its native subagents, physical-operator adapter, Resident drivers, and orchestration. |
| Current uncertainty | Active optional backends and their behavior have not been fully inventoried here. Do not infer them from a successful login or enabled switch. On 2026-10-19 昊哥 selected the existing `~/.dsh` as the default installation home, superseding the earlier isolated-home requirement. |

The report of working software is accepted as user experience evidence. The private-registry finding below is a source/maintenance boundary issue, not a claim that the user's installation fails. Formal installed acceptance remains separate under [AGENTS.md](../../AGENTS.md#hard-boundaries); D4 now selects the existing `~/.dsh` home.

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

## The migration plugins

### Collaboration responsibilities

The package `@lisihao/dsh-solar-native-collaboration` carries the useful bounded part of the former physical-operator collaboration layer:

1. An explicit choice of the available official Codex or Claude Code executor for one task. The current main model remains selected by the user; delegation does not replace it.
2. A structured handoff containing the task, working directory, allowed scope, expected result, and requested verification. It is presented as the actual delegated text, so the model-visible input remains reconstructable from official tool/session logging.
3. Capability-aware dispatch: reject unsupported model overrides, continuation, or input shapes rather than silently ignoring them or switching products.
4. A readable task acknowledgement and result linked to the official child identity, showing actual completion, refusal, failure, or cancellation. A returned answer alone does not certify the requested code or tests.
5. Plugin lifecycle cleanup: remove the plugin's own tool and settings contributions on disable; cancel and await cleanup of its own live activations where required, without stopping unrelated children or unregistering official providers.

The subsequent authorization extends this design: `solar_delegate` handles single-task handoff, `solar_coordinate` handles graph/model allocation, and the independent Resident bundle exposes `solar_resident`. These names do not shadow official delegation tools. The shared versioned service contract and complete current acceptance boundary are in [native-plugins-contract.md](../native-plugins-contract.md).

The collaboration plugin owns no scheduler, native Driver, account vault or daemon. Its single mode uses `ctx.subagents.startActivation()` with the actual parent and parent delivery. Its resident mode uses the optional public Solar Resident service. Only Resident owns durable graph scheduling and native execution state. Cancelling a published official activation uses its disposal path; cancelling durable work requires an explicit graph control, while disposing a Resident client detaches it.

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

Prefer a reviewed release from the integrated-project author that uses public seams. If the exact automatic behavior needs a new official extension point, record the missing named-provider execution or equivalent provider composition locally, including selection, cancellation, lifecycle, and recursion requirements. Such an API is not an existing capability. Under D3, prepare any official-upstream issue/PR as a draft for 昊哥's approval before sending it; never patch the installed upstream runtime.

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
| Basic Codex/Claude invocation: `packages/subagent/subagent-*`, `physical-operator-subagent` | Reuse official providers for one-shot work; durable execution uses the independent Resident Drivers below. | User reports the official bundles working. Verify the new plugin's use of their published APIs separately. |
| Codex subscription main model, account model/effort controls: parts of `tool-physical-operator`, `ui-physical-operator`, Resident routing | Reuse `dsh-codex-subscription` and DSH's model/settings UI. | This replaces the user need for a subscription-backed DSH main model, not every native Codex execution semantic. Resolve the source-boundary issue above. |
| Bounded native collaboration: stable executor choice, explicit handoff, result presentation | Implement native-collaboration against official subagents and the optional public Solar Resident service. | Collaboration owns allocation and handoff; Resident owns native execution and persistence. |
| Model allocation and native model/effort policy | Collaboration selects from configured roles/profiles and advertised native catalogs; explicit selections take precedence. | No silent model/account fallback. Quota-aware account switching is not implemented or claimed. |
| Persistent native Codex/Claude sessions and recovery: `resident-operator*` | The independent native-resident plugin owns Drivers, session lanes, receipts and recovery. | Use public product protocols/SDK; official one-shot activations are not resumable native sessions. |
| Claude Code as the DSH main executor | Keep official one-shot delegation for now; assess this separately if requested. | The subscription plugin does not fill this gap. Do not describe GPT-as-main as Claude-as-main support. |
| Task templates and output style: `prompt/task-template*`, `core/output-style` | Assess current official skills/presets/settings first; port only a demonstrated gap as a separate plugin. | Not yet selected as the first plugin and not automatically bundled into native collaboration. |
| Durable TaskGraph and task scheduling: `orchestration*` | Native-resident owns the single local durable graph and admission scheduler; collaboration submits assigned graphs. | Validate dependencies, capacity, scopes, cancellation, idempotency and restart recovery. Calendar/cron, remote scheduling and Continual Harness are not activated. |
| Debate: `debate*`; RLM: `rlm-runtime*`, `rlm-strategy*` | Separate tasks; 昊哥 explicitly excluded RLM from the current two-plugin delivery. | No inherited efficacy claim or paid run. |
| Kennel/Gouzi and remote members: `host/gouzi-member`, `ui-gouzi`, remote orchestration | Separate assessment after local collaboration is understood. | Phone control of a DSH host is not multi-host execution, membership, or TaskGraph recovery. |
| ChatGPT browser execution and browser automation | Compare against subscription inference and official browser providers by actual user need. | Subscription model access is not browser automation; do not claim one covers the other. |
| Native event/usage/receipt dashboards | Use official child records and third-party account projections first; add only missing task evidence in a separately scoped change. | No promise of complete native reasoning, raw transcripts, or precise billing. |
| Existing independently maintained third-party packages | Reuse compatible releases and attribute them. | Do not copy their source or relabel their releases as Solar output. |

This sequence preserves useful behavior while removing duplicated infrastructure. It does not migrate the complete physical-operator, Resident, or orchestration package families together.

## Data, build, and upgrade boundary

The integrated project's [MIT license](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/LICENSE) permits redistribution subject to retaining its copyright and permission notice. Any fork/distribution must preserve relevant notices and dependency attribution. Its published package contains built `lib/*.js`, profile patch, locales, and documentation; its build uses `tsdown`, and its tests use Node's test runner. None of those scripts ran during this design work.

Both Solar plugins follow the V4 ESM/TypeScript/build/package contract. Their `package.json` and `UPGRADING.md` record exact dependency pins, public APIs, compatibility bounds and carried patches. The subscription plugin is not repackaged or modified by these bundles.

Collaboration adds no native runtime. Resident pins the public Codex package and Claude Agent SDK as ordinary dependencies and keeps its Drivers internal to that plugin. No Python, pip or model-file installer is introduced. Existing official subagent packages continue owning their separate one-shot payloads. Readiness must be tested through normal plugin-manager installation; no app binary is copied into the repository.

Collaboration needs no independent execution database. Host configuration owns selected preferences and official session records own one-shot child results. Resident owns its versioned graph/session mapping and tool receipts under `$DSH_HOME/solar/native-resident/`. It stores native session identities, not another copy of OAuth tokens or native transcript files.

The existing third-party plugin uses DSH credentials and its own `$DSH_HOME/state/codex-subscription/` namespace. This differs from the Solar-owned data-directory convention. Document the third-party dependency boundary explicitly before formal integration acceptance; do not silently relocate its state or claim it already uses the Solar namespace. The user's existing data remains untouched.

Do not copy DSH 3.x `~/.dsh`, settings, credentials, sessions, daemon databases, or native thread ids into V4. Any later legacy-data import is a separately approved, versioned operation on an explicit export. Reading legacy source does not authorize runtime migration.

## Implementation order and acceptance

1. Use the recorded published baseline for source development. Verify exact installed versions and the selected home before existing-app acceptance; use disposable homes for keyless plugin testing. Reuse the user's reported successful use; do not reinstall or run duplicate paid probes.
2. Keep the search correction separate from the two-plugin implementation. The installed subscription plugin remains unchanged. A future correction requires its own reviewed fix path and authorization.
3. Implement the **two authorized Solar plugins** on task branches. Unreleased sources stay under `incubator/`; only an authorized release moves the relevant package under `plugins/`.
4. Verify the built package against the published baseline in a scratch home. Exercise actual observable behavior and lifecycle; add only focused tests that answer a real question.
5. Prepare separate source PRs after source/plugin checks pass. Once installation is authorized, validate each plugin in the official app using a stable installation artifact/path and the selected home (default `~/.dsh`). Merge and plugin release remain separate authorized steps.

| Acceptance area | Required future evidence |
|---|---|
| Registration | Two independent Solar bundles with unique tools; official providers and the subscription adapter remain registered once. Disable removes only Solar-owned contributions. |
| Main-model independence | Delegating to Codex or Claude does not change the selected main model, reasoning setting, account, or the optional standard-subagent backend. |
| Handoff and outcome | Exact delegated input is reconstructable; correct provider and cwd are used; unsupported overrides are rejected; parent receives an honest acknowledgement and terminal result. |
| Cancellation and failure | Startup refusal is surfaced; published activation cancellation uses its lifecycle; no fabricated completion, silent fallback, or automatic replay of uncertain work. |
| Search boundary | Corrected source contains no private registry access/replacement. In an isolated assembled host, registration leaves the official registry identity and unrelated providers intact; explicit DSH/Codex selection works; selected-provider failure is visible; removal leaves a deliberately configured surviving provider. |
| Compatibility | Built `lib/`, shared host module instances, supported runtime cohort, and the relevant optional-component readiness are checked. Repeat affected checks when their inputs change. |
| Installed behavior | Exercise the normal official-app path under the selected Harness home (default `~/.dsh`); inspect relevant UI at default and narrow widths. User-reported current success is retained separately from this candidate's test result. |
| Publication | New Solar plugin version/tag, market entry, and generated homepage agree after approved release. External dependencies are attributed and are not presented as newly published Solar plugins. |

Source readiness, installed acceptance, and publication are reported separately. The implementation contract and each plugin's README describe the current checks. Installed-GUI acceptance and subscription-search correction are not claimed by source verification.

## Decisions still required

- The two-plugin split and current scope are approved under the implementation contract; unrelated legacy subsystems remain separate.
- Choose whether explicit search selection is an acceptable first correction, or automatic routing must wait for an adequate public seam.
- Choose author-maintained release versus a maintained pinned fork of the integrated subscription plugin if necessary. Any issue/PR to that integrated project needs separate approval; no such message has been sent. D3 also requires 昊哥 to approve a concrete official-upstream proposal before it is sent.
- Before a future configuration change, choose whether native Codex tasks use the already installed official provider or the optional subscription-authenticated backend. Preserve the current setup until then.
- Q1–Q3 have since been confirmed in AGENTS.md. Verify the third-party data boundary before dependent release acceptance; do not repeat settled decisions or reinstall working plugins.

## Source references

- Integrated release: [package metadata](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/package.json), [compatibility](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/compatibility.json), [main adapter and search composition](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/index.js), [search Proxy](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/search-router.js).
- Optional backend: [provider and switcher](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/subagent-backend.js), [OAuth handoff](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/subagent-auth.js), [runtime resolution](https://github.com/WSL043/dsh-codex-subscription/blob/v3.1.1/src/subagent-runtime.js).
- Official rc.2: [public web configuration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/web/web/README.md), [private registry and registration API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/web/web/src/index.ts), [subagent service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/README.md), [Codex provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-codex/README.md), [Claude provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent-claude-code/README.md).
- DSH 3.44.2: [main-model and collaboration layer](https://github.com/lisihao/deepseek-solar-harness/blob/9330e3d801f206e68a914d65df246de77cdcb021/packages/physical-operator/tool-physical-operator/README.md), [Resident implementation](https://github.com/lisihao/deepseek-solar-harness/blob/9330e3d801f206e68a914d65df246de77cdcb021/packages/physical-operator/resident-operator-local/README.md), [orchestration](https://github.com/lisihao/deepseek-solar-harness/blob/9330e3d801f206e68a914d65df246de77cdcb021/packages/orchestration/orchestration-local/README.md).
