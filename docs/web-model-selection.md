# Target-browser model discovery and selection

User correction: 2026-10-20, Asia/Shanghai. Chrome and Ego Lite may have different accounts, model selections, reasoning defaults and available choices. A value observed in one browser is not evidence of the other browser's state. The earlier statement that Chrome's visible Pro implied an Ego selection defect was unsupported and is withdrawn.

## Observable contract

The same installed plugin must accept newly added model and reasoning labels without a source edit or a release, while the website continues exposing the supported model-menu/effort-control contract. Settings explicitly refreshes a catalogue from the plugin's actual target browser. Choices come from the live menu, not a compiled model-version list or fixed effort-name mapping. A cached snapshot is only configuration assistance; every real request checks its own target page before sending.

The plugin currently executes through Ego Lite. Chrome screenshots can identify a capability worth inspecting; they are not copied into Ego state or used as credentials/selection proof. Discovery returns the target browser identity and observation time. Efforts are scoped to the inspected model and must not be offered as if every model supported them.

## User policy

- An empty ordinary Web model or effort field means follow that target page's current choice. New preference files use this policy; existing saved values are preserved exactly.
- A nonempty value pins an explicit model/effort. It is never silently replaced with another browser's default, a cheaper tier, a guessed alias, or a supposedly latest model.
- A newly offered choice appears after **刷新可用模型**. Selecting it and saving preferences changes future runs only; immutable prepared requests and past run snapshots retain their selections.
- Refreshing for a selected model reads that model's supported efforts. A previously saved value not present in the fresh snapshot remains visible and editable; discovery does not rewrite it.
- The human-requested role `GPT-6 Astra Pro` is not automatically equated with any menu family label. Exact website model and reasoning selections can be configured separately while preserving the requested role in the workflow's context. Unknown backend identity remains unknown.
- No automatic ranking by menu order/version text is claimed. Following the browser's current selection and pinning an exact choice are explicit, different policies.

## Read and execution boundaries

The owner-only `solarWebModelCatalog.read()` returns the last successful in-memory observation or no snapshot. It never starts browser work. `refresh({ modelLabel? })` explicitly creates an isolated page in the plugin's browser, checks that it has no prompt/attachments/active generation, reads model choices and per-model efforts, restores temporary model/effort changes and closes its owned page. It never fills a prompt or invokes Send. A known unresolved ordinary Web task blocks catalogue refresh. Ambiguous controls, unavailable requested choices, takeover and failed restoration are surfaced; unknown effects are not retried or hidden behind a new discovery run.

A model request selects the model first, then its reasoning effort, because changing a model may change its effort choices/default. The adapter accepts an exact visible effort label or its exact observed website identifier. The two are kept separately as `effortLabel` and optional `effortId`; equality is based on evidence from the same target page, not a fixed mapping such as Pro equals high. Post-selection and pre-send checks confirm the chosen state. Missing/unavailable explicit choices fail before Send.

New Web/Insight observations may include optional `effortId`; new readers accept existing format-one records without it. Existing records are not rewritten. Older strict readers may refuse records containing this new key, so reverting source is not a data-conversion step.

## Compatibility boundary and verification

Adding, removing, renaming or reordering choices within the supported controls is data. A changed login flow, website control protocol or DOM structure may require an adapter update; this design does not claim universal future website compatibility. Browser and account availability is observed, not promised.

Keyless acceptance covers unseen future model/effort labels, model-specific effort scope, current-choice following, preserved explicit settings, exact label/id matching, changed post-selection identities, restoration and unknown-effect handling, no Send/fill during discovery, owner RPC/disposal, built plain-Node plugin loading, and rendered Settings at normal/narrow widths. At the 2026-10-20 source boundary, real provider execution and installed-app acceptance remained separate. The user had withheld new quota use, and no real model request was authorized by that mechanism update.

## Verification record — 2026-10-20 (Asia/Shanghai)

At the 2026-10-20 verification boundary, this amendment was an unreleased source candidate in PR #281 and did not update the installed Harness plugin. Its acceptance boundary is the dynamic selection contract above, including unchanged existing explicit settings and empty ordinary-Web selections surviving source capture and reruns.

| Evidence | Result and limit |
|---|---|
| Local source and built-package gate | Build and strict types passed. The first full Vitest run passed 380 of 381 cases; one old runtime fixture still assumed medium was an implicit default. That fixture now explicitly configures its pinned choice and also asserts empty ordinary selection is preserved in source capture. All 11 affected runtime cases passed after the test-only correction; strict types, both built plain-Node rc.2 CLI plugin probes and the homepage check then passed. The unchanged other 44 test files retain their passing evidence. |
| Rendered settings | The actual PreferencesPanel was rendered in Chrome through the local fixture. Mount performed one cache read and zero refreshes. Explicit refresh added an unseen fake model without rebuilding the plugin. Selecting that model and Pro, saving, and querying its effort catalogue preserved the independent original-browser selection and the saved Astra Pro Insight setting. This is fake-data UI acceptance, not a live model catalogue. |
| Narrow layout | The actual measured CSS viewport was 391 px wide (a 430 px override under Chrome zoom). The document was also 391 px wide, with no horizontal overflow. Normal-width rendering was checked too. Fixture-owned tabs, viewport override and local server were cleaned up. |
| Costless real catalogue attempt | Built plain-Node EgoWebAdapter created one owned TaskSpace and attempted one catalogue read. The read failed with WEB_RESOURCE_CHANGED before a catalogue was returned. The receipt did not retain the actual URL or which URL-check phase failed; the cause is unknown. The wrapper finished that original owned resource after the settled failure. It was not retried or replaced with another TaskSpace. The URL boundary remains intact. |
| Installed application at the 2026-10-20 boundary | Not installed or tested for this amendment. Earlier installed text-only evidence was not evidence for this new catalogue path. The later installed runtime receipt is recorded below. |
| Real models and Insight | No prompt was filled or sent. No fresh Codex, Claude Code, ChatGPT or Gemini model call was made. The user's quota hold and exact Astra Pro requirement remain in force. |

