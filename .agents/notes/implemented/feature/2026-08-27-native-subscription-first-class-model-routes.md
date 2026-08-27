# Agent Note: Native-subscription products as first-class model routes

Status: implemented

English | [中文](2026-08-27-native-subscription-first-class-model-routes.zh.md)

## Problem

DSH already had one-shot Codex and Claude Code subagent Providers and a durable Resident physical-operator layer. Neither made a native subscription a complete main-model replacement: the ordinary Agent Loop still needed another LLM route to decide and delegate, first-run onboarding still assumed an official DeepSeek key, and a Resident product received only a standalone text task rather than the current Agent's assembled system instructions and DSH tools. A user with a valid Codex or Claude subscription could therefore execute a boxed worker but could not run DSH without a metered API route.

The collaboration Trace also treated these routes inconsistently. A direct Resident result appeared only as a truncated assistant preview, bridged DSH tools were absent, and an ordinary subscription subagent's model-visible tool result was not projected beside routing and TaskGraph events.

## Decision

`@deepseek-ai/dsh-tool-physical-operator` owns an LLM adapter route named `dsh-physical-operator`. Every currently available Resident Codex or Claude Code descriptor becomes one selectable model on that route. Selecting it makes the native product the current Agent's model for the ordinary Agent Loop; it is not a hidden parent model invoking `physical_operator` and it sends no DeepSeek request.

Before dispatch, the Consumer assembles the exact current DSH system prompt and model-visible Tool schemas. It binds those schemas to one owner-local model-tool socket and sends the sealed descriptor with the Resident request. Protocol v9 carries both the system prompt and tool descriptor. Claude Code receives the former as an append to its native preset and the latter through an in-process Agent SDK MCP server; Codex receives developer instructions plus app-server dynamic tools. Calls return to the original Agent's `ctx.tools`, so scope, guards, approval, logging, plugin ownership, and rendering remain DSH-owned.

The bridge appends ignorable `physical-operator/tool-call` and `physical-operator/tool-result` Session events. A receipt keyed by the native call identity and canonical request hash is reconstructed from those events after DSH reload. Repeating the same settled call returns its result; changing the request conflicts. A call event without a matching result is indeterminate and is never replayed automatically, so a DSH crash cannot silently repeat a tool side effect.

RLM remains a distinct sealed surface. A bridge containing only `typescript_repl` keeps the Prime-compatible RLM isolation and does not inherit the generic DSH tool catalog. Ordinary first-class model turns receive the full current catalog. Product-private reasoning and raw terminal text never enter the DSH Session.

The Models onboarding join now includes `llm.models`. Any executable native-subscription route satisfies product readiness, so missing DeepSeek credentials no longer block a user whose Codex or Claude Code route is qualified. DeepSeek API models remain optional peer routes.

The Governance Trace projects one session lineage consistently: routing and dispatch events, exact main-model final text, every bridged DSH tool call/result, ordinary `subagent_codex`/`subagent_claude_code` call/results, and TaskGraph Evidence. TaskGraph terminal events keep a bounded preview, and an authenticated user can load the complete digest-verified model-visible Evidence on demand. Reasoning blocks are removed.

## Authority and lifecycle

- The DSH Agent Loop still owns turns, steps, prompt assembly, Tool Runtime, Session events, and UI projection.
- `dsh-resident-operatord` remains the only Resident Receipt/Lease/Session writer and owns native continuation across DSH/Desktop restart.
- Codex and Claude Code remain authoritative for their native product session or thread and subscription authentication.
- TaskGraph remains the only multi-node Scheduler. Main-model routing and the model-tool bridge do not create a queue or second scheduler.
- The owner-local bridge exists only while a DSH Host is attached. A Resident native turn survives a Host restart, but DSH-owned tool calls wait or fail until the Host reattaches; built-in product tools remain product-owned.

## Verification

Offline composition tests mount the real Agent Loop seams with no DeepSeek adapter. Separate Codex and Claude fixtures select the native subscription route as the first model. The Codex fixture executes a real registered DSH Tool through JSON-RPC and asserts the exact tool result and Session events; the Claude fixture proves its route receives the same assembled system and catalog contract. Reload coverage repeats one settled native call after bridge remount and proves the DSH Tool executes once. Protocol, driver, onboarding, digest-verified Evidence reading, host/client typecheck, and Governance Trace tests run without product credentials or subscription calls.

Release acceptance adds exactly one minimal real Codex subscription main-Agent canary and one minimal real Claude Code subscription main-Agent canary from the installed Desktop build. Each must prove native-subscription qualification, no DeepSeek key or request, one DSH Tool invocation, exact Trace output, persistent continuation, and source/package/running-version identity.

## Consequences

Codex and Claude Code can drive DSH as first-class models, planners, TaskGraph workers, or ordinary subagents. Subagent mode remains useful for isolated delegation but is no longer the only integration role. The native products gain DSH's plugin-composed system and tool surface without copying the Agent Loop into either Provider, while DeepSeek stays available as a peer when configured.

The first release still accepts text-only Resident prompts, has no native token-usage mapping for the first-class adapter, and does not provide a remote model-tool bridge. Those limitations must be shown rather than described as full parity with every API adapter feature.
