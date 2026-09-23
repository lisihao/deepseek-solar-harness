# Agent Note: ChatGPT Web composer readiness

Status: implemented

English | [中文](2026-09-21-chatgpt-web-composer-readiness.zh.md)

## Problem

The ChatGPT Web Provider treated any visible textarea as ready immediately after DOM content loaded. On the current site, that can be a server-rendered placeholder rather than the hydrated composer. Clicking its send control submits the native form and changes the page to a root URL with a `prompt-textarea` query parameter, without creating a ChatGPT turn. The old fixed send selectors also missed the current public form submit button.

## Decision

The trusted browser program keeps the [ephemeral conversation isolation](2026-09-08-chatgpt-web-ephemeral-conversation-isolation.md) check, then waits for exactly one visible `div.ProseMirror[contenteditable="true"]` editor. It does not inspect React properties or accept a textarea placeholder.

For collection, it retains the legacy role-marked message reader and adds the current public content-search units. It removes nested units before counting, reads the latest `data-markdown-text-style="assistant-message"` body, and treats only an exact `Copy` or `复制` control in that unit's single-assistant action ancestor as settled. It does not climb into `main`, `body`, or an ancestor containing multiple assistant units.

After one fill, the program reconstructs text from ProseMirror blocks, empty paragraphs, and ordinary hard breaks while ignoring `ProseMirror-trailingBreak`, then compares it with the complete request after newline normalization. While it waits, the page must remain the empty root conversation. It selects exactly one visible enabled `type="submit"` button from the editor's containing form. A candidate may use `#composer-submit-button`, `data-testid="send-button"`, or an exact supported `aria-label`. The program adds a private DOM marker only after these checks, clicks it once, and removes the input and send markers promptly.

Missing, changed, disabled, or ambiguous controls fail before a click as `submission-failed`. The Provider continues to map that result to `CHATGPT_WEB_SUBMIT_FAILED` with bounded state-only diagnostics, so neither the task nor webpage text enters the failure message or progress log.

The first real browser canary stopped at `promptMatches` and created zero user or assistant turns. Ego Lite's flat helper had retained a six-character contenteditable draft while filling, and ProseMirror rendered paragraph spacing as extra visual newlines. That is a browser-provider replacement-semantics defect plus an adapter text-reading defect, not a submission success. `dsh-browser-ego-lite` owns contenteditable replacement and now clears its DOM range before fill without changing its plain-input or object-facade paths. This adapter owns only faithful ProseMirror text reconstruction and exact comparison; it does not clear the editor itself.

## Alternatives considered

**Accept the visible textarea or read private React fields.** A textarea can be a pre-hydration placeholder, and React-owned fields are not a stable browser interface.

**Submit the form or press Enter.** The placeholder form has native GET behavior, while editor-specific key handling changes across ChatGPT revisions.

**Choose the first matching send control anywhere on the page.** A second form can expose an unrelated send button. The current editor's form gives the click a concrete ownership relationship, and multiple candidates in that form remain an explicit failure.

## Consequences

The provider fails closed when the public ChatGPT composer changes instead of submitting a different control or navigating a placeholder form. It keeps one fill and one possible click per call; a readiness wait never retries either action.

The package's JSDOM regressions execute the emitted browser program against SSR and hydrated DOM states. They cover the current Chinese and English accessible labels, newline-preserving text confirmation, disabled and ambiguous controls, cross-form exclusion, marker cleanup, malformed evaluator output, nested content-search units, and multi-assistant copy-action rejection. The Loader snapshot separately exercises the assembled Provider path through hydration, submission, and a response page that no longer has a composer.

A live submit canary created the ChatGPT turn. The final collector source was then evaluated read-only against that already replied conversation, rather than resubmitting the task. At source SHA256 `9604a3681f73b5a2e2ab55f1b2d072718eae4b7619f4638002d527fa32250cf0`, two consecutive samples reported `page=conversation`, one user, one assistant, `response='我是 GPT-5.6 Sol。'`, `generating=false`, and `settled=true`. This is separate submit and collector evidence, not one automatic end-to-end run of the final source.
