# ChatGPT Web verification

Recorded on 2026-10-20, Asia/Shanghai. This is an unreleased development candidate under `incubator/chatgpt-web`, not a market release. Source, scratch-profile, real browser preparation and installed execution are separate evidence boundaries.

## 2026-10-21 portable request-context repair

This repair keeps the webpage operator's 128 KiB request limit and no-auto-retry policy. Before prompt construction and current-question extraction, it removes only the marked Harness system envelope and marked `catalog`/`snapshot`/`recall` background from the named automatic producers. The observed `plugin:hindsight` and `dsh-mnemon` `recall` records follow that background rule; `dsh-mnemon` `instructions` remains retained. It preserves retained message order and exact text, including explicit workspace instructions, source-less request input, task notices/relays, compact checkpoints, unknown system-source content, historical tool calls/results/errors, and explicit one-shot `system` text. It is not a semantic summary, a tail truncation mechanism, or a provider fallback.

Focused keyless checks passed on this source tree:

- `pnpm vitest run tests/llm-adapter.test.ts tests/conversation-adapter.test.ts incubator/chatgpt-web/tests/conversation-runtime.test.ts` — 31 tests in 3 files.
- `pnpm typecheck` — passed.

The regression includes approximately 140 KiB of marked Harness system text and 401 KiB of marked skill-catalog content plus source entries, followed by a short real question. The resulting browser prompt remains within the existing bound and retains the exact allowed conversation data. Separate cases confirm oversized explicit user, task, and one-shot system input still fail before capture or controller start, with a byte-count-only `system`/`messages`/`toolSchemas` diagnostic. A private offline reconstruction of the reported request uses the logged message surface, request header and initial tool history. The old serializer reproduces the exact **559,966 UTF-8 bytes** and `WEB_PROMPT_TOO_LARGE`; the repaired serializer produces **5,975 bytes**, retaining the actual question, instruction text and tool declarations. It removes marked system/catalog/snapshot/automatic-recall material without truncating retained text. This pure replay performs no browser or model operation and does not establish live webpage availability. The final local `pnpm check` passed build/declarations, strict types, **387 tests in 45 files**, both built-package official CLI scratch-profile probes, and the generated homepage check. These probes use fake browser/native services and produced no real browser/model execution. The first exact-head Ubuntu CI run exposed a pre-existing test race: the completion callback spy becomes called before the asynchronous delivery receipt settles from `calling` to `submitted`. Both command/source assertions now await the durable submitted receipt while retaining the exactly-once callback assertions; production delivery behavior is unchanged. The affected Studio test file is checked separately after that test-only correction. Installed-App acceptance and final exact-head CI remain separate checks.

## Installed repair status (2026-10-21)

The runtime repair and test-only delivery-race correction at `e460ac45d5dc8ed665ee54b2a96b0a6ca9d9c867` passed exact-head CI. The official bundled CLI installed the stable package into the existing desktop profile; all 54 packed files matched the installed bytes. The tarball SHA-256 is `112d9e1194107ff8fd7fa66c7fbda5589d9783a889e22245b0fbf4c284e91aa9`. Its production bytes are identical to the locally verified `0d4a0ab` artifact. Unrelated plugin dependency specifications/manifests and profile configuration were preserved from a fresh backup; no App binary or runtime was patched.

The Web/Insight model entries were observed in the real official-App model menu after installation. The failed question was not sent again: the 559,966-to-5,975-byte result is a pure serialization replay, not a live webpage answer. All seven existing Web JSON files remained unchanged during this round, Resident graph/node/attempt counts were unchanged, and no new handoff call identities appeared.

The earlier installed settings-directory refresh failure, `Ego browser command failed`, remains unresolved. Retained evidence does not include its original process/script error code, so it cannot establish a PATH, network or quota cause. The directory refresh uses an independent create/catalog/finish path and does not submit a prompt. Further actual settings acceptance awaits a reliable transition into the Web settings page: some desktop automation press receipts did not produce the intended visible transition. Web/Insight settings save/reload, the full execution-editor interaction checklist, native narrow-window behavior and the real model chain are not claimed as accepted.

