# ChatGPT Web verification

Recorded on 2026-10-20, Asia/Shanghai. This is an unreleased development candidate under `incubator/chatgpt-web`, not a market release. Source, scratch-profile, real browser preparation and installed execution are separate evidence boundaries.

## Inputs

- Published Harness `0.2.1-rc.2`, Cordis `4.0.5`, macOS arm64.
- External Ego CLI `0.5.1.13`, public API v2; observed app `0.6.0.12`.
- A single already agent-owned TaskSpace and its original empty ChatGPT page. Its private identity and account state are not published.
- No legacy session, credential or database import; no Codex or Claude model execution.

## Source and keyless checks

The stable full repository gate `pnpm check` passed: build, strict type check, all 178 tests (84 Web tests and 94 unchanged native tests), both built-package scratch-profile CLI probes and the generated homepage check. These checks made no model request. Focused tests cover bounded process cleanup, exact frames from stdout/stderr, visible DOM content, immutable request revisions, single admission, unknown-effect fencing, original-resource reconciliation, provider/tool lifetimes and the built client module factory.

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

The client had incorrectly consumed the official `RemoteResult<T>` carrier as a plain status object. The source correction now unwraps success values and preserves Remote failures for all four methods, with two dedicated regressions plus the built-loader regression. Normal/narrow rendered UI and the separately authorized one-message synthetic request still need to run on the corrected artifact. Unknown effects must be observed against the same resource without resubmission.

The separate Gemini/ChatGPT research workflow remains outside this operator's acceptance. No research result or quality benefit is claimed.
