# ChatGPT Web operator extraction

Authorized by 昊哥 on 2026-10-19: extract the existing V3 browser operator into one independent V4 plugin, verify it, then install it in the official Harness. Default installation is the existing `~/.dsh`; tests use disposable homes.

## Reference and retained behavior

Legacy reference: `origin/solar` commit `9330e3d801f206e68a914d65df246de77cdcb021`, `packages/physical-operator/physical-operator-chatgpt-web` and its bundle. Retain single concurrency, an empty fresh ChatGPT conversation, text-only input, login/readiness/draft checks before submission, explicit observed model/effort selection, bounded waiting and visible Markdown extraction, cancellation without pretending the website stopped, and no automatic retry or API fallback. The later archived V3 source at `2e33d74806e01f5eab852e905f99e52364d3290c` also confirms `model-controls.ts` / `model-catalog.ts` own explicit website model and effort selection; the V4 adapter must distinguish this from merely checking a label. Do not import legacy session events or its SQLite data.

## V4 seams and redesign

Published rc.2 browser-use registers the selected browser backend but does not expose V3 `ctx.browser.runProgram`, named-workspace or physical-operator/model-worker services. The independent `@lisihao/dsh-solar-chatgpt-web` bundle will register a public `chatgpt-web` subagent provider and a `solar_chatgpt_web` tool, plus its own ChatGPT webpage task view/settings through official client slots and Typert. It will not patch the main model selection or install a V4 core. Model/effort preferences are plugin-owned, with actual selection observed in the webpage; unavailable choices fail explicitly.

The browser transport is a thin subprocess adapter to the user-installed Ego Lite public v2 CLI. Local observed app version is `0.6.0.12`, CLI `0.5.1.13` (Chromium `152.0.7977.54`, Node `24.18.1`). Test and declare only this identified CLI version until another is verified. It is an external prerequisite, not a silently downloaded/repacked app. Normal plugin installation installs only the bundle; preflight reports missing/unsupported Ego Lite and guides the user to its official install/onboarding route. No extra browser, login copying or hidden service API is introduced. `UPGRADING.md` records this version/API dependency.

One explicit user request owns one Ego TaskSpace. Reuse its numeric identity through all observations and stop when the user takes control; never claim another space as recovery. Only plugin-controlled JavaScript is sent as stdin to `ego-browser nodejs`. Model strings are serialized as data, never shell code. The transport retains bounded stdout/stderr and confirms local process cleanup; it cannot infer cancellation of a remote model from killing the CLI.

## State and evidence

Plugin state lives under `$DSH_HOME/solar/chatgpt-web/`, with explicit format versions. Persist command identity and the exact request before a browser submission may occur. Unknown effects are observed against the same resource; no automatic new identity or replay. Preserve full input/output artifacts within declared bounds; report partial/unknown or a named size error rather than silently clipping a complete claim. Only visible webpage content is collected. The selected effort is retained as the raw `data-selected-reasoning-effort` identifier when available, for example `medium`; hidden measurement labels are excluded. A submission receipt requires the exact visible user-message text and the original native conversation URL, not only a message count.

The browser transport remains internal and available only to trusted plugin code for the separately authorized research plugin; it does not expose arbitrary JavaScript as a model-visible tool. Research owns its persistent four-stage workflow, full-report attachment protocol and evidence store. The standalone ephemeral answer is not research completion.

## Acceptance

Keyless tests cover subprocess timeout/cancellation and descendants, stdout framing/bounds, page readiness/draft/login/model mismatch, exactly-once submission under unknown outcomes, stable answer extraction, provider/tool lifetime and public rc.2 built-profile loading. Then inspect the installed UI at normal/narrow widths and run one explicitly authorized synthetic live webpage request. Record requested versus observed model labels, full request/answer, original conversation/resource and any missing evidence. A fake DOM, enabled bundle, web login or an output marker does not by itself prove the full installed feature. No research-quality or speed benefit is claimed.

## Current implementation boundary (2026-10-20)

The independent candidate now includes the controller, Ego adapter, versioned store, public provider/tool, owner-only Remote service, conversation/settings UI and built-package probe. The built public rc.2 CLI probe passed registration, an empty status query and removal of registrations on plugin disposal, without browser or model execution. Detailed source and installation evidence belongs in [the verification record](../chatgpt-web-verification.md).

Real empty-page preparation passed using the identified Ego CLI. Exact model selection and readback passed for `GPT-5.6 Sol` and `GPT-6`, with `GPT-6` restored. Effort selection passed `medium` to `high` and back to `medium`. No message was sent. The adapter waits for actual visible controls through menu transitions: selecting a model returns the website to its simple menu, then confirmation reopens the advanced list. Existing drafts/history are checked before navigation. The transport handles the observed CLI frame on stderr as well as stdout and retains explicit truncation information.

Installed-app UI and one separately cost-authorized live request are still required. This candidate is not yet accepted as usable. The research/insight plugin remains a later, separate step after this operator is accepted. No market publication, recurring task or research run has started.
