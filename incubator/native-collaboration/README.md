# Native collaboration

Unreleased source candidate: `@lisihao/dsh-solar-native-collaboration`. It owns explicit native handoff, bounded native model allocation, session-scoped collaboration mode, and the conversation execution-flow editor. It uses the official Harness public seams and the separately installed native-resident service; it does not patch the application, duplicate the existing model-handoff plugin, or implement a second scheduler.

## Model-visible tools and ownership

`solar_delegate` sends a self-contained handoff to an explicitly chosen official Codex or Claude Code subagent, or submits one node to the optional `solarNativeResident` service. `solar_coordinate` validates a bounded TaskGraph, applies explicit or advertised native executor/model allocation, captures the resulting graph for the current session's flow view, and submits it to Resident. `solar_wait` provides bounded local observation of a submitted Resident graph; it does not turn a conversation into an unbounded polling loop.

The existing model-handoff plugin remains the owner of model selection, context conversion, user supplementation, its confirmation checkpoint, and compaction. This plugin invokes the published official subagent services and public Resident contract; it does not register a duplicate handoff path, change the DSH main model/account/provider, or silently switch accounts.

The handoff contains the executor, mode, working directory, declared read/write scope, task, expected result, and requested verification. Resident-only handoffs may also declare a stable `session_key`, a native `profile` (model/reasoning effort), and an explicit non-empty `dsh_tools` allowlist. Single mode rejects those fields because official one-shot providers do not accept arbitrary per-call model or tool overrides. The single route calls the published `ctx.subagents.startActivation()` API with the actual parent Agent, caller cancellation signal, and `delivery: "parent"`; its immediate result is an acknowledgement, while the official child runtime owns execution and terminal result delivery. Resident mode requires Resident, submits one durable graph node, and returns a graph reference for later observation. A submission acknowledgement is not final success.

`solar_coordinate` accepts graph JSON plus optional allocation hints (direct executor/model/effort, named profiles, role mappings, or per-node hints). Node selections take precedence over node profile hints, graph role/profile hints, configured role mappings/profiles, and finally deterministic selection from the Resident model catalog. Automatic assignment fails when the catalog is absent, unavailable, or cannot match the requested executor/model. An explicit executor/model may use that native selection without guessing; an explicit executor alone may use the executor's native default; an explicit reasoning effort must be advertised for the selected model. Allocation is a supported-selection policy, not a performance or quality claim.

When `dsh_tools` is supplied, Resident's public `bindBridge` capability receives the live calling Agent and exactly that allowlist before graph admission. No bridge endpoint, token, or arbitrary tool set is put in model arguments or graph data. Without `dsh_tools`, no DSH tools are exposed to the native graph.

## Conversation paths

The client contribution is session-aware and uses these official UI labels:

- The conversation header shows **`协同模式`** with **`普通`** and **`智能协同`**. The selection is persisted for that session and uses a compare-and-swap revision. Changing it alone performs no model request. `普通` removes the smart system-policy section; `智能协同` adds the logged coordinator policy only for that session.
- Smart selection has a readiness fence. The selected main provider must not be `solar-chatgpt-web`; Resident must be reachable; and `solar_coordinate`, `solar_resident`, and `solar_wait` must be available to the current Agent. A failed readiness check is surfaced and does not silently fall back to ordinary or one-shot execution.
- The conversation view is **`执行流程`**. It shows only the current session's captured sources, drafts, and runs. Sources can come from native graphs, `ChatGPT 网页算子`, or `洞察分析`; the editor never substitutes a machine-wide task list.
- Settings contributes **`协同诊断`**. It reports Resident and official provider/tool registration, refreshes current status without model execution, lists Resident task graphs, and exposes the explicit quota-labelled checks **`测试 Codex（使用订阅额度）`** and **`测试 Claude Code（使用订阅额度）`**. A pending check uses **`检查该任务状态`**; the UI does not auto-resubmit an unknown request.

