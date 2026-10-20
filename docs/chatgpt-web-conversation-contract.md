# Conversation Web and Insight contract

User correction, 2026-10-20 (Asia/Shanghai). This contract supersedes the standalone-panel product scope. It does not invalidate the earlier narrow synthetic result; that result did not cover the user's intended conversation experience. Implementation and live acceptance of the corrected scope must be recorded separately.

## Product boundary

One Solar Web plugin provides two user entries. The existing operator transport and diagnostics are supporting capabilities, not the primary user path. The official application remains unmodified. No RLM, upstream patch, app build, automatic monitor, market publication or release is included.

1. In any ordinary Harness conversation, the existing model picker offers **ChatGPT 网页算子**. Selecting it uses the existing model-handoff plugin's canonical model-selection and compaction flow. Once handoff is confirmed, the next user message is answered through ChatGPT Web and displayed as a normal assistant Markdown response in that same Harness session. Returning to another model uses the same canonical selection path. Text-only coverage is explicit; unsupported attachments must stop before submission instead of silently disappearing.
2. New conversation offers the **洞察分析** preset through the official AgentPreset registry and existing new-session selector. This is a user-visible conversation mode, not a new unsupported `Session.type` field. Its scoped route stays on the Web workflow. Questions, answers, progress, errors and final output belong to that same Harness session.

Public rc.2 seams were inspected: `LlmAdapter`/`registerAdapter`/model catalogs, canonical `model/selection`, the existing handoff compaction implementation, `AgentPresetRegistry.register`, `conversation.hero.agentPreset`, and session-controller `agentPreset` creation. No private V3 model-worker or primary-menu registry is required. These declarations establish integration feasibility, not installed acceptance.

## Ordinary conversation

The LLM adapter projects the complete effective ordered request, including the handoff checkpoint and the current question, into a role-attributed text prompt. It preserves user constraints and language/style requests. It does not execute historical tool calls, forward an active DSH tool bridge or expose hidden reasoning. Unsupported inputs and oversize prompts fail before browser admission; no tail-only context truncation is allowed.

Each durable conversation request has a stable command identity derived from its session, message identities, complete input and exact selection. The adapter has no automatic provider retries. A completed original result can be replayed locally; unresolved effects can only be observed against the original task. The normal Agent loop writes and renders the returned assistant answer. No invented loop identities or plugin-defined Session event types are introduced.

The existing handoff plugin remains the owner of context conversion, user supplementation and its confirmation checkpoint. This feature does not make a second independent summary or bypass an unfinished/failed handoff. Its configured summary-model consumption remains distinct from Web consumption.

## Insight sequence

| Stage | Requested role | Output and gate |
|---|---|---|
| Clarify | Codex `GPT-6.1 Sol`, configurable | Combine the complete question, conversation context and versioned clarification template. Ask only missing material questions in the current conversation, retain exact answers and produce the research brief. Bound the rounds and native calls; an unresolved native run is inspected, not restarted. |
| Research plan | Gemini 4 Argon Deep Research | Verify actual website model and research mode, submit the complete brief once and collect the original plan. Show the plan and quota-sensitive start action before starting research. |
| Research | Gemini 4 Argon Deep Research | Observe the original research task until complete. Retain the complete report, links/citations, and only progress/query/thinking summaries actually exposed by the webpage. Missing provider evidence stays explicitly missing. |
| Critique and verification | ChatGPT `GPT-6 Astra Pro` Web | Transfer the complete report and original brief, require independent source checks, counterevidence, corrections and a substantive synthesis. Do not equate model agreement with verified truth. Preserve the complete original and revised artifacts. |
| Prose polish | Gemini 4 Argon, thinking level `high` | Edit the verified report into natural Chinese without inventing facts, deleting qualifiers or changing citations/numbers. Keep the pre-polish report; disclose or reject observable fidelity losses. |
| Delivery | Original Harness session | Render the complete final Markdown through the ordinary assistant output, retaining citations and a concise provenance/limitations statement. Distinguish stage completion from verified claims and measured research quality. |

