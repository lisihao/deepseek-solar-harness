# ChatGPT Web and Insight provider

Unreleased source candidate: `@lisihao/dsh-solar-chatgpt-web`. It uses the official Harness unchanged and the separately installed Ego Lite browser. This README describes the current source contracts and candidate user paths. It does not claim current installation, a complete real-provider run, or full real `洞察分析` acceptance.

## Current user paths

### `ChatGPT 网页算子`

In an ordinary Harness conversation, select the model shown as **`ChatGPT 网页算子`** through the existing model-selection and model-handoff path. The existing model-handoff plugin remains the owner of context conversion, user supplementation, its confirmation checkpoint, and compaction. This plugin supplies the public `solar-chatgpt-web` route after that handoff; it does not implement a second handoff plugin or a competing account/model route.

The route accepts a text-only request and returns the visible webpage answer as the ordinary assistant response in the same Harness session. Before serializing the logged request boundary, it makes a pure browser-portable projection: it excludes only the marked Harness system envelope and marked catalog/snapshot/recall background that the webpage operator cannot regenerate. It retains ordered user, model, tool, compact-checkpoint, task notice/relay, explicit workspace-instruction, unknown-source, and request-only user content verbatim. This is neither a semantic summary nor a provider fallback, and it never tail-truncates retained context. Explicit one-shot `system` text and any retained oversized input still fail before browser admission; the error reports only per-section byte counts. The route does not execute historical tool data, forward an active DSH tool bridge, or silently discard unsupported image/file inputs. The explicit `solar_chatgpt_web` operations remain supporting run/observe/cancel controls, not a replacement conversation panel.

The browser is an external dependency. A task requires an available Ego Lite CLI, an agent-owned TaskSpace, and a logged-in empty ChatGPT conversation. Login prompts, user takeover, existing drafts/attachments/conversations, unknown model labels, and unavailable requested labels stop before submission. The plugin does not download the browser or copy browser credentials.

### `洞察分析`

The plugin registers the `洞察分析` model/preset through the public `AgentPresetRegistry` and the existing new-session/model-selection surfaces. The source workflow is durable and editable: bounded clarification and questions, Gemini plan, explicit plan confirmation, Gemini research, ChatGPT Web verification, Gemini prose polishing, and delivery back to the originating Harness conversation. The selected main model remains the conversation coordinator; a completed workflow result is queued for checking and delivery and is never silently executed again.

The requested stage roles and actual website observations remain separate. Gemini Deep Research selectors, the requested Gemini model/mode, and the `GPT-6 Astra Pro Web search and analysis` fallback availability are unverified in the current source state. The fallback is legal only after stage-relevant visible quota evidence establishes that no original Gemini effect is active; timeout, login, selector, network, missing-receipt, and unknown outcomes are not quota evidence. A fallback is labelled as a `回落报告`, not as ChatGPT Deep Research.

### Conversation mode and coordination

The native-collaboration client contributes the session-header control **`协同模式`** with **`普通`** and **`智能协同`**. Mode selection is session-scoped and persisted; choosing a mode alone performs no model request. `普通` leaves the ordinary conversation path available. `智能协同` is admitted only when the current main route is not `solar-chatgpt-web`, Resident is reachable, and the current session has `solar_coordinate`, `solar_resident`, and `solar_wait` available.

In smart mode, the selected main model remains responsible for understanding, planning, coordination, evidence checks, and final delivery. Suitable complex work is submitted as a bounded Resident TaskGraph through the existing collaboration tools. The coordinator first submits, then uses bounded `solar_wait` observation and reads the actual Resident terminal state; a submission receipt is not task success. Long waits do not become an unbounded model-polling or `turn-stopping` loop. Unknown or indeterminate effects are observed and reconciled by their original identity, never automatically replayed or moved to another account/provider.

## Execution Flow view

