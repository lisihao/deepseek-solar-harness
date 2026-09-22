# Agent Note: Applicable execution selections and admission

Status: implemented

English | [中文](2026-09-22-selection-combination-admission.zh.md)

## Problem

Independent primary-model, collaboration, and TaskGraph preferences can appear simultaneously active even when only one owns execution. A successful command transport can hide a rejected save, unsupported native profiles can survive until dispatch, and explicit autonomous execution can contradict disabled RLM. Direct Debate also lacks the Plan review and exit cycle.

## Decision

The collaboration control derives the active operator from the shared model directory and preserves inactive preferences without presenting them as effective. Native profile controls belong to the selected native product or the preferred collaborator of an ordinary primary model. Debate owns direct messages; TaskGraph strategy settings remain inactive during Debate or a browser-only primary route. RLM settings describe graph nodes rather than promising a direct-message executor.

Host commands validate native model and effort pairs against the selected operator's live catalog before appending a preference. Clearing a profile remains available without qualification. Command-handler rejection stops a multi-step selector transition. Explicit autonomous execution requires enabled or automatic RLM at both preference saving and graph admission; choosing Standard closes explicit autonomous execution. Direct Debate rejects active Plan while the model-invoked Debate tool remains usable within the ordinary Plan review flow.

Task-template matching reads the same captured model selection as routing. Claude authentication accepts the native CLI's structured logged-out response as authentication state even when its process outcome is nonzero; unrelated process failures remain errors. Browser submission refuses an occupied draft instead of replacing user input.

## Alternatives considered

**Clear every preference on a model switch.** This loses valid saved choices and confuses inactive state with an invalid value.

**Disable all cross-model collaboration.** An ordinary API model can legitimately delegate to a native collaborator. The UI constrains only settings that the current execution route cannot use.

**Trust disabled controls alone.** Other clients and persisted state can bypass presentation, so command and execution admission retain their own checks.

## Consequences

The user can identify the current route, recover stale profile values, and see failed saves without starting an execution. Existing logs remain readable; conflicting strategy values fail when admitted rather than being silently rewritten. Plan remains guidance independent of sandbox and approval settings. Browser draft protection does not add durable send receipts or continuation recovery, and authentication classification does not establish why a native account became logged out.