The reproducible [browser fixture](../tools/fixtures/model-catalog-browser/README.md) uses fake APIs and shows separate cache-read/refresh/save counters. Local private receipts and screenshots remain outside the repository. At that earlier boundary, live Ego catalogue compatibility had **not** passed. The resumed acceptance below supersedes that gap for costless catalogue reading and Pro preparation; it does not accept real answer generation or the full Insight workflow.

## Resumed acceptance — Pro and settings

The user resumed implementation on 2026-10-20, asked for a redesigned settings UI and stated that Ego Lite had been set to Pro. Fresh model calls remained out of scope.

Observed defects and changes:

1. The fresh Ego page used `chrome://new-tab-page/`. The old built adapter rejected that exact route before navigation. The repaired adapter accepts that observed empty start and retains foreign-page/non-root ChatGPT rejection.
2. ChatGPT's empty editor contained only the semantic webpage-search pill and a trailing space. The observer now recognizes that structure as empty; it preserves ordinary whitespace drafts and any real text.
3. The live reasoning menu had distinct visible positions sharing a raw identifier: Pro and 中 both exposed `medium`. An intermediate catalogue read restored the first matching identifier and changed Pro to 中. That error is retained as adverse evidence. The original Pro position was restored in the same page before continuing. The final adapter captures and restores the slider range/index, visible label and raw id; it reads the visible simple-menu selection and the settled closed-menu label independently of that id.

| Acceptance | Result |
|---|---|
| Final real catalogue | Passed on the same retained page. Observed model choices were GPT-6 and GPT-5.6 Sol; GPT-6 efforts were 即时, 中, 高, 极高 and Pro. The captured and restored choice was visibly Pro at its original final slider position. This observation is time/account/browser-specific, not a global model availability claim. |
| Explicit Pro preparation | Passed with an empty preparation input and requested effort Pro. Observed model GPT-6, visible effort Pro, raw effort id medium, empty composer text, zero user/assistant messages and no generation. No submit call, prompt fill, attachment or model request occurred. |
| Settings behavior | Actual component rendered in Chrome with fake APIs. One visible tabpanel; keyboard End/ArrowLeft switching; collapsed stage editing; explicit refresh adding a future fake model; model-scoped effort refresh; explicit Pro save; unsaved pinned-value preservation; invalid JSON error without saving; and reload passed. Cache/tab reads caused no refresh or execution. |
| Responsive layout | Normal CSS viewport 1374 px and actual narrow CSS viewport 391 px both had no horizontal page overflow. Both settings tabs were checked narrow; the save button remained within the 818 px viewport. The temporary viewport override, fixture tab/server and the single Ego task space were cleaned up. |
| Stable source gate | `pnpm check` passed: build, strict types, 384 tests in 45 files, both built plain-Node scratch-profile rc.2 CLI probes and homepage check. `pnpm homepage` regenerated unchanged published output. |
| Installed application at the 2026-10-20 boundary | Not updated by this amendment. The shared official App was reserved by an active separate model-handoff update/acceptance; its pending user interaction had to be preserved. No quit, restart, install or desktop-profile write was performed here. The later installed runtime receipt is recorded below. |

The [settings design guideline](design-guideline.md) records the component hierarchy and behavior. Fixtures demonstrate the real client component with fake data; the live menu/preparation rows above are separate real-browser observations. Full Insight execution, real answer generation and installed acceptance remained unrun for this amendment at the 2026-10-20 boundary.

## Superseding installed catalogue follow-up — 2026-10-21

The runtime source `2c338f9fc3e121d6142db6d1a1d74b602c3047c5` was installed into the existing desktop profile with the official bundled CLI. The exact-head [GitHub CI run](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39550624873) passed. All 54 packed files matched the installed bytes, and the tar SHA-256 was `525a60d4c514e57e0657c81c5a8c44d7d9385631d69492627ba8763c90f2be34`.

The user confirmed that the installed Settings refresh completed. At `2026-10-21T05:49:42.572Z`, the app displayed exactly **已读取目标浏览器模型目录；没有提交模型请求。** and showed Ego Lite, `GPT-6`, `Pro`, and the model/effort selectors. The retained empty-page trace establishes the timeout cause: the complete catalogue sequence, including restoration, took **29,314 ms** against the former **25,000 ms** process bound. The fix sets only the outer catalogue budget to `min(2 * commandTimeoutMs, 120000)`; individual DOM timeouts remain unchanged. The 26 affected adapter tests, build and type checks, the official built fake-CLI probe, and the homepage check passed. No new full local gate was run for this follow-up.

This current receipt supersedes the earlier uninstalled wording for live catalogue reading and restoration. The user then directly confirmed both installed settings pages' Save and reload flows: Web Save showed **设置已保存；只影响新运行。**, reload retained `GPT-6`/`Pro`, and Insight Save plus reload completed without a connection test, workflow run, or Send action. This is direct human confirmation, not a proxy automated-click receipt. The original editor and both settings pages were also human-confirmed at narrow width. A later Collaboration presentation update has its own [installed verification record](session-workflow-editor-verification.md#workflow-presentation-correction--2026-10-21); its new layout and editor interactions remain pending. Real model-chain execution, a Send action, and newly discovered model use remain unverified. The earlier 2026-10-20 canary belongs to an older artifact and is not evidence for this installed source.
