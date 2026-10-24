# ChatGPT Web, Grok and Insight provider

Unreleased source candidate: `@lisihao/dsh-solar-chatgpt-web`. It uses the official Harness unchanged and the separately installed Ego Lite browser. This README describes the current source contracts and candidate user paths. It does not claim current installation, a complete real-provider run, or full real `洞察分析` acceptance.

## Current user paths

### `ChatGPT 网页算子`

In an ordinary Harness conversation, select the model shown as **`ChatGPT 网页算子`** through the existing model-selection and model-handoff path. The existing model-handoff plugin remains the owner of context conversion, user supplementation, its confirmation checkpoint, and compaction. This plugin supplies the public `solar-chatgpt-web` route after that handoff; it does not implement a second handoff plugin or a competing account/model route.

The route accepts a text-only request and returns the visible webpage answer as the ordinary assistant response in the same Harness session. Before serializing the logged request boundary, it makes a pure browser-portable projection: it excludes only the marked Harness system envelope and marked catalog/snapshot/recall background that the webpage operator cannot regenerate. It also excludes the exact automatic `solar-skill-context` discovery notice, whose native skill-search instructions do not apply to the webpage operator. It retains ordered user, model, tool, compact-checkpoint, task notice/relay, explicit workspace-instruction, unknown-source, and request-only user content verbatim. This is neither a semantic summary nor a provider fallback, and it never tail-truncates retained context. Explicit one-shot `system` text and any retained oversized input still fail before browser admission; the error reports only per-section byte counts. The route does not execute historical tool data, forward an active DSH tool bridge, or silently discard unsupported image/file inputs. The explicit `solar_chatgpt_web` operations remain supporting run/observe/cancel controls, not a replacement conversation panel.

Ordinary requests use native plain-text paste into the empty editor, followed by exact draft and submission receipt checks. The adapter does not use generic contenteditable fill, which was observed to change Markdown serialization on the live site. Preparation and catalogue processes have a bounded outer budget of `min(2 * commandTimeoutMs, 120000)` to cover multiple navigation/menu operations; individual DOM waits retain `commandTimeoutMs`. Other commands keep their existing budget.

Request-audit notices remain in the session log but are excluded from the browser prompt and command identity. Native graph-memory snapshots and Mnemon tool instructions are also excluded by their exact source/form classification; explicit user text and Insight decisions remain. This prevents another plugin's error retry from turning the same logical request into a fresh browser submission. A globally installed retry hook can still repeat local error handling even when this provider advertises `maxRetries: 0`; durable command identity is the external-effect boundary.

The observed optimistic `/c/local-chatgpt%3A<uuid>` URL may finalize to a same-origin `/c/<uuid>` on the original page only after the exact submission receipt and requested selections match. This also permits observation-only recovery of an already persisted optimistic URL. Other conversation changes remain a named failure.

The browser is an external dependency. A task requires an available Ego Lite CLI, an agent-owned TaskSpace, and a logged-in empty ChatGPT conversation. Login prompts, user takeover, existing drafts/attachments/conversations, unknown model labels, and unavailable requested labels stop before submission. The plugin does not download the browser or copy browser credentials.

### `Grok 网页算子`

Select **Grok 网页算子** in the normal model picker, then enter a text question in
Harness. This independent route uses the signed-in Grok account in Ego Lite;
login remains manual. The companion model-handoff candidate recognizes
`solar-chatgpt-web/grok-web` as a webpage operator: entering it starts a fresh
operator task without Luna; returning to an ordinary model asks separately
about operator results and the earlier task context.

The default `grokModelLabel: ""` follows the target Grok page's visible selection.
An optional exact label can be configured on the Host plugin row. Recorded
picker labels are `Auto`, `Fast`, `Expert`, `Build`, and `Heavy`; the adapter
checks the actual option and checked state at execution, including any visible
subscription restriction, and never substitutes a model. The ChatGPT catalogue
refresh and its model/effort settings do not configure Grok.

A request uses one fresh Grok TaskSpace, a flushed pre-send intent, and at most
one submit attempt. Only an exact original-question receipt followed by one
matching visible text reply, non-busy transcript, Copy control, and repeated
stable observations can complete it. Existing or uncertain commands only
observe the recorded original page; missing or mismatched receipts are errors,
not permission to send again. Ordinary visible text is supported; Canvas/media
contents are not claimed as a complete text reply. There is no Grok Studio
research node in this candidate.