The user-visible model names above are requested roles. Actual webpage model/mode/effort controls must be verified and recorded independently. Do not silently rename a `GPT-6` label to `GPT-6 Astra`, assume `Pro` equals another reasoning tier, or substitute an unavailable Gemini model. Where the website exposes only a family label, configure and disclose that exact family/effort pair rather than claim an unobserved backend identity.

Do not retrieve or manufacture a provider's hidden internal chain of thought. Preserve only its publicly displayed research activity and summaries, with their availability and completeness stated.

## Gemini quota fallback — confirmed by the user

The user selected **GPT-6 Astra Pro webpage search and analysis**, explicitly labelled as a **回落报告**; ChatGPT Deep Research is not the selected fallback.

- Fall back only on an explicit, stage-relevant Gemini quota-exhausted observation before submission, or a confirmed terminal quota failure with no original task still running. Keep the exact visible evidence and any reset information the website actually supplies. Missing counters do not mean zero quota.
- Do not fall back on a timeout, login challenge, selector failure, network error, missing receipt or unknown submission. Observe the original resource and retain the uncertain state. No replacement research is started while a Gemini effect may still be active.
- If Gemini research cannot start, run the research brief through a separate GPT Web search-and-analysis stage. Retain available Gemini partial material as partial, never as a completed Deep Research report. The subsequent critique uses a separate stage/conversation and is disclosed as the same provider; it is not claimed to be independent external validation.
- If Gemini quota is already exhausted, do not call it again merely to attempt polishing. The configurable GPT fallback can polish the verified draft; preserve the original draft. If GPT is also unavailable, pause and retain completed assets; do not bounce between providers or invent a final report.
- The final report names the actual path, including fallback, and describes the research mode's limits.

## Configuration and data

The plugin settings must expose exact Web labels/efforts, clarification executor/model, bounded clarification rounds, stage prompt templates, report language/style, research wait bound, size limits, and Gemini quota fallback policy. Requested defaults follow the roles above; availability is checked, not promised. Show dependency/model readiness separately from enabled state. Account credentials stay in the existing providers/browser; no copying logins into plugin configuration.

Template text, template version/hash, all filled values, full rendered input, user answers, requested and observed selections, stage resource identities, immutable revisions, original reports, visible research evidence, corrections, final text and uncertainties live only under `$DSH_HOME/solar/chatgpt-web/`. Existing text-operator records are not converted. The Insight store has its own explicit format version. Unknown versions are refused. Persist an external action intent before dispatch; use stable stage identities and stop automatic execution after an unknown effect. A local stop does not prove remote cancellation. Restart recovery first reconciles the original resources.

## Acceptance boundary

The implementation changes are scoped to `incubator/chatgpt-web`, its explicit build/probe wiring and relevant documentation. Preserve Native Resident, Collaboration, model-handoff, installed credentials, unrelated plugins and legacy data.

Required keyless checks cover public model/preset registration and disposal, real built-package loading, complete-context projection, stable command deduplication, normal assistant chunks, clarification/answer persistence, stage ordering, known-quota fallback versus unknown-effect fencing, complete artifact handoffs, template changes, restart observation and cancellation behavior. The stable full project gate is run once, then only affected checks after fixes.

Installed acceptance must exercise the actual model picker and original transcript, the new-conversation preset, settings, progress/questions and normal/narrow layouts. A previously passing standalone panel does not count. Live native/Web/Deep Research tests require a new bounded cost allowance; the earlier one-message allowance was fully used. Do not claim a faithful or usable full workflow from fake drivers, registry presence or source CI alone.

## Dynamic website choices

The [target-browser selection contract](web-model-selection.md) supersedes any earlier assumption that a test browser default or a compiled complete model label is an account-wide availability check. Runtime menu discovery supplies future model/effort options; explicit pins, target-browser current selection and immutable run observations remain distinct.
