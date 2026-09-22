# Agent Note: One model selection for browser operator routing

Status: implemented

English | [中文](2026-09-22-browser-model-selection-routing.zh.md)

## Problem

The browser model picker maintains a mutable session selection, while physical-operator routing can still read the Agent's creation options. A session created with Claude Code can therefore display ChatGPT Web but attempt Claude qualification. A separate saved collaboration preference makes the conflicting state appear intentional.

## Decision

The Agent owns the model selection captured for each prompt assembly. Physical-operator routing reads that same captured selection; entry points without a selection installation retain their configured Agent defaults. A model change during assembly takes effect on the next step. A selected ordinary provider never inherits a stale physical-operator default.

The collaboration control subscribes to the model picker's existing session directory. An active ChatGPT Web main model is displayed as the browser route and suppresses conflicting native collaboration controls and qualification polling. The saved collaboration preference remains available when the user returns to an ordinary main model. Explicit Debate mode remains visibly distinct.

## Alternatives considered

**Mutate Agent creation options whenever the browser picker changes.** This duplicates the selection owner and loses the existing per-step snapshot semantics used by prompt assembly and request configuration.

**Only hide the Claude selector.** Presentation cannot prevent stale server routing or protect requests submitted through another client.

**Clear the saved collaboration preference on every model switch.** This discards an independent user preference instead of deriving which control currently applies.

## Consequences

Browser selection, prompt variables, and physical dispatch agree for the admitted step. The change does not alter native authentication or silently choose a fallback provider. Browser operations remain ephemeral and do not gain a native tool bridge.

Regression evidence includes a real Loader composition that selects ChatGPT Web through the session model-selection API after creating a Claude session, then submits a short identity question. External provider counters prove the selected browser is called once and Claude is never qualified or started.
