# Prime RLM verification record

Date: 2026-10-20, Asia/Shanghai. PR: [#280](https://github.com/lisihao/deepseek-solar-harness/pull/280).

Implementation and the earlier local installation are authorized. Later instructions authorize an isolated Codex subscription pilot using `gpt-6.1-sol / high`, with at most 48 cumulative model requests including root, tool-return and descendant calls. They do not authorize paid API fallback, extra-credit purchase, merge, release, tags, Pages or market publication. The package remains `@lisihao/dsh-solar-rlm@0.1.0-dev.0` under `incubator/rlm`.

The identified installed commit below passed **local keyless installed-app acceptance**. The later reasoning-stream repair is source-verified separately and has not been installed by this follow-up. Isolated subscription trials are separate from real-provider acceptance inside the installed app and from efficacy conclusions.

## Identity and execution boundary

| Input | Verified identity |
|---|---|
| Prime source | Clean `7cbffa77b38facd7c87277fa3c82bcadbe816880`, CLI 0.10.0, MIT |
| Original native binary SHA-256 | `6e2780ce477b52e23f24afcc24fc332026aa628fa9cd9a7a25659b997e61cca0` |
| Offline capsule SHA-256 | `ffa9ef5854d625ee7f22dca0876867a78b886d1b249102f491e9a9ab56c1983d` |
| Python | Relocatable CPython 3.12.13, all nine Prime Python skills and pinned dependency closure |
| Source-to-loaded checks | 89 critical hashes, including 24 actual loaded Prime source/machine-data mappings; byte-for-byte match to the pin |
| Python third-party lock SHA-256 | `a7c8ef7ef10f84cca2a788601b4e5f444448812a9ad855af2bd4e891904fa2c7` |
| Host baseline | Published DSH 0.2.1-rc.2 / Cordis 4.0.5 |
| Environments | macOS arm64; development plain Node 26.7; installed Electron 44.7.0 / Node 24.21.0; source packages share host peer modules |
| Adapter/test/build input fingerprint | `149b6dc99064bdec51a75cc114d379c1a168e0a9f5b6af4d80a5dee11b32f907` (37 files; excludes generated `lib`, payload bytes and prose) |

The manifest and provenance are in `incubator/rlm/runtime-lock/capsule.json`; large runtime assets are generated and ignored by Git. No Prime source or official Harness runtime was patched. Source identity does not alone certify every provider behavior or evaluation case.

## Checks run

| Check | Actual result |
|---|---|
| Clean source, locked Rust release build, binary version/hash | Run: passed |
| Offline Python dependency/import/protocol-v3 checks and relocation | Run: passed |
| Actual capsule extraction and critical-file validation | Run: passed; hot validation also passed |
| DSH plugin metadata audit | Run: 7 OK, 0 warning, 0 error |
| Root build, strict typecheck and unit suite | Run: passed locally; final implementation CI also passed |
| Affected entrypoint recheck and Remote service binding | Run: 8 tests passed; rebuilt host/web/declarations and browser-loader check passed |
| Existing native-plugin scratch-profile gate | Run: passed, including Resident shutdown; no repeated run needed for unchanged native source |
| Built RLM package in disposable published-baseline profile | Run: passed, service and three ordinary tools registered |
| Actual original native RLM/Harness self-test in that profile | Run: all 14 checks passed; 18 scripted local protocol requests, 0 real-provider calls |
| Full `ctx.llm` bridge, follow-up, stop and original `--resume` | Run: passed; 3 local FakeAdapter dispatches, correct fixed route/context/output budget, linked intents/settlements, 0 paid-provider calls |
| Remove both test bundles and confirm profile bundle removal | Run: passed |
| Independent bounded adapter review | Run: reported defects repaired and rechecked; no remaining actionable finding in that review's scope |
| Homepage/market-guide regeneration and check | Run: passed; no published plugin entry invented |
| Existing-app installation and restart | Run: passed with the fixed artifact below, official desktop profile and unmodified app |
| Normal conversation and Settings controls; default/narrow UI | Run: passed; runtime status, explicit self-test, long results and scrolling inspected |
| Disable/re-enable and configuration preservation | Run: passed; contribution removed on disable, restored on enable; prior configuration and credentials unchanged |
| Real-provider/model acceptance | An isolated subscription pilot is tracked below; real-provider acceptance inside the installed app is not run |

The initial `pnpm check` reached the RLM integration lane and exposed a missing declared `llm` injection. It was repaired for both plugin and probe; the affected build/entrypoint/profile checks were rerun. A subsequent bridge failure came from the fixture selecting `off` for a model declaring no reasoning settings. The fixture now supplies the valid no-effort route; the Host preserves Prime's internal `--thinking off` without inventing a DSH provider effort. The final bridge passed. Passing unaffected native/unit evidence was reused; the failed aggregate command is not presented as a successful command.

## Native mechanism evidence

The explicit local self-test drives the **original native binary**, with a private agent directory/socket and a scripted loopback model. Python code, native requests and child receipts perform the computations; the fake controller does not substitute the answer.

- Persistent cells keep state across calls.
- Root → child → grandchild spawn, native child-exited continuations and collect produce the observed 42 → 43 → 42 receipt chain.
- A real Factory seed starts, reports status and is stopped through the original executor.
- Harness memory creation/update records the native revision change.
- `refine.run` moves pending state at the turn boundary; the original planner applies a real memory edit and records history.
- The following native provider context contains the original `refinement_notice`; original `/refine rollback` removes the entry and appends the rollback history.
- Native child roster, owned daemon shutdown, frontend exit and loopback cleanup are checked.

The next-turn refinement assertion concerns Prime's provider context, **not** a claim that one Python kernel hot-reloads another session-local Harness store. Factory live asyncio state remains memory-only across a cold kernel restart, as in the reference.

Adapter failure tests cover malformed ACP/framing, causal sequence and prompt mismatches, `end_turn` without native terminal evidence, outstanding descendants/continuations, unknown formats/effects, replay conflicts and restart recovery, full-tree request reservations, and cleanup despite persistence/transport faults. Confirmed native stop with an unsaved receipt is distinguished from an unconfirmed stop.

## Installed-app acceptance

| Installed input | Verified identity |
|---|---|
| Implementation commit | `6a47ed6afdc8e433f8748172322f93c8a56eb074` |
| Package | `@lisihao/dsh-solar-rlm@0.1.0-dev.0` |
| Stable artifact | `artifacts/rlm/6a47ed6afdc8e433f8748172322f93c8a56eb074/lisihao-dsh-solar-rlm-0.1.0-dev.0.tgz` in the main V4 checkout; no dependency on a disposable task worktree |
| Package SHA-256 | `5d64a1122d3c2afe8977178c4b90f4553063223da8d8dc1fbe0036bfc7684537` |
| Official app and profile | Unmodified DeepSeek Harness 0.2.1-rc.2; `desktop` under the existing `~/.dsh` |
| Source CI | [Passed on the implementation commit](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39370322903/job/118456492527) |

With the app fully quit, the built package was installed by the app's bundled `dsh plugin --profile desktop add <absolute-tarball>` command. Each affected profile configuration was backed up privately before installation. The installed host, web, Remote and Typert entries and capsule manifest match the verified package bytes. The capsule and original Prime binary retain the hashes above. The installer emitted a general peer-dependency warning and exited successfully; actual boot and feature checks, rather than that exit status alone, establish activation.

The official app started normally after installation and after another normal menu-driven quit/relaunch. No new web-boot crash report appeared; the latest remains the pre-fix report at 2026-10-20 11:40:49 Asia/Shanghai. The installed plugin manager showed RLM enabled. The normal **Prime RLM** conversation tab and **Settings → Prime RLM** both returned runtime-ready status. Opening or reading either panel did not run a self-test or contact a real model.

Four explicit installed-app checks were retained: initial mechanism acceptance, acceptance after re-enable, acceptance of the final displayed result, and final narrow Settings acceptance after the clean restart. Each passed all 14 native checks, used 18 local scripted responses, and recorded **0 real-provider requests**. The final two apply to the installed implementation commit above. They exercise actual original native Prime processes and Python, not a replacement recursion engine. Owned ACP/daemon and loopback cleanup passed; no plugin-owned Prime process remained afterward.

Rendered captures inspected the conversation view at the original wide window (2560×1640 captured pixels) and the Settings view at wide and narrow sizes (1800×1200 captured pixels at the narrow size). Text, buttons, explicit pending/completed state, long result wrapping and vertical scrolling were exercised. Internal runtime fingerprints and refinement record identifiers are omitted from the normal result text; the complete original diagnostic reports remain on disk. An earlier stale capture was excluded; live captures of the relevant final views matched their current controls.

The RLM switch was turned off and back on through the official plugin manager. Disable removed its conversation contribution; re-enable restored its control channel and a subsequent native self-test passed. After the final installation, all previous 40 bundles and dependency specifications remained unchanged, the profile held 41 bundles, unrelated profile configuration hashes matched the pre-install backup, and credential hashes matched. Only booleans are retained in the shareable acceptance summary. Private profile backups and raw runtime artifacts are not committed.

Source/CI acceptance, this zero-cost installed-app acceptance, actual real-provider behavior, measured efficacy and publication are separate evidence lanes. This candidate has no release tag or public market entry.

## Defects found and repaired

The initial source aggregate command exposed a missing `llm` injection and then an invalid `off` effort in the no-reasoning fake-provider fixture, as recorded above. Neither failed run is counted as a passing aggregate command.

The first installed artifact (`e02c8e7`, package SHA-256 `4874d751c92b623b8d7fb0cd60229701478ac396c7227ea3b5d1a2603340f730`) failed web boot with `ReferenceError: module is not defined`. Bare CommonJS lacked the published DSH `window.__ModuleLoader__.load` factory. A browser-context check reproduced the old failure and now verifies entry registration, shared React, slot activation, Remote mounting and disposal without Node globals during both build and plugin checks.

Live UI acceptance then exposed a Remote descriptor using the namespace `solarRlmControl` as its Cordis service key, while the active service is `solarRlm`. A regression test reproduced the mismatch; both the descriptor and Typert service model now point to the active service while retaining the wire namespace. A final display-only repair removed internal diagnostic identifiers from self-test text. These fixes did not modify Prime source or runtime bytes.

## Evaluation claims still unavailable

The [evaluation contract](prime-rlm-evaluation.md) remains separate from these engineering checks. G1 has source identity and representative native mechanism evidence; its complete F01–F12 differential matrix and real-provider coverage are not certified by this report. G2 has only a bounded single-task development pilot, not evidence of general reasoning-quality benefit. G3 original-paper reproduction and G4 held-out Continual Harness improvement are **not run**.

No measured reasoning, cost or latency improvement is claimed. Forced scripted recursion is plumbing evidence. Installation, unit tests, a native self-test or a passing CI job does not replace matched real runs, independent grading, full-tree accounting and negative controls.


## Bounded Codex subscription pilot follow-up

The four conditions use one frozen synthetic Q02 task (16,512 input bytes), the same `gpt-6.1-sol / high` route, serialized model calls, independent grading and a cumulative cap of 48 requests. E receives the full input with Prime code tools at native depth 0; S receives external input at depth 1; P0 receives external input at depth 0; D receives the full input without tools. Prime permits a root `rlm.create_session` independently of the spawn-depth guard, so P0 is not a complete no-subcall ablation. Factory and Harness refinements are disabled only for these matched trials; their native implementation is unchanged.

The original E trial passed. The first S trial was locally cancelled at its ten-minute deadline with no confirmed provider response; its reservation remains unknown and counted. Logs did not establish screen locking, display sleep, system sleep or a network outage as its cause. The original fetch-only HTTP hook missed the subscription provider's `node:https.request` proxy path, so its zero count is missing visibility, not zero inference. The runner now observes both paths before dispatch, fsyncs reservations, preserves unknown usage, restores the cumulative budget and explicitly cancels an unfinished native turn. A run-owned idle-sleep assertion does not change screen-lock settings.

The next S attempt exposed a distinct adapter error after five confirmed model responses: provisional reasoning deltas ended in two newlines while the authoritative reasoning block omitted them. The encoder's prefix check aborted the native response. Buffering only reasoning until its authoritative close preserves the exact final text, wire/replay identity and opaque provider replay state. Text and tool arguments remain streamed and prefix-checked. Prime source, native binary, offline capsule, RLM and Continual Harness mechanisms are unchanged.

The original captured response reproduces the old error and encodes completely with the repair without another model call. Eleven model-wire tests and strict TypeScript checking passed; the affected RLM suite passed 64 tests. Four native keyless conditions passed with the rebuilt host. The runner's separate budget/protocol/grader checks passed 25 tests, and its direct/proxy transport check passed one test. A local timeout fixture verified cancellation and unknown accounting. A full actual subscription-adapter/SSE decoder fixture was not covered by the fake transport test; the real pilot is the route-specific execution evidence. Private inputs, answers, model chunks, credentials and runtime artifacts are not committed.


The post-repair S, P0 and D trials completed; the already accepted E trial was reused. All four conditions scored 1/1 on this one task. S used six model requests (77.922 seconds including cleanup), P0 three (31.121 seconds), D one (21.231 seconds), and the earlier E two (30.431 seconds). These are single-run observations, not latency estimates. The two earlier S attempts remain separate: one ten-minute unknown and one adapter failure after five confirmed model responses. Cumulative accounting is 18 reservations: 17 confirmed responses and one unknown, all within the original 48-request cap. New proxy dispatches were individually observed; the first three retain the original HTTP-observation limitation. Whole-experiment usage/cost remains unknown because the first timeout has no confirmed usage.

All six successful S requests carried native depth-0 prompts. No descendant model request was observed in that trial, so it does not measure a recursive-child benefit. This small task also fits directly in model context. Equal exact scores therefore provide no quality-improvement evidence and cannot reproduce the original RLM paper's long-context conclusions. No further experimental calls were made to exhaust the budget.

The rebuilt package passed the disposable published-baseline profile gate, including the original native 14-check/18-scripted-response self-test, the three-dispatch local bridge/follow-up/stop/resume check and bundle removal. These checks used zero real-provider requests. Build, browser-loader validation, the 64-test RLM suite, strict typecheck and homepage/market-guide generation passed for the source repair. The official app and its earlier installed artifact were not updated during this follow-up; that installed artifact does not include this later encoder repair. Merge and publication remain separately authorized.


## Four-corpus MultiNLI follow-up and tool-argument repair (2026-10-20)

The later direct authorizations increased the cumulative experimental reservation cap to 146, then retained the original four frozen corpora and D1/E12/S12 allocation. No failed condition was replayed. The route remained Codex `gpt-6.1-sol / high`, output limit 16,384, one physical provider call at a time. All descendants and tool round trips count toward the same tree cap. The original Prime pin, binary and capsule were unchanged; Factory/refinement were disabled only for the comparison.

The preceding 32K OOLONG panel is invalid as a comparison: E downloaded public formality annotations and matched all 602 records. Its raw outcomes and all 28 requests remain charged. The repaired evaluator allows only each run's exact model-bridge TCP port; actual parent/child Prime Python probes were denied access to private gold, another loopback port and a direct IP, while native spawn/collect still worked. A separate ledger repair permits only proven, physically cleaned closed failures to unblock other unstarted conditions; it preserves unknown usage and prevents replay of the failed run. Nine local checks and actual failed-log-copy restore checks passed. A mistaken JSON-byte/token comparison was removed without changing model limits.

The replacement panel uses the fixed OOLONG dataset revision `81d2f8d9349f6ff329d695f9be494051e9f05cb9`, MultiNLI windows 70018, 70019, 70021 and 70022, and independently counts hidden `entailment` labels. Selection, order, inputs and the original numeric metric were frozen before responses. The four windows are correlated; this is exploratory, not a powered G2 or original-paper reproduction study. The real runs used source `911d0195a79237bd308dfdfb2bd737e5c5a00147`.

| Window / records | D absolute count error | E absolute count error | S absolute count error |
|---|---:|---:|---:|
| 70018 / 883 | 4 | Failed: HTTP 503 | 12 |
| 70019 / 883 | 16 | 16 | Failed: tree budget |
| 70021 / 1,772 | 7 | Failed: adapter errors, then tree budget | 5 |
| 70022 / 1,772 | 15 | Failed: adapter error, then tree budget | 16 |

All 12 conditions were attempted: eight completed, four failed, none was exact. D/E/S used 4/41/47 requests respectively. The three complete S/D pairs gave one S win and two losses; there is no complete S/E pair. Mean `0.75 ** absolute_error` over all four cases, assigning unfinished cases zero under the frozen intention rule, was D=0.1183190484, E=0.0025056489, S=0.0697509088. Assigning missing comparators one instead gives E=0.7525056489. The apparent S/E advantage therefore cannot establish quality improvement. Completed S trials used root depth only; the one trial with seven actual child requests exhausted its 12-request tree cap. Recursion-specific quality benefit, full G2, paper reproduction and held-out Harness benefit remain not established.

Cumulative accounting ended at **138/146 reservations**, with **135 confirmed responses and three unknown usages**. All unknowns remain charged, including the original timeout, HTTP 503 and one admitted stream aborted after native budget exhaustion. The first three physical observations retain the earlier visibility limitation. No paid API fallback or credits were used, and no further real requests were made after the fixed panel. All owned experimental processes and trial cleanup were confirmed. Raw private inputs, outputs, credentials and runtime logs remain local and are not committed.

Two E conditions exposed three tool-argument responses whose provisional and final JSON had equal semantics but different serialization. The old encoder had already emitted fragments, then rejected the complete arguments as a non-prefix. Native subsequent attempts consumed the same budget; this does not establish that the adapter was the sole cause of those failures. The encoder now waits for the authoritative tool block and preserves exact final arguments, call identities and replay state. Original Prime RLM and Continual Harness code and bytes are unchanged. Ordinary text keeps its prefix requirement.

Six encoder regression cases failed on the old implementation. With the repair, the RLM suite passed **71 tests**, strict typecheck and build/browser-loader checks passed, and all three captured faulty responses encoded and matched wire/replay arguments locally with **zero new model requests**. The required built-package disposable published-baseline profile passed: original native 14-check self-test with 18 local scripted responses, plus a four-dispatch local DSH bridge that executed Python and observed `RLM_TOOL_42 42`, continued, stopped and resumed the same native session. Both test bundles were removed successfully. No official-app installation, real-provider rerun of the repaired encoder, merge or plugin release occurred in this follow-up.
