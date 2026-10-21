# Curated plugin usage guide

This guide is the public, English-language usage reference for the Solar plugin set described by the V4 homepage. Chinese labels below are the labels used by the candidate UI. The guide records the evidence boundary as of 2026-10-22 (Asia/Hong_Kong); a source checkout, a packed artifact, an enabled plugin, and a successful live task are separate facts.

V4 is built for the official DeepSeek Harness `0.2.1-rc.2` and does not rebuild or modify the official app. The Solar market has not been published yet, so there is no Discover index URL to add. The six Solar plugins remain development candidates. Exact preview archives and maintained forks are distributed in `distribution/plugins/`, independently of a market release. Do not present an incubator package as a market release.

## Install and restart

Use the official Harness plugin manager and an exact package or tarball version. Back up the affected profile configuration before changing an installed profile, fully quit the app for an update, and relaunch it after the manager finishes. In the official UI the entry is **插件** (the official plugin manager). A profile that permits the bundled CLI can use:

```sh
dsh plugin --profile <profile> add <absolute-tarball>
```

Use a stable downloaded artifact, never a removable task worktree. The Desktop profile may impose its own app-managed installation path; follow the app's plugin page when the CLI rejects that profile. After relaunch, verify the plugin's enabled state and its visible status before trying a provider or model action. Installing a package does not prove that its provider login, live website path, model behavior, or user acceptance is complete.

The public source history is useful for provenance, but it is not a release channel:

