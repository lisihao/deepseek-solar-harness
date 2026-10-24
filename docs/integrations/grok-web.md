# Grok text webpage operator

Authorized on 2026-10-24 as an additive feature. This is a standalone ordinary
text-conversation route, not a replacement for ChatGPT or Gemini and not a new
Studio research node. No live model call is authorized for development.

## Observable delivery

Add `solar-chatgpt-web / grok-web` to the normal model selector. A user-sent
question creates one fresh Grok browser task, submits its portable role-framed
text at most once, and delivers only the matching completed visible reply.
An uncertain submission stays uncertain: preserve its original resource and
receipt, and observe it without resending. The model-handoff browser-operator
allowlist must include this route so entering it starts an independent task,
and returning to an ordinary model retains the existing two context choices.

## Boundaries and reuse

- Reuse the portable request projection and canonical identity, which already
  includes provider/model/session/messages. Retain the 128-KiB client bound as
  an explicit conservative client policy, not a claimed Grok service limit.
- Keep ChatGPT's WebController, URL validation and WebRunStore unchanged.
  Grok owns a versioned journal under `$DSH_HOME/solar/chatgpt-web/grok-web/`.
- Record the allocated TaskSpace/page, original request, requested/observed
  model, durable pre-send intent, exact user receipt and reply identity.
  Flush intent before the one submit action. Do not execute after reloading
  an existing intent; only inspect that same resource.
- Operate through the documented Ego browser API and visible DOM only. No
  private API, hidden framework state, driver injection or site modification.
- Login is manual. Model selection is exact and read back; an unavailable
  requested model is an error, not permission to substitute one.
- This route handles visible text. Separate Canvas/media/artifact contents
  must not be silently reported as fully captured ordinary text.

## Observed site contract

The operator's Ego Lite profile was initially signed out. The user signed in
and explicitly allowed read-only inspection of an existing conversation.
The fresh homepage and conversation use different composer roles: observed
`contenteditable=true` with `aria-label="向 Grok 提任何问题"`, respectively
`role=combobox` and `role=textbox`. The empty anonymous submit button had
`data-testid=chat-submit` and `aria-disabled=true`; one separately authorized logged-in draft observation confirmed a unique visible
Submit control with `disabled=false` and `aria-disabled=false`. The draft was
cleared immediately, with zero transcript messages, and the space was finished.

Existing conversation DOM exposes `data-testid=user-message` and
`assistant-message`, with stable enclosing `id=response-<id>` containers.
The transcript is `data-testid=chat-transcript-scroller`, `role=region`, with
`aria-busy=false` on the completed history. Reply controls include
`aria-label="复制响应"`. Hidden turn headings (`data-no-copy`) and
`thinking-container` are not answer text. Conversation Canvas/media controls
are distinct from the ordinary visible reply. No private conversation text,
account name, page export or real message ID is copied into public fixtures.

## Verification

Use synthetic DOM and fake browser ports for login/challenge, exact model,
prompt mismatch/duplicates, one-send intent, crash/reload, timeout/unknown,
abort, reply identity/completion and preserved user/explicit instructions.
Build plain Node artifacts and exercise public host registration in a
disposable official-CLI profile, with external model routes blocked. Back up
the latest profile before the separately authorized plugin installation;
preserve all unrelated plugins/settings/logs. Real generation and end-to-end
service acceptance remain explicitly unrun unless later authorized.

## No-model observation follow-up

The production pure DOM observer was evaluated on the cleared signed-in page:
one composer, empty text, zero messages, no errors, and observed model `Expert`.
This exposed and fixed ProseMirror's render-only empty `P/BR` newline. Synthetic
fixtures also cover literal multiline draft text, paragraph/code boundaries,
empty media containers, actual media/Canvas detection, and duplicate controls.
These observations do not establish a new live request/receipt/reply cycle.

Entering Grok and its native return context choices require the corresponding
model-handoff compatibility candidate. The normal model catalogue is checked
through a disposable official CLI profile with no browser executor invocation.

## Source verification record (2026-10-24)

The stable candidate passed the repository gate: build, strict types, 525 tests
in 57 files, two official CLI scratch-profile probes, and generated homepage /
curated-installer checks. Subsequent affected checks added cleanup-failure
admission coverage and literal multiline user-receipt extraction: 13 controller
tests and 15 DOM/transport tests passed, followed by rebuilt artifacts and strict
types. A completed answer retains a named cleanup error if TaskSpace finish
fails, releases its own admission lease, and never retries the finish or Send.
The original request's audit notice stays logged but does not duplicate itself
into a browser prompt or handoff task context. No real Grok generation ran.

## ProseMirror draft-readback repair (2026-10-24)

The first user-triggered live attempt stopped in preparation with
`GROK_PROMPT_READBACK_MISMATCH`. Its durable journal never reached a send intent,
and the original page contained zero messages. Read-only inspection found 90
direct paragraph elements, including 26 empty paragraphs with editor-placeholder
BRs. Native `innerText` introduced 115 layout LF characters: 12,268 bytes versus
the original 12,153-byte input. Logical paragraph reconstruction was exactly the
original request; this was an adapter readback failure, not a remote rejection.

The observer now joins direct paragraphs with one literal LF, preserving empty
paragraphs, inline text, explicit BRs and boundary whitespace. It ignores only
editor trailing-break placeholders, never trims or collapses whitespace, and
rejects unsupported/mixed paragraph structures before intent. Exact comparison
at preparation and just before Send remains unchanged. No original event,
failed-run record, browser draft or previous artifact is rewritten or replayed.

The three new reproduction/negative tests failed before the fix and passed after
it. Read-only evaluation of the fixed production observer on the same retained
draft returned exactly 12,153 bytes and the original SHA-256, no errors, and zero
messages. No fill, Send, model call or new browser task was used for that check.
This proves the observed preparation defect is fixed; it does not establish a
new live submission receipt or completed-answer capture.