The native-collaboration client contributes the conversation view **`执行流程`**. It shows only the current session's sources, saved drafts, and runs; it is not a machine-wide task list. A source may come from a captured `ChatGPT 网页算子`, `洞察分析`, or native graph execution. Selecting a source creates a new unsaved draft with the same logical graph; the source's observed run remains the source-version result.

The canvas supports node layout, dependency edges, node add/remove, prompt and supported execution-property edits, and JSON parameters/metadata. Node positions are layout only. Provider, model, effort, executor, prompt, edges, context, and other supported execution fields define the executable graph; free-form metadata is retained but is not executable code. The editor rejects duplicate, missing, or cyclic edges before save/run.

`保存草稿` validates and writes the exact draft revision. `按此草稿再次执行` captures that immutable graph snapshot under a new command identity and may consume configured quota. `继续原执行（可能使用额度）` instead keeps the original command and frozen graph, first reconciles the original effect, and may advance only unadmitted stages. It does not execute the edited draft. A changed draft must be saved first. If the command already has a pending or uncertain record, the same command is inspected; the UI does not create a replacement command automatically. Earlier source and run records remain immutable. A source result is not presented as the result of a modified draft. While the original main conversation request is still waiting for its result, continuation is rejected so it cannot take over delivery and enqueue a second answer.

The flow view also distinguishes `来源运行（对应原版本）`, `草稿已修改，尚未执行`, and `此草稿的已保存版本`. Refreshing the current session or checking a source reads the original record; it does not submit a new model request.

## Settings and diagnostics

The native-collaboration client contributes the Settings section **`协同诊断`**. It reports the local `solarNativeResident` connection, official one-shot provider registration, and `solar_delegate` / `solar_coordinate` / `solar_wait` registration. `刷新注册和任务状态` reads the current status and existing Resident graphs without model discovery or model execution. The two explicit checks **`测试 Codex（使用订阅额度）`** and **`测试 Claude Code（使用订阅额度）`** submit text-only canaries only after the user clicks them; each uses its corresponding native subscription quota and supplies no DSH tool bridge or file-write scope. A pending or unknown check exposes `检查该任务状态`; the UI does not resubmit it automatically.

The settings status separates registration from login and execution. A registered provider is not evidence of credentials, a completed native check is not evidence of arbitrary task correctness, and a flow submission is not evidence of final acceptance.

## Configuration and exact labels

Model and reasoning choices are discovered from the plugin's target Ego Lite browser, independently of Chrome. **刷新可用模型** reads current model choices and the selected model's effort options without sending a prompt. Newly added choices can be selected and saved without a plugin release while the menu contract remains compatible. Cached choices do not replace per-request verification. See [selection contract](../../docs/web-model-selection.md).

Settings contributes **`网页与洞察`** with separate **`网页回答`** and **`洞察分析`** tabs. The ordinary view shows model and reasoning controls with a compact browser summary; manual labels and catalogue queries are collapsed. Insight stages expand individually for model/template editing, with full JSON and Gemini selectors in a separate advanced disclosure. New ordinary Web settings leave model/effort empty to follow that target browser's current choice; existing saved values remain unchanged. Saving uses the exact preference revision and affects new runs only; a prepared request and a saved execution keep their own snapshots. Deep Research selector configuration is maintenance data and remains unaccepted until observed on the real site.

The profile fields are `executablePath`, `taskSpaceId`, `commandTimeoutMs`, `runTimeoutMs`, `pollMs`, `maxOutputBytes`, `modelLabel`, and `effortLabel`. Defaults are an absolute `~/.local/bin/ego-browser` path resolved for the current home, `taskSpaceId: 0`, `commandTimeoutMs: 25000`, `runTimeoutMs: 300000`, `pollMs: 2000`, `maxOutputBytes: 1048576`, and empty configured labels. These are local bounds and defaults, not provider latency or capability claims.