The `执行流程` canvas supports node layout, edge add/remove, node add/remove, prompt edits, supported model/effort/executor fields, and JSON parameters/metadata. Node positions are layout only. A source is immutable; selecting it forks a new unsaved draft. `保存草稿` validates and persists the exact revision. `按此草稿再次执行` captures that graph under a new command identity and may consume provider quota. `继续原执行（可能使用额度）` instead keeps the original command and frozen graph, first reconciles the original effect, and may advance only unadmitted stages. It does not execute the edited draft. If the same command is already pending or uncertain, the editor inspects the original command instead of creating a replacement. A changed draft cannot reuse the source result, and an old run is never edited in place. While the original main conversation request is still waiting for its result, continuation is rejected so it cannot take over delivery and enqueue a second answer.

The editor writes a completed result back to the originating session only after the run and output are durable. The queued delivery instructs the main model to inspect and summarize saved evidence; it does not generate another TaskGraph, repeat dispatch, or re-run the workflow. A historical user message that happens to reuse the delivery wording is not trusted as a completed workflow record.

## Persistence and provenance

Session mode records live below `$DSH_HOME/solar/native-collaboration/` as `session-mode-<sha256(sessionId)>.json`. They use format version `1`, embed the exact session id, store `revision` and `mode`, and reject unknown/corrupt versions. A selection must use the exact current revision; stale selections raise a named revision conflict.

The shared workflow editor uses `$DSH_HOME/solar/native-collaboration/workflow-studio/` with `STUDIO_STORE_FORMAT_VERSION: 1`. Its append-only namespaces are `sources/<sessionId>/<sourceId>/`, `drafts/<sessionId>/<draftId>/`, `runs/<sessionId>/<commandId>/`, `delivery/<sessionId>/<commandId>/`, and coordination locks under `locks/<sessionId>/`. Each version directory contains contiguous JSON revisions beginning at `0.json`; source graphs, draft graphs, run command identities, session ownership, and prior provider outputs are immutable across later revisions. An active or unknown run for the same logical source requires inspection and coordination before a replacement run is admitted.

Captured run records preserve the exact graph, requested and observed provider/model selection, phase/node state, rendered inputs, raw visible output, and provider provenance. Web and Insight artifacts retain source, visible evidence, citations, limitations, fallback state, and same-provider-review disclosure. Native graph records remain owned by Resident; this store does not copy native credentials or transcripts.

The normal Web and Insight adapters persist their provider-specific snapshots below `$DSH_HOME/solar/chatgpt-web/`; the split is intentional: session mode and shared source/draft/run ownership are Collaboration state, while provider execution details belong to the Web plugin. No legacy DSH 3.x database or session is imported.

## Retry and unknown-effect boundary

Submission is separated from observation. A stable command identity is persisted before provider admission. Identical submissions reconcile the original record; changed input under that identity conflicts. An unresolved native/Web/Insight effect is marked unknown or indeterminate and is never automatically replayed, switched to another provider, or hidden behind a successful acknowledgement. `solar_wait` bounds local observation; it does not cancel remote work when the local wait ends.

Known terminal failures and explicit, bounded retry policies remain provider-specific. The Web route uses no automatic retries. Insight only permits the configured `GPT-6 Astra Pro Web search and analysis` fallback after exact quota-exhausted evidence with `no-active-effect`; timeout, login, selector, missing receipt, network, and unknown results remain unresolved. Native retry and predecessor-input rules are owned by Resident.

## Configuration and verification boundary

The profile patch mounts the bundle with defaults:

```yaml
- id: native-collaboration
  name: '@lisihao/dsh-solar-native-collaboration'
```

Validated `Config` fields are `codexProvider`, `claudeCodeProvider`, `toolName`, `coordinateToolName`, `allocationProfiles`, and `roleMapping`. Defaults are `codex`, `claude-code`, `solar_delegate`, and `solar_coordinate`; provider ids refer to already registered public services. Resident is optional for loading and single mode, but smart mode, flow execution, native graph capture, controls, and the two canaries require protocol version `1` under `solarNativeResident`.

The source has focused keyless tests and built-package wiring, but this candidate has no current installed-app or full real-provider acceptance claim. The historical one-message `GPT-6 / medium` synthetic Web canary belongs to an earlier standalone candidate and does not cover this session workflow. The present documentation change makes no paid model call; the explicit Codex and Claude buttons remain future user-authorized quota-consuming checks. RLM, recurring monitoring, upstream patches, Desktop builds, releases, and market publication are outside this plugin.