- [ChatGPT Web / Insight and collaboration candidate, PR #281](https://github.com/lisihao/deepseek-solar-harness/pull/281). The current Web candidate has source/keyless receipt repair checks; its live outcome remains unaccepted.
- [Installed Collaboration source `514f6ac`](https://github.com/lisihao/deepseek-solar-harness/commit/514f6ac188da54fbdb4692a310d00281230ac163) and [Resident source `c83f950`](https://github.com/lisihao/deepseek-solar-harness/commit/c83f9500c2c3d64ce07efa763180e6dfba05e1e6).
- [Model-handoff source history, PR #283](https://github.com/lisihao/deepseek-solar-harness/pull/283). The handoff README and verification record remain the authority for the exact candidate and its acceptance boundary.
- [Prime RLM artifact, PR #280](https://github.com/lisihao/deepseek-solar-harness/pull/280) and [installed-source commit `6a47ed6`](https://github.com/lisihao/deepseek-solar-harness/commit/6a47ed6afdc8e433f8748172322f93c8a56eb074).
- [Current handoff artifact source `73e92a6`](https://github.com/lisihao/deepseek-solar-harness/commit/73e92a6bc19df25f269e13c3378b48f8002db839) includes the earlier browser-factory repair; its package identity is in the distribution catalog.
- [Solar billion-context fork commit `ee8ad8c6`](https://github.com/lisihao/billion-context/commit/ee8ad8c6cb5e0bdcb0ac998486df893faa1db6b8) and its [Solar release](https://github.com/lisihao/billion-context/releases/tag/solar-v0.1.202-1).
- [Dream Skin local-folder candidate commit `2f6929c`](https://github.com/lisihao/dsh-dream-skin/commit/2f6929c6010c8bdc215ab0a23bda1ce7d3e11c3a).

## At-a-glance status

| Plugin or package | What is available | Current boundary |
|---|---|---|
| `@lisihao/dsh-solar-model-handoff` | Source repair and a packed development artifact | Short-task and keyless route checks exist. A live model summary and result-carrying handoff are not claimed here. |
| `@lisihao/dsh-solar-native-resident` | Native service, `solar_resident`, persistent lanes, and the durable local TaskGraph | Source, built-package, and scratch checks exist. This does not claim indefinite autonomous work, provider quality, or complete live-provider acceptance. |
| `@lisihao/dsh-solar-native-collaboration` | `协同模式`, `执行流程`, native handoff/allocation, and Resident coordination | Editing and save/read paths are bounded and can be model-free. Execution and quota-labelled canaries require a deliberate provider action. |
| `@lisihao/dsh-solar-chatgpt-web` | `ChatGPT 网页算子`, `洞察分析`, Web model discovery, and provider snapshots | Web and Insight remain experimental. A real attempt with the installed `2c338f9` artifact ended in `WEB_SUBMISSION_MISMATCH`; the newer `67cd3aa` distribution candidate passed source/keyless checks and was installed with all 54 packed files verified; its live answer path remains untested. The original TaskSpace was absent from a later task list although the user reported no intervention, so recovery must inspect the original status without resubmitting and the outcome is unknown. No successful live Web/Insight run is claimed. |
| `@lisihao/dsh-solar-rlm@0.1.0-dev.0` | The exact packed artifact built from source commit `6a47ed6` | Installed self-tests are keyless and local. Real-provider acceptance inside the installed App remains unrun. Separate source/evaluator experiments do not establish a general quality benefit. Later source changes are not assumed to be in this installed artifact. |
| `@lisihao/dsh-solar-skill-context` | Bounded discovery and canonical retirement of old full catalogs | 11 installed files verified; source/fake-model and isolated App Host checks pass, including the official Desktop-scoped loader. Manual plugin-list confirmation, real user-session disk restart and provider execution are separate/unrun. |
| `billion-context@0.1.202-solar.1` | Installed Solar-maintained fork with the preflight repair | The fork's source and fake/native checks pass at its stated boundary. A real long-session replay and model-quality or token-savings claim are not established. It is a context layer, not a second handoff or scheduler. |
| Dream Skin local-folder candidate | Source commit `2f6929c`, the exact packed version `10.21.2-folder.2f6929c` | The source snapshot's package metadata still reports `10.21.1`; `10.21.2` is not presented as a published release. User wallpaper folders are read at runtime when selected and are not included in the package. |

## On-demand skill context

Install `skill-context`, relaunch, and confirm **Solar 技能按需上下文** in the installed-plugin list. No separate chat panel or model is added. The next normally authorized native request uses `solar_skill_search` for relevant names/descriptions, then the unchanged official `skill` loader for complete instructions. A few keywords or an exact skill name work; broad results expose `nextOffset`. Defaults are eight matches, at most 240 Unicode characters per description and 8,192 UTF-8 bytes per result JSON. Search itself does not call a model or execute a skill.

Old visible automatic catalogs leave the canonical request through individual standard Session replacements; original log events and already loaded skill bodies remain. Installing or opening the plugin does not retry an old request or rewrite every stored conversation. Cleanup runs when a subsequent native request is admitted. Agent policies permitting `skill` must also expose `solar_skill_search`; an incompatible allowlist stops with a named error before changing that Session. Disable removes the hook/search tool and leaves the official mechanism available. This repair does not shrink arbitrary system prompts, loaded documents or tool results, and does not guarantee any future request fits its model window. Source and isolated fake-model checks are separate from real-provider or real user-session restart acceptance.

## Model handoff

Use the existing model picker for an ordinary native provider/model change. The plugin arms its gate before the target model's next request. A same-route or effort-only change does not request a summary, and changing an idle picker does not send a message. Entering `ChatGPT 网页算子` or `洞察分析` starts a fresh operator task; it does not ask a handoff question and does not call GPT-6 luna.

Before any summary request, choose whether to carry task context or start fresh. A task whose attributed text is at most 1,200 Unicode characters follows the exact-text path and does not call Luna. A longer task may call the configured `gpt-6-luna` summary model, ask zero to three necessary clarification questions, and show a confirmation preview. Clarification, waiting, and merging the selected human answers do not themselves make a model request. A generated summary is refused if it would exceed the task text rather than being silently truncated.

The **取消交接，空白开始** (cancel handoff, start fresh) choice keeps the selected target model and keeps the old chat records available for inspection, while replacing the old model-visible task range with an empty native checkpoint. It does not carry the rejected summary or old task messages and does not call Luna again. The original event log remains retained. `/handoff status` only reads the phase; `/handoff fresh` creates the selected route with no old task context; `/handoff retry` explicitly permits one new summary attempt but does not run it by itself. An interrupted or unknown summary request is never replayed automatically.

When returning from a consecutive Web/Insight segment to a native route, the UI presents two independent choices: carry the recorded Web/Insight result with its task question, and carry the effective task context frozen before the first Web/Insight entry. All four combinations are valid. Declining both creates a fresh native context; if no Web/Insight result was recorded, the result choice cannot invent one.

Handoff data is owned by `$DSH_HOME/solar/model-handoff/`. Receipts retain the complete summary request, output, and human answers. Provider credentials and provider-owned transcripts remain with the provider; do not copy them into Solar storage.

## Native collaboration and Resident

Install both native plugins when you need durable graphs, native lanes, or the collaboration flow. Resident publishes the public `solarNativeResident` service and the `solar_resident` tool. Collaboration owns the bounded handoff/allocation policy and exposes `solar_delegate`, `solar_coordinate`, and `solar_wait`; Resident owns admission, the daemon, native session mapping, receipts, and the single local scheduler.

The conversation header provides **协同模式** with **普通** and **智能协同**. Choosing either mode is session-scoped persistence and makes no model request. `普通` leaves ordinary chat available. `智能协同` requires Resident to be reachable, the main route not to be `solar-chatgpt-web`, and the current Agent to expose `solar_coordinate`, `solar_resident`, and `solar_wait`. Smart mode submits a bounded TaskGraph and then observes it with bounded `solar_wait`; a submission receipt is not task success. Resident does not promise work to run indefinitely through sleep, restart, lost authentication, or Host shutdown.

The **执行流程** view is optional for ordinary chat. It contains only the current session's captured sources, saved drafts, and runs. Selecting a source forks a new unsaved draft; source and prior run records remain immutable. Editing nodes, `保存草稿`, reopening a draft, and reading a source are model-free. A saved draft must be selected before execution:

- **按此草稿再次执行** captures the edited graph under a new command identity and may use the selected provider quota.
- **继续原执行（可能使用额度）** keeps the original command and frozen graph, reconciles its original effect, and may advance only unadmitted stages. It does not run the edited draft.

The Settings section **协同诊断** includes **刷新注册和任务状态**, which reads provider registration and existing Resident graphs without model discovery or model execution. **检查该任务状态** reads the same pending or unknown command and never resubmits it. The explicit buttons **测试 Codex（使用订阅额度）** and **测试 Claude Code（使用订阅额度）** submit text-only canaries only after the user clicks them; they use the corresponding native subscription quota. A canary acknowledgement or a `completed` graph is not a claim that an arbitrary task is correct.

Resident data is stored in `$DSH_HOME/solar/native-resident/`; session mode and flow drafts/runs are stored in `$DSH_HOME/solar/native-collaboration/`. Unsupported versions fail with named errors. Native products keep their own authentication and transcripts; the Solar namespaces do not contain copied credentials or native histories.

## ChatGPT Web and Insight

`ChatGPT 网页算子` is a text-only operator route. Select it through the normal model picker/model-handoff path. It requires an available Ego Lite CLI, an agent-owned TaskSpace, and a logged-in empty ChatGPT conversation. The plugin does not download the browser or copy browser credentials. Login prompts, user takeover, existing drafts or attachments, unknown model labels, and unavailable labels stop before submission.

The ordinary route returns the visible webpage answer as the assistant response in the same Harness session. It does not execute historical tool data, forward an active DSH tool bridge, or silently discard unsupported image/file input. `solar_chatgpt_web` operations are supporting run/observe/cancel controls, not a replacement chat panel. An unresolved browser effect must be observed by its original resource; the route has no automatic retry.

`洞察分析` is a staged, editable workflow: clarification, Gemini planning, explicit plan confirmation, Gemini research, ChatGPT Web verification, Gemini prose polishing, and delivery to the originating Harness conversation. The requested stage roles and the labels actually observed on the websites remain separate. Gemini Deep Research selectors, the requested Gemini model/mode, and the `GPT-6 Astra Pro Web search and analysis` fallback are unverified. A fallback requires exact visible quota-exhausted evidence with `no-active-effect`; timeout, login, selector, network, missing-receipt, and unknown outcomes are not quota evidence.

Settings → **网页与洞察** has **网页回答** and **洞察分析** tabs. **刷新可用模型** only reads the target browser's model and effort controls; it does not send a prompt. Saving preferences and reloading them affects new runs and makes no provider request. Do not use a cached label as proof that the website still exposes that model. Web and Insight provider records are kept under `$DSH_HOME/solar/chatgpt-web/`; browser login and account state stay outside that namespace.

The latest real Web attempt, made with the earlier installed `2c338f9` artifact, is retained as an unresolved recovery case: `WEB_SUBMISSION_MISMATCH` was observed, the original TaskSpace was absent from a later list, with no user intervention reported, and the safe next action is to read the original status and avoid a new submission. This is why Web and Insight are marked experimental here; neither a successful Web answer nor a completed Insight result is claimed.

## Solar Prime RLM

The installed RLM package is `@lisihao/dsh-solar-rlm@0.1.0-dev.0`, packed from source commit `6a47ed6` (PR #280). It wraps Prime Agent's original daemon, persistent Python kernel, recursive children, messaging, Factory, and Continual Harness behind the native ACP interface. Later source changes are not implied by the installed artifact.

The main conversation tools are:

| Tool | Action | Model/quota behavior |
|---|---|---|
| `solar_rlm_run` | Admit a bounded task with `task`, `cwd`, `maxModelRequests`, `maxWallTimeMs`, and optional selected inputs | Uses the calling DSH Agent's provider/model and can consume its quota. Request and wall-time bounds are admission limits, not a monetary bill cap. |
| `solar_rlm_inspect` | Read task state and a bounded result preview | No new model request. |
| `solar_rlm_control` `continue` / `refine` | Send a follow-up turn or Prime `/refine` command | May consume provider quota; use the original task reference and do not replay an unknown effect. |
| `solar_rlm_control` `cancel` | Ask the native process to stop | Does not request a new model turn; a request to cancel is not proof that a remote/native effect has stopped. |

The **Prime RLM** view and settings are read-only until a task or local self-test is explicitly started. The local self-test uses deterministic scripted loopback responses and does not measure model reasoning. RLM state is under `$DSH_HOME/solar/rlm`; selected input files are snapshotted inside the admitted working directory. Prime runs with normal process permissions in that directory and is not a Python sandbox.

The installed self-tests, source checks, and package wiring establish a mechanism boundary only. Separate isolated comparative trials and independent grading are recorded in the RLM development branch; their mixed and failed outcomes do not establish a general reasoning-quality improvement. Paper reproduction and held-out adaptation-effect acceptance remain unrun. Real-provider acceptance inside the installed App remains separate. This plugin is not documented as autonomous work that can continue indefinitely, and no quality benefit is inferred from installation or self-test output.

## billion-context

The installed package is `billion-context@0.1.202-solar.1` from the Solar-maintained fork `lisihao/billion-context`, commit `ee8ad8c6`, release `solar-v0.1.202-1`. This fork carries the stated preflight fixes and its own release ownership; it is not an official upstream release. Use the exact Solar release artifact and checksum when installing it through the official DSH plugin manager. The fork README documents both `bili plugin install dsh` and the equivalent `dsh plugin --profile <name> add billion-context` path for supported profiles.

The plugin is a model-facing context-compression layer. As the conversation grows, the model may call `compress`, `decompress`, `search_context`, and `acp_status`; the layer does not create a separate handoff route, does not coordinate Resident graphs, and does not claim autonomous work. A real client model request remains a provider request and can consume that provider's quota. There is no separate “compression button” that proves a saving.

Do not enable a native `billion-context` integration together with a standalone in-process extension such as `billion-context-pi` or `opencode-acp`; those are alternative compression paths and can double-compress a conversation. This rule is independent of the model-handoff plugin: billion-context does not replace or duplicate model handoff.

A new 2026-10-21 report is under investigation: the proxy estimated about 664k tokens for a 375k model window and reported that all foldable material could save only about 165k. It refused the over-window request. The older calibration/tier repair does not establish the cause or resolution of this new report; do not describe it as recovered.

The installed preflight and native fake-upstream checks do not establish a successful replay of an existing long session, a real model call, a stable token-savings percentage, or a reasoning-quality improvement. Keep its own proxy/session state in the package's configured state location; do not merge it into a Solar plugin namespace.

## Dream Skin

The curated source is the local-folder wallpaper rotation candidate at [commit `2f6929c`](https://github.com/lisihao/dsh-dream-skin/commit/2f6929c6010c8bdc215ab0a23bda1ce7d3e11c3a), packed as `10.21.2-folder.2f6929c`. The source snapshot's package metadata still reports `10.21.1`, so this label is not a published `10.21.2` release. Use the exact published package or fixed source revision available from the project when installing.

After restart, open **设置 → 外观（Theme）**. The plugin contributes **皮肤**, **强调色**, **壁纸 / 高级壁纸**, **玻璃效果**, and **主题包** controls. These settings do not use model quota. **低功耗模式** is under **玻璃效果**; it disables the large wallpaper and glass blur surfaces and can be toggled without a restart. It is a switch for measuring or reducing rendering work, not proof of a particular GPU improvement.

For the folder rotation candidate, choose the local-folder image source under advanced wallpaper and provide a folder that you control. The host reads only that folder's immediate files; supported examples are `jpg`, `png`, `webp`, `gif`, `avif`, and `bmp`, while subfolders, HEIC, and SVG are excluded. Rotation is opt-in, supports a bounded interval from five minutes to seven days, and provides **立即换下一张**. Invalid links or unreadable images are skipped individually. No user wallpaper folder or image is included in the plugin package.

Skin and wallpaper preferences use browser `localStorage` plus the host-side `dream-skin.json`, so a refresh or desktop port change does not by itself erase them. The plugin uses official theme/token extension points and does not modify the official app bundle.

## Quota and model-request map

The following map is the practical rule for the visible controls in this guide. “No model request” means the action is a local read, save, or status operation; it does not promise that a provider is logged in. “May use quota” means the action is an explicit execution boundary and should be treated as cost-bearing until the provider's own accounting says otherwise.

| UI or tool action | Expected model/quota behavior |
|---|---|
| Handoff short task at or below 1,200 Unicode characters | No Luna summary call; the attributed task text is carried verbatim. |
| Handoff long-task summary, clarification generation, or explicit `/handoff retry` | May use the configured GPT-6 luna provider quota. `/handoff retry` permits one attempt; it does not run it until the handoff is prepared. |
| **取消交接，空白开始**; `/handoff status`; `/handoff fresh` | No new model request. Fresh keeps the selected model and old records but clears old model-visible task context. |
| **普通** / **智能协同** selection; **执行流程** open; node edit; **保存草稿** | No model request. Smart mode may be unavailable until Resident and required tools are reachable. |
| **刷新注册和任务状态**; **检查该任务状态** | Read-only status; no model request and no automatic resubmission. |
| **按此草稿再次执行**; **继续原执行（可能使用额度）** | Explicit execution/continuation boundary; may use the selected native provider quota. |
| **测试 Codex（使用订阅额度）**; **测试 Claude Code（使用订阅额度）** | Uses the corresponding native subscription quota only after the user clicks the button. |
| **刷新可用模型**; Web/Insight preference save or reload | Reads or persists settings; no prompt is sent. |
| `ChatGPT 网页算子` request | Sends a text-only request to the logged-in ChatGPT website and may use that account's quota. |
| `洞察分析` stage execution | May use Gemini and ChatGPT website quotas. It is experimental and has no successful end-to-end claim here. |
| `solar_rlm_run`; RLM `continue` / `refine` | Runs or continues Prime through the calling DSH provider and may use its quota. |
| `solar_rlm_inspect`; RLM `cancel` | No new model turn; an unknown native effect remains an observation/reconciliation case. |
| `solar_skill_search` | Reads a local scoped skill snapshot; no model call, skill execution or remote search. |
| billion-context compression | Occurs inside a real client model request; the plugin does not supply a free model call or guarantee savings. |
| Dream Skin settings, local-folder rotation, and low-power toggle | No model quota; local file reads and user-supplied image URLs are separate I/O. |

When an external effect is pending or unknown, inspect the original resource or command identity. Do not click a second execution button merely because the first acknowledgement has not changed; a cancellation request, a submission receipt, or a locally completed self-test is not proof of final success.

## Data and privacy boundary

Plugin-owned data uses namespaces under `$DSH_HOME/solar/` and versioned records. The skill-context adapter also appends standard, source-citing Session replacement events to the official log; it creates no private database and preserves original events. The main namespaces used by this guide are:

- `model-handoff/` for handoff receipts, route boundaries, summaries, and human answers;
- `native-collaboration/` for session mode, flow sources, drafts, runs, and delivery records;
- `native-resident/` for the Resident SQLite state, daemon-owned graph records, lanes, and bridge receipts;
- `chatgpt-web/` for Web preferences, Web run records, and Insight/provider snapshots;
- `rlm/` for Prime runs, selected-input snapshots, journals, checks, and runtime fingerprints;
- Dream Skin's browser storage and host-side `dream-skin.json` for theme and wallpaper preferences.

Native provider credentials, browser login state, and provider-owned transcripts stay with their respective products. The guide intentionally omits private account data, raw session identifiers, local log locations, and user file contents. A package or source README may describe more implementation detail, but those details do not enlarge the user's installation or quota authorization.

## What remains unverified

The V4 market index and release tags for these curated candidates are not published. The native plugins have source and bounded installed/read-only evidence, but no blanket claim of live Codex/Claude quality or indefinite autonomous execution. Web and Insight remain experimental after the unresolved `WEB_SUBMISSION_MISMATCH` recovery case; reading the original status without resending is the required next boundary. RLM's installed exact artifact proves a mechanism and local self-test only, not model quality or comparative benefit. billion-context's installed Solar fork proves its stated preflight/native test boundary only, not long-session efficacy. Dream Skin's folder rotation reads user-selected folders at runtime and does not distribute those folders with the package.

For the exact acceptance evidence, use the [native plugin contract](native-plugins-contract.md), [native verification record](native-plugins-verification.md), and each plugin's public README/source history linked above. Do not convert any of those source or keyless checks into a claim that the corresponding live feature has passed.