## Inputs

- Published Harness `0.2.1-rc.2`, Cordis `4.0.5`, macOS arm64.
- External Ego CLI `0.5.1.13`, public API v2; observed app `0.6.0.12`.
- A single already agent-owned TaskSpace and its original empty ChatGPT page. Its private identity and account state are not published.
- No legacy session, credential or database import; no Codex or Claude model execution.

## Source and keyless checks

The stable local repository gate `pnpm check` passed with 178 tests before the UI wire correction. After that correction, GitHub CI at source `6ac52914dd71bc40370430cd5e9fcb0d88c8d813` passed the full gate: build, strict type check, all 180 tests in 21 files, both built-package scratch-profile CLI probes and the generated homepage check. The two added tests exercise the official Remote success/error carriers for every UI control method. These checks made no model request. Focused tests cover bounded process cleanup, exact frames from stdout/stderr, visible DOM content, immutable request revisions, single admission, unknown-effect fencing, original-resource reconciliation, provider/tool lifetimes and the built client module factory.

The actual published CLI installed the built bundle in a disposable `DSH_HOME`, booted it under plain Node, and observed the public tool, provider and empty Remote status. It then disposed the plugin's actual registry fiber and confirmed both registrations were removed, with no process/socket artifacts. This probe never invoked an executor or browser.

## Real browser preparation: passed without a model request

| Check | Observed result |
|---|---|
| Original-page ownership and readiness | Agent ownership, one empty composer, no user/assistant messages or attachments. |
| Selected labels | Observed `GPT-6` and raw effort id `medium`, without confusing the effort label with a model name. |
| Model selection through the actual adapter | Requested `GPT-5.6 Sol`, then `GPT-6`; both exact readbacks passed with the normal 25-second command bound. Restored `GPT-6`. |
| Effort selection through the actual adapter | Requested `high`, then `medium`; both exact readbacks passed. Restored `medium`. |
| Website transitions | Advanced-list animation, hidden measurement/radio tracks, selection returning to the simple menu, reopening for visible confirmation, and closing-state confirmation have focused regressions. |
| Draft safety | A synthetic draft-only inspection was cleared after exact readback; it was never sent. Existing drafts/history are rejected before navigation. |
| CLI output | Observed the JSON frame on stderr. Both streams are now decoded within bounds; an update notice is retained without an automatic upgrade. |

No ChatGPT prompt was submitted in these checks. Preparation and selected controls are not evidence of answer generation, full answer retention or installed-app execution. `GPT-6` is the actual observed label; `GPT-6 Astra` availability is unverified.

## Installation and remaining acceptance

The first installed candidate was source `feef8465f888a150c0c757a05d2dece2e57096ec`, development version `0.1.0-dev.0`. The official bundled CLI installed it after normal exit and a profile backup; all 25 prior direct dependency versions and 39 enabled bundles remained present. All 30 non-manifest packed files matched the installed files; pnpm changed package-manifest formatting only. Its tab appeared, but the content panel was blank, so installed UI acceptance failed.

The client had incorrectly consumed the official `RemoteResult<T>` carrier as a plain status object. The correction unwraps success values and preserves Remote failures for all four methods, with two dedicated regressions plus the built-loader regression.

The corrected installed artifact was source `6ac52914dd71bc40370430cd5e9fcb0d88c8d813`, still development version `0.1.0-dev.0`, SHA-256 `a6041bb287bf8490c5c55df923aaeabd5ce6ab766b5c59eb1c652a4f60006e1f`. Its stable local tarball is under `artifacts/chatgpt-web/6ac5291/`. All 31 non-manifest installed files matched the packed files; the package manifest had equivalent parsed values. The update preserved all 25 unrelated direct dependency specifications/versions and all 40 enabled bundles, including the Web candidate. Profile backups and private installation receipts remain local and are not committed.