The no-model site observation confirmed login, existing-message containers,
model picker states, and one separately authorized draft-only enabled Submit
control. The draft was cleared, zero new messages remained, and the dedicated
space was normally finished. No new Grok reply or end-to-end generation was run.
See [design and evidence boundary](../../docs/integrations/grok-web.md).

### `洞察分析`

The plugin registers the `洞察分析` model/preset through the public `AgentPresetRegistry` and the existing new-session/model-selection surfaces. The source workflow is durable and editable: bounded clarification and questions, Gemini plan, explicit plan confirmation, Gemini research, ChatGPT Web verification, Gemini prose polishing, and delivery back to the originating Harness conversation. The selected main model remains the conversation coordinator; a completed workflow result is queued for checking and delivery and is never silently executed again.

The requested stage roles and actual website observations remain separate. No-model Gemini observations recorded the exact `4 Argon` picker entry, the `Deep Research` toggle, the `high` → visible `高` thinking selection/readback, the visible original-question path, the plan widget, and the completed-report body/toolbar/source shape. One separately authorized draft-only observation also established one visible enabled Send control and cleared the draft afterward; it did not send, create a receipt, or start research. A historical report page also exposed one visible but disabled **开始研究** control, which records its locator but not clickability. The adapter rechecks every control as unique, visible, and enabled at execution time. Its default readiness therefore means only that normal page preflight may begin; it is not a live Gemini acceptance. A new-plan research start and the complete Insight chain remain unrun. The `GPT-6 Astra Pro Web search and analysis` fallback availability is also unverified. The fallback is legal only after stage-relevant visible quota evidence establishes that no original Gemini effect is active; timeout, login, selector, network, missing-receipt, and unknown outcomes are not quota evidence. A fallback is labelled as a `回落报告`, not as ChatGPT Deep Research.

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

Settings contributes **`网页与洞察`** with separate **`网页回答`** and **`洞察分析`** tabs. The ordinary view shows model and reasoning controls with a compact browser summary; manual labels and catalogue queries are collapsed. Insight stages expand individually for model/template editing, with full JSON and Gemini selectors in a separate advanced disclosure. The Insight tab also states whether the whole flow can enter page preflight and names every missing semantic control. It distinguishes configuration from a live webpage acceptance and never treats a saved selector as proof. New ordinary Web settings leave model/effort empty to follow that target browser's current choice; existing saved values remain unchanged. Saving uses the exact preference revision and affects new runs only; a prepared request and a saved execution keep their own snapshots.

The profile fields are `executablePath`, `taskSpaceId`, `commandTimeoutMs`, `runTimeoutMs`, `pollMs`, `maxOutputBytes`, `modelLabel`, `effortLabel`, and optional `grokModelLabel`. Defaults are an absolute `~/.local/bin/ego-browser` path resolved for the current home, `taskSpaceId: 0`, `commandTimeoutMs: 25000`, `runTimeoutMs: 1800000`, `pollMs: 2000`, `maxOutputBytes: 1048576`, and empty configured labels. `runTimeoutMs` remains configurable from 10000 to 7200000 ms. The 30-minute default replaces the former five-minute wait, which was shorter than the observed live Pro analysis. These are local bounds and defaults, not provider latency or capability claims.

Website labels are preserved exactly. A visible `GPT-6` label is not renamed to `GPT-6 Astra`; `effortLabel` records the observed visible reasoning label and optional `effortId` independently records the website identifier, without assuming that Pro maps to a fixed identifier. An empty configured label means to use the page's observed selection. A requested label that the page does not expose is a named failure, not permission to substitute another model. Catalogue refresh restores the original slider position, range, visible label and raw identifier: different positions can share a raw identifier, so restoring by that identifier alone is insufficient.

Optional `geminiSemantics` is accepted only as explicitly observed website selectors/markers. It is stored as configuration evidence, not proof that Gemini Deep Research or any particular model is available. Built-in no-model observations cover the fixed 4 Argon/Deep Research/high route, visible Send readiness, visible receipt/report checks, and the recorded research-start locator. The latter must still be uniquely visible and enabled at the actual new-plan boundary.

## Persistence, provenance, and retry boundary

The plugin's own root is `$DSH_HOME/solar/chatgpt-web/`.

