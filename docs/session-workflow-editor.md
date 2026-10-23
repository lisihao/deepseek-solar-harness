# Conversation collaboration and editable execution flows

Status: implementation authorized on 2026-10-20. This extends the existing Native and Web extraction task. It does not authorize new paid probes, recurring jobs, merge, market publication, or modifications to the official app.

## Observable acceptance and affected paths

In an existing Harness conversation, selecting Smart Collaboration must affect subsequent requests, produce a dependency-linked TaskGraph for suitable work, delegate through Resident, and return reviewed results to that conversation. Ordinary conversation behavior remains available. The selected main model remains the coordinator.

The conversation's Execution Flow view must show its own Native, ChatGPT Web, or Insight execution flow, rather than a machine-wide status list. A user can pan/zoom, drag nodes, add/remove dependency edges, select/add/delete nodes, edit prompts, supported execution properties and JSON metadata, save a versioned draft, and explicitly run that draft as a new execution. Editing and refreshing do not submit model work. Old executions and their exact inputs remain immutable.

Affected paths: `incubator/native-collaboration/` (mode, flow contracts/store/registry, owner RPC and editor); `incubator/native-resident/` (explicit predecessor-output inputs); `incubator/chatgpt-web/` (main-model and Insight bindings, flow provider); relevant build/probe/test files and extraction/verification docs. No V4 core or upstream patch is introduced. The shared editor is part of Collaboration and Web contributes through an optional public Cordis service. Resident remains the native TaskGraph scheduler.

## Interaction and ownership

- The conversation header exposes Ordinary / Smart Collaboration for the current session. Merely changing mode performs no model request. The policy is session scoped, persisted in the Collaboration namespace, and included through the public logged system-prompt channel. A model without DSH tool calling cannot silently claim to have submitted a graph.
- The Execution Flow view uses a canvas, compact stage cards, dependency arrows, status accents and a node inspector. Connection diagnostics move to Settings. Narrow windows keep a usable canvas and move the inspector below it.
- Node positions are layout only. Edges define dependencies. Prompt/model/effort/executor/other supported fields change execution; free-form metadata is retained but never treated as executable code.
- Saving creates or updates a draft using its exact revision. A run captures that draft revision, gets a new command/run identity and consumes configured provider quota only after the explicit Run action. Double submission of the same command reconciles the original run. It never overwrites an old run or silently resumes an unrelated one.
- Running or uncertain external effects are not edited in place or automatically replayed. A changed draft is a new run, and an uncertain original effect must be reconciled before admitting a replacement for the same resources.
- Deleted stages are absent from the new run. The final report identifies omitted research, independent review, or polishing stages; it cannot retain a verification claim whose producing stage was removed.
- Session ids and execution ownership are checked at the Host boundary. Data is not selected by a global most-recent run. UI labels do not expose internal ids.

## Native collaboration

The main model plans the TaskGraph, declares scope and checks, and uses the existing allocation tool. Independent nodes may run concurrently; dependency and workspace conflicts govern actual admission. Native execution uses the original caller's permitted tool bridge only when explicitly requested.

A dependency is not data transfer. A node may explicitly name successful predecessors whose complete outputs are appended to its executable input; invalid/non-predecessor references or oversized inputs fail before native dispatch. The exact rendered input is durable and reconstructable. Unknown effects do not enter automatic retry. The coordinator reads actual terminal outputs and verifies them; submission is not acceptance. Long waits are bounded without adding a model-polling loop.

## Web and Insight

The ordinary ChatGPT Web route remains a standard LLM provider with the existing model-handoff mechanism. Its exact session request becomes an editable single-stage source flow. Reruns use the edited prompt and configured observed-label selection and return their result to the originating conversation through supported Host APIs.

Insight defaults to clarification/questioning, Gemini plan/research, ChatGPT verification, Gemini polishing and final delivery. The editable representation preserves stage prompts, model selections and provenance. Only visible website activity is retained; no hidden reasoning is requested. The selected quota fallback remains GPT-6 Astra Pro Web search and analysis, marked as a fallback report. Timeout, missing receipts, login or selector errors are not quota evidence.

Requested model names remain distinct from actual website observations. An unavailable or unverified selection fails explicitly rather than silently aliasing a model or research mode.

## Verification

This is L3 because it introduces durable editable drafts and execution identities. Focused checks must cover session isolation, version/CAS conflicts, cycles/deleted edges, node field round trips, edit-without-execute, immutable prior runs, stable command deduplication, unknown-effect fencing, predecessor-output transfer, mode prompt lifecycle, and built rc.2 registration/RPC. Render and interact with the actual editor at ordinary and narrow widths. Full required source gate runs once at the stable boundary. Installed-app and real-provider acceptance are recorded separately; prior one-shot canaries do not cover this scope.

## Explicit continuation and local delivery layout

Checking an unknown execution observes its original effect only. The explicit **继续原执行（可能使用额度）** action keeps the original command and frozen graph; once the old effect is resolved, it may advance only phases that have not been admitted. It does not consume the edited draft or start a replacement run. A completed continuation returns to the originating conversation through the same durable delivery ledger.

The output node is a local formatter. Its editable layout template must contain the literal `{report}`, which is replaced with the complete predecessor report. Prefixes and suffixes are literal text; this node performs no model rewriting. Mandatory provenance and omission disclosures are appended independently. Model prompts remain on model-executing nodes. Output nodes must be DAG sinks. A single terminal output node supplies its local formatted text; otherwise every terminal node output is preserved in graph order with the same disclosures, and a graph without an output node uses only its terminal outputs rather than intermediate history.
