# Agent Note: Visible session and orchestration evidence

Status: implemented

English | [中文](2026-08-21-visible-session-and-orchestration-evidence.zh.md)

## Problem

Two presentation choices made retained evidence look absent. The orchestration dashboard silently removed every local acceptance Run from its default list, so an installation containing only acceptance Runs appeared empty even though SQLite and the daemon still held them. Code-as-Harness governance used a left-sidebar action that consumed persistent navigation space and resolved a global current Session instead of receiving the Session owned by the selected conversation view. Its empty copy also described an external task boundary that the DSH Session Log does not observe.

The orchestration event timeline proved that a Resident operator was dispatched and stored an Evidence reference, but it omitted the product-neutral execution phases and the operator's final user-facing output. Users could not distinguish an active Codex or Claude Code execution from a stalled dispatch or inspect its result from the same Trace.

## Decision

The orchestration Host projection classifies temporary `dsh-orchestration-*` Runs with `diagnostic: true` and includes them by default. The Desktop list labels these as acceptance records and offers an explicit show/hide control; hiding changes only the projection and retains the diagnostic count. Selecting a Run keeps the complete filtered list while adding that Run's bounded events.

The orchestration daemon copies bounded, product-neutral Resident progress phases into `node.operator.progress` events through an event-only store operation that cannot overwrite a concurrently advancing Run snapshot. Settlement stores the complete result in its content-addressed Evidence artifact and adds an 8,000-character user-facing output preview, truncation marker, operator id, and stop reason to the accepted or failed event. The Desktop Collaboration Trace renders those phases, outputs, and Evidence references. It never projects private reasoning text, prompts, terminal screens, or product-local transcripts.

Code-as-Harness governance plugin 0.3.9 registers `治理 Trace` as an order-15 `conversation.view` entry. The slot passes the exact `sessionId`; the view fetches and refreshes only that Session's live or persisted governance projection. The left-sidebar entry and modal are absent. Empty copy states that external Codex tasks and GitHub Actions are independent authorities and do not automatically enter the selected DSH Session Log.

Desktop seals that 0.3.9 package as a product bundle, loads its Host and invariant rows from the package patch, and resolves its browser entry from the application dependency tree. The per-Session Trace therefore belongs to a clean Desktop build rather than to an older plugin left in the machine's generated profile.

This note supersedes only the default-hidden presentation decision in [Resident qualification and diagnostic projection isolation](2026-08-20-resident-qualification-and-diagnostic-projection.md). Its Resident qualification, serialized probes, and temporary-workspace classifier remain in force.

## Verification

Provider tests pin visible diagnostic classification, optional hiding, Resident progress transfer, Codex and Claude Code dispatch, bounded output projection, and Evidence retention. Client tests pin the per-Session view slot, exact Session id request, absence from the sidebar, diagnostic controls, progress labels, and final output rendering. Desktop profile tests require both governance rows from the sealed package, and packaged acceptance runs both native subscription products and observes their corresponding progress, result, and Evidence events through the installed Desktop projection.

## Alternatives considered

**Delete or continue silently hiding acceptance Runs.** Deletion destroys durable test evidence. Silent default hiding preserves bytes but makes an acceptance-only installation indistinguishable from lost history. Visible classification keeps the evidence understandable and lets the user choose the presentation.

**Keep one global sidebar Trace.** A global current-Session lookup can drift from the tab the user selected and permanently consumes navigation space. A Session-scoped conversation view receives the identity from the slot contract and follows the same selection lifecycle as Memory and Trajectory views.

**Copy full Resident transcripts into orchestration events.** That duplicates unbounded product history, private reasoning, and terminal activity. Product-neutral phases plus the user-facing output and immutable Evidence reference show execution and results without changing the privacy or storage boundary.

## Consequences

Retained acceptance history is visible after restart and is never mistaken for user work. Each Session owns its governance Trace, while orchestration Trace separately explains intelligent dispatch and execution. Ordinary output is readable inline; larger output is explicitly marked and remains in the Evidence artifact. Progress projection adds bounded events during execution, so consumers must treat `node.operator.progress` as observation rather than completion evidence; only terminal Evidence events certify a node result.
