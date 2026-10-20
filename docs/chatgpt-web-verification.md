# ChatGPT Web verification

Recorded on 2026-10-20, Asia/Shanghai. This is an unreleased development candidate under `incubator/chatgpt-web`, not a market release. Source, scratch-profile, real browser preparation and installed execution are separate evidence boundaries.

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
