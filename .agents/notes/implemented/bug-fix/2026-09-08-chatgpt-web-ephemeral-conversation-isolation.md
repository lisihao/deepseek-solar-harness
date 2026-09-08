# Agent Note: ChatGPT Web ephemeral conversation isolation

Status: implemented

English | [中文](2026-09-08-chatgpt-web-ephemeral-conversation-isolation.zh.md)

## Problem

The ChatGPT Web operator reuses one authenticated Ego Lite workspace across calls. A page selected for the configured root URL can already belong to an earlier `/c/...` conversation, so submitting another standalone physical-operator request can append it to unrelated web context even though the DSH Session logged only the current user message.

## Decision

Every ChatGPT Web ephemeral call explicitly navigates its selected page to the configured `https://chatgpt.com/` root after workspace and tab selection. The trusted browser program confirms that the page is the root and contains zero user and assistant turns before it marks the input or fills any text. A page that retains a prior turn or remains on another route returns `context-not-isolated`; the Provider maps that result to `CHATGPT_WEB_CONTEXT_NOT_ISOLATED` and submits nothing.

The authenticated named workspace remains reusable, but the ChatGPT conversation does not. One DSH Session is not treated as one ChatGPT task because it may contain unrelated user objectives. The current physical-operator request remains the sole task content sent by an ephemeral call.

## Alternatives considered

**Reuse the current ChatGPT conversation for the whole DSH Session.** This preserves implicit follow-ups but makes the DSH Session an unverified task boundary and reproduces cross-objective contamination.

**Create one Ego Lite workspace for every call.** This isolates both tabs and browsing state, but accumulates task spaces and duplicates lifecycle cleanup while authentication reuse already works inside one named workspace.

**Open a nonce-bearing ChatGPT URL.** This can discourage exact-URL reuse, but URL normalization remains website and browser-helper behavior. Explicit root navigation followed by a route check proves the condition immediately before submission.

## Consequences

Independent DSH requests cannot inherit an earlier ChatGPT conversation through browser reuse. An explicit follow-up must carry the context it needs as a complete standalone request until a future durable Provider owns a ChatGPT turn identity. Existing ChatGPT conversations remain in account history; the isolated agent task space reuses authentication without closing the browser.

Unit coverage executes the trusted browser program with an initially selected conversation, verifies root navigation precedes prompt filling, and verifies a failed reset prevents all fill and send operations. Provider coverage pins the public failure code and confirms that progress records contain no prompt text.