| Installed check | Result |
|---|---|
| Conversation entry and form | Passed after the wire correction; the text request, model/effort fields and explicitly quota-labelled button rendered. |
| Settings entry | Passed; it displayed the same persisted completed task and answer without a new request. |
| Normal and narrow conversation layout | Passed at 2560 and 1536 screenshot pixels wide (the latter approximately 768 logical points). Form, result, original-conversation link and state buttons remained readable; lower controls were reachable by vertical scrolling. No horizontal clipping was observed in the inspected content. |
| Refresh | Passed; the read-only notice appeared and no model task was submitted. |
| Synthetic execution | Exactly one GUI submit action, with the request and labels recorded below. No project file, attachment, inherited conversation or DSH tool was supplied. |
| Uncertain receipt and reconciliation | The immediate post-send observation did not yet show one exact matching user message, so the task became `indeterminate` with `WEB_SUBMISSION_MISMATCH`. A read of the original page subsequently showed the exact user message and answer. Clicking **读取最新状态** reconciled that same task to `submitted`, then `completed`; it did not resend or create a replacement conversation. |
| Durable result | The versioned record and rendered panel both contained the complete text and Markdown answer below, the observed labels and the original native conversation URL. Seven revisions retained the intermediate outcome. |
| Completion cleanup | The controller returned a completed record, its admission fence was absent, and no local wait remained. The temporary profile override for the existing acceptance TaskSpace was removed after normal application exit; `taskSpaceId` is again the package default. The Resident daemon was preserved. |

The one approved synthetic GUI task was admitted at **10:41:30 Asia/Shanghai** on 2026-10-20; that journal timestamp is not a separate browser-send timestamp. The durable completion was recorded at **10:43:32 Asia/Shanghai**:

```text
Request: 请只回复 SOLAR_CHATGPT_WEB_OK
Requested and preflight-observed model: GPT-6
Requested and preflight-observed effort: medium
Complete answer text: SOLAR_CHATGPT_WEB_OK
Complete answer Markdown: SOLAR_CHATGPT_WEB_OK
```

A temporary desktop-control inconsistency was resolved by normal application exit/relaunch before submission. Input was then checked in both the accessibility state and the rendered form. There was no send attempt during that inconsistency. The earlier browser draft check was also never sent.

## Accepted scope and limits

The installed text-only synthetic path, including explicit reconciliation of an initially uncertain receipt, is accepted on this identified artifact. The first submit did **not** complete unattended: this run required the normal **读取最新状态** action. The record must not be presented as an uninterrupted first-receipt success. The default creation of a new TaskSpace has keyless coverage; this real run reused the single TaskSpace already owned by the acceptance task. Long answers, arbitrary workloads, live cancellation, another model, and the public provider/tool path with a real model were not exercised by this one-message allowance. There is no general quality, performance, website-version or model-availability claim.

The private run identifier, account state, browser identity and conversation URL are retained only in local runtime/artifact receipts. No second ChatGPT request, native Codex execution, Claude execution, research run, market publication or recurring automation was performed in this acceptance. The separate Gemini/ChatGPT research workflow remains outside this operator's acceptance.

## Installed catalogue failure investigation — 2026-10-21

The official App settings page was observed at a native 1280 × 820 window. The user opened **网页与洞察**. An explicit catalogue attempt displayed **正在刷新…**, then **目标浏览器模型目录刷新未完成：Ego browser command failed**. The investigation did not submit a prompt or run a model. Native accessibility actions also reported completion without the intended tab transition, and one capture timed out after 60 seconds; these action receipts are not accepted as UI success.

Source inspection confirmed that catalogue errors lost their named code and operation stage in the displayed notice. The follow-up preserves a bounded `WEB_`/`EGO_` code and a Chinese create/read/finish phase in an ordinary error message, including a second cleanup failure. It never includes arbitrary adapter messages or stderr and does not retry. Eleven affected fake-service tests pass. Build, installed bytes and actual refreshed diagnostics are recorded separately after running; this paragraph does not claim the underlying Ego failure is fixed.
