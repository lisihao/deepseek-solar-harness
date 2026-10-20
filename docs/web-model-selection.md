# Target-browser model discovery and selection

User correction: 2026-10-20, Asia/Shanghai. Chrome and Ego Lite may have different accounts, model selections, reasoning defaults and available choices. A value observed in one browser is not evidence of the other browser's state. The earlier statement that Chrome's visible Pro implied an Ego selection defect was unsupported and is withdrawn.

## Observable contract

The same installed plugin must accept newly added model and reasoning labels without a source edit or a release, while the website continues exposing the supported model-menu/effort-control contract. Settings explicitly refreshes a catalogue from the plugin's actual target browser. Choices come from the live menu, not a compiled model-version list or fixed effort-name mapping. A cached snapshot is only configuration assistance; every real request checks its own target page before sending.

The plugin currently executes through Ego Lite. Chrome screenshots can identify a capability worth inspecting; they are not copied into Ego state or used as credentials/selection proof. Discovery returns the target browser identity and observation time. Efforts are scoped to the inspected model and must not be offered as if every model supported them.

## User policy

- An empty ordinary Web model or effort field means follow that target page's current choice. New preference files use this policy; existing saved values are preserved exactly.
- A nonempty value pins an explicit model/effort. It is never silently replaced with another browser's default, a cheaper tier, a guessed alias, or a supposedly latest model.
- A newly offered choice appears after **刷新目标浏览器模型目录**. Selecting it and saving preferences changes future runs only; immutable prepared requests and past run snapshots retain their selections.
- Refreshing for a selected model reads that model's supported efforts. A previously saved value not present in the fresh snapshot remains visible and editable; discovery does not rewrite it.
- The human-requested role `GPT-6 Astra Pro` is not automatically equated with any menu family label. Exact website model and reasoning selections can be configured separately while preserving the requested role in the workflow's context. Unknown backend identity remains unknown.
- No automatic ranking by menu order/version text is claimed. Following the browser's current selection and pinning an exact choice are explicit, different policies.

## Read and execution boundaries

The owner-only `solarWebModelCatalog.read()` returns the last successful in-memory observation or no snapshot. It never starts browser work. `refresh({ modelLabel? })` explicitly creates an isolated page in the plugin's browser, checks that it has no prompt/attachments/active generation, reads model choices and per-model efforts, restores temporary model/effort changes and closes its owned page. It never fills a prompt or invokes Send. A known unresolved ordinary Web task blocks catalogue refresh. Ambiguous controls, unavailable requested choices, takeover and failed restoration are surfaced; unknown effects are not retried or hidden behind a new discovery run.

A model request selects the model first, then its reasoning effort, because changing a model may change its effort choices/default. The adapter accepts an exact visible effort label or its exact observed website identifier. The two are kept separately as `effortLabel` and optional `effortId`; equality is based on evidence from the same target page, not a fixed mapping such as Pro equals high. Post-selection and pre-send checks confirm the chosen state. Missing/unavailable explicit choices fail before Send.

New Web/Insight observations may include optional `effortId`; new readers accept existing format-one records without it. Existing records are not rewritten. Older strict readers may refuse records containing this new key, so reverting source is not a data-conversion step.

## Compatibility boundary and verification

Adding, removing, renaming or reordering choices within the supported controls is data. A changed login flow, website control protocol or DOM structure may require an adapter update; this design does not claim universal future website compatibility. Browser and account availability is observed, not promised.

Keyless acceptance covers unseen future model/effort labels, model-specific effort scope, current-choice following, preserved explicit settings, exact label/id matching, changed post-selection identities, restoration and unknown-effect handling, no Send/fill during discovery, owner RPC/disposal, built plain-Node plugin loading, and rendered Settings at normal/narrow widths. Real provider execution and installed-app acceptance remain separate. The user has withheld new quota use; no real model request is authorized by this mechanism update.

## Verification record — 2026-10-20 (Asia/Shanghai)

This amendment is an unreleased source candidate in PR #281. It does not update the installed Harness plugin. Its acceptance boundary is the dynamic selection contract above, including unchanged existing explicit settings and empty ordinary-Web selections surviving source capture and reruns.

| Evidence | Result and limit |
|---|---|
| Local source and built-package gate | Build and strict types passed. The first full Vitest run passed 380 of 381 cases; one old runtime fixture still assumed medium was an implicit default. That fixture now explicitly configures its pinned choice and also asserts empty ordinary selection is preserved in source capture. All 11 affected runtime cases passed after the test-only correction; strict types, both built plain-Node rc.2 CLI plugin probes and the homepage check then passed. The unchanged other 44 test files retain their passing evidence. |
| Rendered settings | The actual PreferencesPanel was rendered in Chrome through the local fixture. Mount performed one cache read and zero refreshes. Explicit refresh added an unseen fake model without rebuilding the plugin. Selecting that model and Pro, saving, and querying its effort catalogue preserved the independent original-browser selection and the saved Astra Pro Insight setting. This is fake-data UI acceptance, not a live model catalogue. |
| Narrow layout | The actual measured CSS viewport was 391 px wide (a 430 px override under Chrome zoom). The document was also 391 px wide, with no horizontal overflow. Normal-width rendering was checked too. Fixture-owned tabs, viewport override and local server were cleaned up. |
| Costless real catalogue attempt | Built plain-Node EgoWebAdapter created one owned TaskSpace and attempted one catalogue read. The read failed with WEB_RESOURCE_CHANGED before a catalogue was returned. The receipt did not retain the actual URL or which URL-check phase failed; the cause is unknown. The wrapper finished that original owned resource after the settled failure. It was not retried or replaced with another TaskSpace. The URL boundary remains intact. |
| Installed application | Not installed or tested for this amendment. Earlier installed text-only evidence is not evidence for this new catalogue path. |
| Real models and Insight | No prompt was filled or sent. No fresh Codex, Claude Code, ChatGPT or Gemini model call was made. The user's quota hold and exact Astra Pro requirement remain in force. |

The reproducible [browser fixture](../tools/fixtures/model-catalog-browser/README.md) uses fake APIs and shows separate cache-read/refresh/save counters. Local private receipts and screenshots remain outside the repository. Live Ego catalogue compatibility has **not** passed and must be reconciled from an observed page in a later appropriately bounded browser run; successful synthetic discovery does not remove that gap.
