# Agent Note: Session-local composer modes

Status: implemented

English | [中文](2026-10-18-session-local-composer-modes.zh.md)

## Problem

The model menu changes the deployment default. Conversation-mode controls need to select the existing ChatGPT Web route and return to the exact ordinary model without changing other Sessions. A blank Session must retain the choice across restart before any model request exists. A lost response can leave the Host route different from the browser’s last confirmed display.

## Decision

The conversation skeleton owns the session-scoped list slot `conversation.composer.controls` below the input. The model-selection plugin contributes mutually exclusive ordinary/ChatGPT controls and a disabled insight option with an explicit unavailable label. These controls share the existing Session directory and model-selection RPC. ChatGPT selects the existing bare Web operator route even when discovery advertises only colon-qualified model rows.

The RPC’s `persistDefault: false` option changes only the Session. A required-on-read `session/model-selection` event retains the complete provider/model/effort and the known ordinary choice or explicit null. The Host waits for the Session flush before returning success. Subsequent model-menu choices in such a Session also append a record so restart cannot restore an older mode. Session format remains 0; a reader unaware of this required event refuses the log. The [Host README](../../../../packages/host/apiproxy/README.md) owns resolution and failures. The current Host retains an unconfirmed-persistence marker across browser directory replacement; the new directory restores its send block from `session.models` until successful explicit reselection.

The browser checks the last Host-confirmed route, disables mode changes during a running turn, and blocks sending during pending or failed switches. A failed RPC does not prove that the Host made no change. Selecting the already checked mode after failure therefore sends another selection RPC. The browser cannot clear the failure by comparing its stale choice. Unknown ordinary history requires an explicit model-menu choice.

Before the initial directory read establishes a current route, a failed read leaves the mode options disabled and shows its error with a manual retry. The retry only reads the same Host directory; it neither selects a route nor submits a message, and cannot clear an outstanding mode-confirmation error. It is disabled during the read or while the Session/input disallows interaction. A failed advisory refresh leaves an already known mode usable.

## Alternatives considered

**Changing the shared default on each mode click** gives other Sessions an unintended route. The Session-only option preserves ordinary model-menu behavior.

**A browser-only mode flag** can disagree with the actual next request after reconnect, restart or a lost reply. Host state and durable Session records own selection.

**Waiting for the first request header** loses blank-Session intent. A separate log-only event records the choice without inventing a request or prompt content.

## Consequences

Real JSONL readback and a fresh Host verify pre-message recovery. Real Host request assembly verifies Web routing and exact ordinary effort restoration. Failure cases cover a changed route followed by a lost reply or failed flush. Built-browser replay verifies the below-input options, exclusive selection, reload and disabled insight while the Session log contains no model request. Fake catalogs avoid real website/model calls. These checks do not prove account availability or install a Desktop build.
