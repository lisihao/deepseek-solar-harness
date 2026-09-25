# Agent Note: ChatGPT Web advisor and coordinator paths

Status: proposed

English | [中文](2026-09-23-chatgpt-web-coordination.zh.md)

## Problem

A primary model selection and a downstream physical-operator preference describe different roles. Replacing a selected coding coordinator when its task mentions ChatGPT loses ownership of implementation and acceptance. Conversely, a text-only ChatGPT Provider cannot coordinate DSH tools merely because the interface unlocks collaboration settings.

## Proposal

Preserve three paths: API/native coordinators delegate bounded planning or research to the ephemeral Web operator; standalone Web calls retain their text-only behavior; a locally configured Web coordinator uses genuine MCP tools through the existing DSH owner-local execution bridge. The current captured model selection owns the main route. Collaboration preferences guide delegation without replacing that selection.

The Web coordinator requires an explicitly configured ChatGPT custom MCP app. A loopback MCP endpoint uses a persistent random path and a user-configured tunnel. Each MCP request's native request ID must match metadata observed in the exact owned webpage turn before any DSH tool schema or execution authority is returned. Missing, ambiguous, or revoked identity fails closed. Model-generated credentials and prompt-encoded tool protocols are excluded.

The Provider owns a durable webpage lane and per-command send/result receipts. Restart recovery reconciles the existing turn; an ambiguous send is not replayed. Active commands retain cancellation ownership and wait for outstanding tool results before accepting completion. The existing DSH tool pipeline retains permissions, durable tool receipts, orchestration, and acceptance authority. Standalone calls receive none of this authority.

The local setup view distinguishes standalone mode, configured coordination, and the time of the last proven tool call. A configuration switch is not evidence that a connector currently works. Model and effort labels are reported only when observed on the website.

## Catalog refresh

Model catalogs come from configured API `/models`, native subscription discovery, and the authenticated Web model controls. An explicit refresh preserves the primary selection and last successful data on failure. New identifiers carry only capabilities supported by their adapter; a catalog entry alone cannot enable an unsupported modality or reasoning control. Web reasoning preferences are separate Session events, verified against the current model's visible controls before use.

## Alternatives considered

**Replace Ego or install a second agent application.** This duplicates browser and task ownership. The existing browser Provider remains the carrier; Chat On Steroids supplies reference behavior for request ownership, durable continuation, and visible recovery states.

**Parse assistant prose as local tool commands.** This would imitate a tool connection, violate the physical-operator bridge rules, and confuse plain advice with authorized actions.

**Unlock every combination immediately.** This advertises local execution to a text-only Provider. UI eligibility follows the actual configured execution mode and backend admission still enforces authority.

## Acceptance criteria

An assembled example keeps an API or native primary while a Web advisor returns a plan; its dependent implementation and test steps retain their own operator identities. A standalone Web request cannot qualify an unrelated native product. A configured Web coordinator reaches real DSH tools through MCP and records their actual results under the correct Session. Cross-session request evidence, stale calls, unadvertised tools, ambiguous sends, and user stops cannot trigger replay or successful completion.

Continuation, queued corrections, compression handoff, and finish checkpoints must retain the current objective and logged model-visible context. Keyless examples cover the assembled protocols; account-backed acceptance separately proves ChatGPT custom-app attachment and a real tool result. Source, artifact, installed version, and remote commit must agree before Desktop delivery is complete.

## Risks

ChatGPT page internals can change and make identity or completion unobservable. Such failures must remain explicit while the standalone route remains available. Custom-app and tunnel availability depends on the user's account configuration. Source tests do not establish browser compatibility, subscription availability, or performance improvements.