Website labels are preserved exactly. A visible `GPT-6` label is not renamed to `GPT-6 Astra`; `effortLabel` records the observed visible reasoning label and optional `effortId` independently records the website identifier, without assuming that Pro maps to a fixed identifier. An empty configured label means to use the page's observed selection. A requested label that the page does not expose is a named failure, not permission to substitute another model. Catalogue refresh restores the original slider position, range, visible label and raw identifier: different positions can share a raw identifier, so restoring by that identifier alone is insufficient.

Optional `geminiSemantics` is accepted only as explicitly observed website selectors/markers. It is stored as configuration evidence, not proof that Gemini Deep Research or any particular model is available.

## Persistence, provenance, and retry boundary

The plugin's own root is `$DSH_HOME/solar/chatgpt-web/`.

- Web task records are append-only UUID directories containing contiguous revision files (`0.json`, `1.json`, …). Each `WebRunRecord` uses format version `1`, stores the complete text request, requested and observed labels, original TaskSpace/page/conversation identity, output or named error, and a revision. The store rejects unknown versions and revision gaps. The Web route has an explicit no-auto-retry policy (`maxRetries: 0`); after `submission-unknown` or `indeterminate`, only observation of the original resource is allowed.
- `preferences.json` uses `WEB_PREFERENCES_FORMAT_VERSION: 1` and a CAS `revision`. It stores web labels, version-1 Insight configuration/templates, size limits, and optional observed Gemini semantics. Concurrent or unknown preference writes are rejected; credentials and browser login state are not copied here.
- `studio-executions/` stores the Web and Insight provider execution snapshots with `STUDIO_EXECUTION_FORMAT_VERSION: 1`. Each captured run freezes the exact graph, command id, draft revision, rendered phase inputs, node/phase state, and full provider artifacts. Artifacts retain provider/source, visible evidence, citations, limitations, fallback and same-provider-review provenance. The source/draft/run records shared with the editor live in native-collaboration's workflow store; the Native Resident graph remains in its own plugin namespace.
- Insight stage configuration and run records preserve requested versus observed selection, versioned template text and SHA-256 template hash, full rendered input, resource identity, answers, complete visible artifacts, quota evidence, and limitations. Hidden chain of thought is never requested or stored.

The Insight controller retries neither unresolved external effects nor a changed command. It can inspect the original resource, mark a stage `unknown`, or accept a known terminal quota-exhausted outcome with `certainty: no-active-effect`. Only then may the configured Gemini fallback be admitted. A local wait cancellation does not prove that the browser or remote provider stopped.

The Resident side of a native flow uses its separate `$DSH_HOME/solar/native-resident/` SQLite namespace and schema version `2`; TaskGraph/graph/node contracts remain format version `1`. See the native-resident README for `inputFrom` predecessor-output rendering and native retry rules.

## Verification boundary

The resumed 2026-10-20 candidate passed 384 keyless tests, build, strict types, built plain-Node CLI probes and the homepage gate. Live costless Ego catalogue discovery and explicit Pro preparation passed without a prompt being filled or sent; the original Pro position was verified after inspection. Settings was rendered and exercised at normal and narrow widths. See [current verification](../../docs/web-model-selection.md#resumed-acceptance--pro-and-settings). It has not established current installed-app acceptance or a complete real-provider `洞察分析` run. A previous candidate had one synthetic text-only GUI canary at `GPT-6 / medium`; that historical one-message result does not cover the current conversation route, session mode, execution-flow editor, or full Insight sequence. This documentation change makes no paid model call and does not consume Codex, Gemini, or Claude quota. The explicit Claude button remains a future user-authorized, quota-consuming check.

RLM, recurring monitoring, upstream patches, Desktop builds, releases, and market publication are outside this README's scope.

### Catalogue failure diagnostics

Explicit model-catalogue refresh reports whether creating the target, reading its controls, or finishing the owned target failed. Named `WEB_`/`EGO_` error codes survive ordinary remote error serialization; a cleanup failure retains the original failure as well. Diagnostic text does not include adapter messages, process stderr, page contents, account data or paths. No automatic retry is added. A generic browser-command error alone is not evidence of a network, quota or PATH cause.
