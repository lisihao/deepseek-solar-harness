# Prime RLM verification record

Date: 2026-10-21, Asia/Shanghai. PR: [#280](https://github.com/lisihao/deepseek-solar-harness/pull/280).

Implementation and the earlier local installation are authorized. Later instructions authorize an isolated Codex subscription pilot using `gpt-6.1-sol / high`, initially with at most 48 cumulative model requests including root, tool-return and descendant calls, later increased explicitly to 146. The closed fixed-panel ledger charges 138 under its then-146 cap. The subsequent fixed four-game ARC panel is explicitly authorized for at most 384 new requests, cumulative cap 522. They do not authorize paid API fallback, extra-credit purchase, merge, release, tags, Pages or market publication. The package remains `@lisihao/dsh-solar-rlm@0.1.0-dev.0` under `incubator/rlm`.

The identified installed commit below passed **local keyless installed-app acceptance**. The later stream and autonomous-mode repairs are source-verified separately and have not been installed by this follow-up. Isolated subscription trials are separate from real-provider acceptance inside the installed app and from efficacy conclusions.

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

The [evaluation contract](prime-rlm-evaluation.md) remains separate from these engineering checks. G1 has source identity and representative native mechanism evidence; its complete F01–F12 differential matrix and real-provider coverage are not certified by this report. G2 has bounded real text trials and a fixed four-game ARC panel, without demonstrated general reasoning-quality benefit. G3 original-paper reproduction and G4 held-out Continual Harness improvement are **not run**.

No general reasoning-quality, cost or latency improvement is claimed. Individual task results are reported below. Forced scripted recursion is plumbing evidence. Installation, unit tests, a native self-test or a passing CI job does not replace matched real runs, independent grading, full-tree accounting and negative controls.


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


## Native autonomous admission and settlement repair (2026-10-20)

An audit against the fixed Prime source and the authors' ARC runner found that Solar's launch omitted `--autonomous`. Optional `autonomous: { maxTurns, maxTokens, gate? }` now admits the original native engine through existing CLI flags, including the admitted wall timeout. Omitting it preserves ordinary mode. Strict immutable `execution.json` snapshots restore the configuration on explicit cold resume. Legacy recovery requires journal proof of ordinary launches; unknown modes are fenced. Prime cold resume restarts its own autonomous counters, while Solar's durable whole-tree request count stays cumulative.

The first real native fixture reached three local responses and completed the Python/gate task, but Solar incorrectly fenced the run because `remainingAutonomousContinuations` was 2. The pinned native producer defines this as unused continuation slots, not pending work. The regression failed before the fix. Settlement now accepts nonnegative integer capacity only after current causal boundary/terminal evidence, zero outstanding children and `end_turn`; limits/errors/malformed metadata still fail or fence.

The affected suite passed **84 tests**, strict typecheck and build/browser-loader checks passed. The required built-package disposable published-baseline profile passed the original 14-check self-test, the four-dispatch bridge/Python/continue/stop/resume fixture, and the new autonomous fixture. The latter actually observed early text, native gate failure, original Python writing `gate.done=42`, native continuation to completion (three local requests), then stop and cold `--resume` with identical settings (four cumulative local requests). No model-error event occurred, and both scratch bundles were removed. These checks used **zero real-provider requests**; the experimental ledger remains **138/146**. The repaired source is not yet an updated installed-app artifact or measured quality improvement.


Independent review added a negative native gate fixture and stricter recovery evidence. A fabricated/truncated legacy launch cannot establish ordinary mode; recovery now requires the complete historical argv grammar and a versioned timestamped journal. A current successful terminal requires `terminalQuiescenceExpected=true`; positive capacity must include enabled native autonomous accounting. Native `gateFailure` is never accepted as success, including an `end_turn` envelope. Regression tests failed before these changes. The real default-limit negative fixture used four local responses and returned `gateFailure="exited with code 1"` with `max_turn_requests`; Solar preserved that native evidence and reported `failed` with `RLM_NATIVE_GATE_FAILED`. The final built-profile gate also checked the actual gate-failed continuation marker and prior Python/completion history after cold resume. All source/type/build and positive/negative profile checks passed; zero real-model requests were added.

### Direct-original differential and ARC readiness

`tools/rlm-native-parity.mjs` compared direct original ACP with the Solar Host using the same verified binary/capsule, task, native settings, model metadata and gate limits. Both arms used three local scripted responses, wrote an actual `gate.done=42`, and carried actual Python `TOOL_42 42` output. All nine comparisons passed: original OpenAI requests, input text, tool definitions, tool history/results, thinking fields, request parameters, native argv, adapter-versus-journal requests and tool results. Normalization was limited to owned isolated paths, actual session identities, time, and the Prime-generated conversation-log filename. Fresh builds of all three captured bundles matched their captured SHA-256 exactly; no native rerun was needed for the comparison-only correction. Owned frontend/daemon/provider cleanup passed. This is a bounded scripted adapter comparison, not full provider-private certification or quality improvement.

The fixed author ARC source `398d4dd63cf01d00adbea41c13437ba0b8ad40fc` was read outside the repository. Official anonymous acquisition returned HTTP 200 for the anonymous key, game list and all 25 exact metadata/source pairs (52 HTTP requests). Python 3.12.13, `arc-agi==0.9.9` and `arcengine==0.9.3` were prepared in a private evaluation environment, separate from the Prime capsule. Exact game/file hashes and original source hashes are retained privately.

Actual original broker observation loaded a 64x64 game frame, but its first action failed with `AttributeError: 'LocalEnvironmentWrapper' object has no attribute 'action1'`. The original failure remains recorded. An explicit test-only `sdk-step-adapter.py` now delegates those original action method calls to the pinned SDK's `step(GameAction, data=...)`, without editing the author checkout, SDK or Prime. Seven action mappings and ACTION6 coordinates passed a spy check; a separate real-game check observed `0 -> 1 -> 2` actions, then status with 498 actions remaining. Broker/socket cleanup and the clean author source were verified. This compatible test adapter is explicitly **not exact historical reproduction**; the Linux root/SO_PEERCRED guard was not run on macOS.

The user subsequently approved up to **384 new requests, cumulative cap 522**, for the frozen [four-game B/R/S plan](prime-rlm-arc-pilot-plan.json). At this source checkpoint, actual cumulative usage remains **138**, including the same three unknown usages. Runner, trusted game proxy/scorer and native isolation acceptance are still being implemented; no real ARC model condition has started. B/S compares the full Prime game harness, while R/S checks the plugin against direct Prime under a shared model transport. The author game protocol forbids recursive subagents, so no ARC result from this panel can establish recursion-specific gain. No failed or adverse earlier result is removed.

## ARC runner source acceptance (2026-10-20, before model launch)

The evaluation tools under `tools/rlm-arc-pilot/` now implement the fixed B/R/S order, strict route, durable logical and synchronous physical admission, official attachment restoration, independent trusted-broker scoring, and separate completion/cleanup fields. All 138 historical charges, including the three unknowns, are retained in a new ledger. Unknown streams are charged and fence continuation. Per-condition model requests, known/missing usage and elapsed time are recorded; absent usage is not converted to zero. A previously confirmed broker WIN is retained even if later inspection or cleanup fails. B and R/S have different frozen guidance, so their contrast includes that difference.

The project full gate passed 162 unit tests, 28 then-current ARC checks, built-package registration and the homepage check (`/private/tmp/rlm-arc-runner-full-check.log`). Subsequent focused checks cover the added resource/missing-usage case and end-to-end retention of a trusted WIN after broker close (`/private/tmp/rlm-arc-win-retention-tests.log`). The portable ARC command is `pnpm test:arc`; the macOS Node/socket check is separately explicit. These are zero-model evidence.

After the optional internal native depth setting was added, the original/plugin differential was run again against the current compiled host. `/private/tmp/rlmpar-sDGTY6/report.json` passed all nine categories, three local responses per arm, actual Python/gate artifacts, and owned cleanup; real-model requests were zero. The ARC host forwards native `rlmMaxDepth: 0` before session creation, rather than changing it after constructing the initial model request. Production configuration omits this override.

Actual Prime-in-sandbox acceptance remains a separate launch gate. Node metadata traversal and Prime's native worker socket directory must be allowed narrowly: generated worker sockets live under the run's `TMPDIR`, and the original Mac implementation falls back to a global temp directory if that path is too long. The evaluator therefore uses short run directories and checks generated worker path length before launch. These changes do not patch Prime. No ARC model outcome is reported by the checks above; cumulative charged reservations remain 138 until the real panel begins.

The real native R/S isolation smoke subsequently passed in `/private/tmp/ank-dqRqpy`: each arm made three local scripted requests, loaded native depth zero before the first prompt, executed the original persistent Python kernel, observed the real `ar25` frame and two actions (ACTIVE, action counts 1 then 2), and observed the original terminal gate remain pending. The separate fixture completion gate passed, with native barrier and owned daemon/frontend/bridge cleanup. The third request in both arms carried the native image placeholder; the official store returned an actual PNG reference whose `readImage` bytes matched the 90-byte clean RGB fixture, SHA-256 `af8d8a963072760a6cf2d2c4aab7d198f95c141f4fd66c37442a5b3fe7f58419`. The gray fixture's earlier WebP result was official normalization, not evidence of a transport failure. This check does not promise byte identity for arbitrary images. Local source, corpus, provider/other-run and network-denial probes passed, including temporary-directory aliases. Real-model requests remain zero for these checks.

The final native smoke `/private/tmp/ank-gpLUtk` used the parameterized `native-acceptance.mjs` and current worker/sandbox sources. R and S each emitted actual Python `ARC_PYTHON_DENIALS 3 1,1,1` after denied corpus read, credential-path read and external-IP connection; image readback again matched the clean RGB SHA above. Both exited zero with three local scripted requests and complete native cleanup. `pnpm test:arc` also covers aborting an in-flight parent stream when its worker exits; the unknown charge remains reserved. All real-launch gates are now satisfied locally, before the fixed panel starts.


The final portable ARC suite passed **31 checks** and PR CI passed at source commit `37a63d48f281e1ff0b8f7055fa155514ef70395a`. The real fixed panel then began. Its first S/ls20 condition retained two cleared levels but no WIN and stopped with one additional unknown request; cumulative charges became **170/522**, **166 confirmed and four unknown**. Original native shutdown, worker exit and guard/engine socket removal were verified. The original manifest, panel receipt and condition result remain immutable. This is an incomplete panel, not evidence of comparative efficacy. The [protocol record](prime-rlm-arc-protocol.md#observed-workspace-adaptation-in-the-fixed-panel) records the observed legacy-path and bootstrap deviations and the transport-before-budget chronology.


The first continuation's source gate passed 37 portable ARC checks and CI at `075a63f9e9df96870cc81e7d47273236cbf885a6`. R/ls20 completed its 32-request attempt with two levels and 131 actions, no WIN and full cleanup. B/ls20 then failed in the evaluator's stream-consumer path before a game action. Its one physical request stays charged unknown; the original failed control is retained, not rerun, and cannot establish a model-quality difference. Cumulative accounting at the second pause is **203/522, 198 confirmed and five unknown**. The [protocol record](prime-rlm-arc-protocol.md#baseline-stream-consumer-failure-and-repair-boundary) describes the root cause and explicit changed-file boundary.


The baseline-consumer repair passed **44 portable ARC checks**. The EOF-order and post-finish EOF-error regressions fail on the preceding source and pass after the repair. A separate zero-model replay used the actual compiled `model-wire.mjs`/`ReplayRegistry` and the captured B203 chunks: the synthetic ledger settled one local replay with zero unknowns before its `observe` tool ran (`/private/tmp/arc-captured-drain-CxNNIu/report.json`). Unexpected trailing chunks, errors and cancellation do not execute game tools; cleanup errors do not hide the primary stream error. Native runtime and compiled plugin bytes are unchanged. This evidence validates the evaluator repair, not a real-game success or reasoning improvement.


## Completed fixed ARC panel (2026-10-21)

All 12 frozen B/R/S conditions were attempted once. Trusted full-game WIN was **0/4 in every arm**; all final games remained ACTIVE and all owned cleanups passed. The panel charged **325 new requests**, cumulative **463/522**, with **456 confirmed and seven unknown** including historical charges. No request remains in flight and no failed condition was replayed. The 59 unused requests were not reassigned.

The [complete result and limitations](prime-rlm-arc-results.md) retain the invalid B/ls20 control, two later baseline context-window failures, all native request-cap stops, observed path/bootstrap deviations and the exact execution-version boundary. S cleared more levels than B on one of three usable controls and fewer on two; it did not establish stable benefit. The author protocol disables recursive children and refinement, so this is not RLM-recursion or Continual Harness effect evidence.

Post-panel source closes the completed plan to new provider runs and mechanically normalizes two staged prompt paths for any separately approved future preparation. Original results, prompts and receipts are unchanged; the path correction was only checked without a model. The installed app has not been updated by this follow-up.

## Completed native recursion comparison (2026-10-21)

The [frozen recursion protocol](prime-rlm-recursion-protocol.md) and [complete attempt report](prime-rlm-recursion-results.md) separate native depth zero and one, using original Prime, identical task bytes, gpt-6.1-sol/high and equal 14-request whole-tree ceilings. All eight declared conditions remain in the denominator: two completed, four transport failures, two not run. The one completed pair used 11/14 requests, including eight real depth-one child calls in S; both output schemas and owned cleanup passed. Pair F1 was S0=0.307692, S=0.240000; label accuracy was 408/438 versus 404/438. Child files contributed all final S labels unchanged, and aggregation was self-consistent, so this is a semantic-quality negative result for one task rather than missing recursion or a transport failure in that pair.

The follow-up charged 43 new requests, 39 confirmed and four unknown. The cumulative ledger is **506/522, 495 confirmed plus 11 unknown**, with zero in flight and 16 unused. Parent-only networking changes did not alter Prime, installed provider bytes or model parameters. Twenty-five final-pair calls completed without a new transport failure; underlying intermittent network stability remains unproven. Exact paper reproduction, general quality improvement, held-out Continual Harness benefit and a new installed-app artifact remain unestablished.

Final local source acceptance passed build, strict typecheck, 162 Vitest tests, 46 ARC checks, 50 then-current recursion checks, built-package disposable-profile registration/runtime status and homepage generation consistency. The older optional full native self-test/bridge/autonomous probes were not selected in this gate; the separately accepted native recursion proof covers this change's original-engine mechanism. A final one-shot output-namespace guard then passed all 19 affected revalidation/network checks, including two new cases preventing a new directory from reusing an old charged prefix. No new model call was made for either check. Remote full-gate status belongs to the final PR head and is separate from these local results.

## Original TREC pilot and retrospective Q03 bare supplement (2026-10-21)

The [TREC attempt report](prime-rlm-bare-quality-results.md) preserves two infrastructure failures, their unstarted S comparators, and the final D/S attempt. Bare D completed with 291 against 314; S saved 269 after thirteen root calls, made no child request and was cancelled before its next admission. That is not a completed quality pair. Accounting reached 522 = 509 confirmed plus thirteen retained unknown.

The user then approved one supplemental bare Q03 request and raised the overall ceiling to 600. That request completed and settled once, with all 438 labels present. Independent arm-blind regrading of both final answers gives primary pair F1 D=0.205882, S=0.240000, while label accuracy is D=408/438, S=404/438. The [full mixed result](prime-rlm-q03-bare-supplement-results.md) retains precision, recall, false positives and the earlier negative S0 comparison. It is one retrospective main-metric benefit from a completed, actually recursive S run, not original-paper reproduction or a general/causal improvement. Usage is 523 = 510 confirmed plus thirteen unknown, with no in-flight request. The underlying Codex SDK does not serialize the configured output-token maximum; actual reported usage is retained.

The next [fixed three-arm protocol](prime-rlm-three-arm-protocol.md) compares direct original Prime and the plugin against bare D on an original question with declared common strategy guidance. Its native and real-provider outcomes remain pending at this checkpoint. No installed-app update is included.