- Web task records are append-only UUID directories containing contiguous revision files (`0.json`, `1.json`, …). Each `WebRunRecord` uses format version `1`, stores the complete text request, requested and observed labels, original TaskSpace/page/conversation identity, output or named error, and a revision. The store rejects unknown versions and revision gaps. The Web route has an explicit no-auto-retry policy (`maxRetries: 0`); after `submission-unknown` or `indeterminate`, only observation of the original resource is allowed.
- `grok-web/` contains separate format-1 append-only Grok revisions with CAS, full request, original page, requested/observed model, pre-send intent, receipt/reply identity and hashed visible text output. Unknown formats and identity conflicts are refused. No ChatGPT record is treated as a Grok result.
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

Catalogue discovery uses a bounded whole-process budget of twice `commandTimeoutMs`, capped at 120,000 ms, while every individual DOM wait keeps `commandTimeoutMs`. At the default 25,000 ms setting, the aggregate discovery/restoration budget is 50,000 ms. The other browser operations retain their existing budgets. A retained empty-page trace required 29,314 ms for the full catalogue and exact Pro restoration, exceeding the former 25,000 ms process limit. This is timing evidence from that observed page, not a guarantee for other pages or accounts.

### Post-send receipt propagation (2026-10-21)

A send click is performed at most once. If its immediate observation has no user or assistant message and no visible login/page error, the adapter now allows up to five seconds of read-only DOM observation, bounded by the remaining original submit-command budget. Existing conversation identity is kept exact; a new root page may transition once to a same-origin conversation. A different message, ambiguity, error or changed route returns immediately to strict controller validation. This does not retry Send, relax prompt matching, extend every command timeout, or claim a missing remote request failed. Numeric-only mismatch diagnostics retain message counts and normalized character lengths without prompt/output content.

A real request reported `WEB_SUBMISSION_MISMATCH`; the user reported no browser intervention, but the original TaskSpace was absent at the later inspection. Its original page observation was not retained, so the exact cause and external outcome remain unknown. Code inspection found the prior single-observation timing gap; generated-script tests demonstrate that the bounded observation fixes delayed message rendering. They do not prove that this gap caused that real request or explain the original TaskSpace disappearance. No real prompt was resent for this repair.

The bounded receipt-observation runtime was installed on 2026-10-21 from source `c165a3a`, with all 54 packed files verified and the official App/Host restarted. No prompt was resent. Its real post-repair answer path remains untested; startup and source checks do not recover the earlier unknown result.


### Resolving a retained `WEB_BUSY` task (2026-10-22)

A new ordinary-conversation request is blocked before browser creation while an older Web run remains unresolved. `WEB_BUSY` now directs the owner to the existing Web task records. First use **读取最新状态** to reconcile the original TaskSpace; this never resubmits it. If the original result cannot be recovered, an idle `indeterminate` record offers **结束本机跟踪** and a separate **确认结束本机跟踪** action. The confirmation explicitly acknowledges that the remote outcome remains unknown. It does not cancel the remote model, retry the old command, or certify that the old request never ran.

The owner-only Remote operation takes the observed revision and explicit acknowledgement. It rejects an active local operation, a stale revision, malformed input and a different fence owner. It appends a terminal `abandoned` revision, preserving the original request, resource and prior revisions, and releases only its own unchanged fence lease. The ordinary model adapter still reports this old outcome as unknown rather than success. A new command is a separately admitted request; reopening the retired command never creates or submits a page. No timeout-based automatic lock deletion was added.


### Inline-code receipt repair — 2026-10-23

User-message receipts restore delimiters around visible inline `code` elements. Flattening those elements to plain text lost the Markdown backticks, which could make an otherwise matching prompt fail exact receipt validation. Literal text, line endings, surrounding whitespace, hidden/control filtering, message counts and the controller's exact comparison are unchanged. The observer does not reconstruct block Markdown or infer content that is absent from the DOM.

A synthetic 8,675-character prompt with 15 inline-code spans reproduces a 30-character loss in the previous observer and passes with the repair. With explicit read-only approval, the retained ChatGPT conversation was recovered in a diagnostic space after its original TaskSpace disappeared. Its single user message contained 15 inline-code spans: the old observer read 8,645 characters, while the repaired observer read all 8,675 characters and matched the stored request exactly. The page already contained the requested canary answer, which the original DSH run had not accepted. This read-only recovery made no new model call. New installed end-to-end acceptance is recorded separately after execution. No old request is resubmitted by this repair.
