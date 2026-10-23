# Fixed four-game Prime ARC comparison

Date: 2026-10-21, Asia/Shanghai. PR: [#280](https://github.com/lisihao/deepseek-solar-harness/pull/280).

**This panel did not demonstrate a reasoning-quality improvement.** All twelve fixed conditions were attempted once; B, R and S each observed **0 WIN out of 4 games**. All final trusted observations were ACTIVE, all executions remained incomplete, and all owned cleanups passed. Completing the planned attempts is not completing the games. One B control is invalid because of an evaluator defect.

The secondary progress results are mixed. On the three games with a usable B control, S cleared more levels once and fewer twice. Relative to direct original Prime, S cleared more levels twice, fewer once and the same number once. These single attempts do not establish a stable advantage or engine equivalence. Different games have different level structures; summing cleared levels is not the primary metric.

## Frozen method

B is the ordinary structured game-tools baseline with raw JSON frames and its separately frozen brief guidance. R launches the unchanged original Prime directly; S uses the compiled Solar RlmHost/plugin with the same binary, author guidance, native settings and shared Codex codec. B versus S compares the complete supplied workflows, including their different guidance and representations. It is not a prompt-matched engine contrast.

Every condition used Codex `gpt-6.1-sol / high`, seed 0, at most 32 physical model requests, a one-hour wall cap, at most 500 environment actions and batches of at most 20 actions. Only one physical model request was active at a time. Unknown requests remain charged; no failed condition was replayed or replaced. The four cases and their order were frozen before any model response.

The author ARC guidance forbids RLM children. R/S therefore loaded original native depth zero before session creation, with Factory and Harness refinements disabled. **This panel does not measure recursion or Continual Harness improvement.** It uses original Prime CLI 0.10.0 and a test-only SDK step facade on macOS, rather than the historical author CLI/model/Linux deployment. See the [protocol and deviations](prime-rlm-arc-protocol.md) and [original source](https://github.com/PrimeIntellect-ai/arc-agi-3-prime-agent/tree/398d4dd63cf01d00adbea41c13437ba0b8ad40fc).

## All fixed outcomes

Each cell is **levels cleared / environment actions / charged model requests**. No cell reached WIN.

| Game | B: ordinary tools | R: original Prime | S: Solar plugin |
| --- | ---: | ---: | ---: |
| ls20-9607627b | 0 / 0 / 1 (invalid control) | 2 / 131 / 32 | 2 / 97 / 32 |
| cd82-fb555c5d | 1 / 81 / 24 | 2 / 44 / 32 | 4 / 68 / 32 |
| sp80-589a99af | 3 / 42 / 12 | 2 / 23 / 32 | 0 / 40 / 32 |
| lp85-305b61c3 | 7 / 195 / 32 | 4 / 64 / 32 | 5 / 60 / 32 |

| Arm | Trusted WIN / fixed denominator | Requests | Confirmed responses | Unknown charged |
| --- | ---: | ---: | ---: | ---: |
| B | 0 / 4 | 69 | 66 | 3 |
| R | 0 / 4 | 128 | 128 | 0 |
| S | 0 / 4 | 128 | 127 | 1 |

The panel used **325 new physical requests**. With 138 retained historical charges, cumulative accounting is **463/522 = 456 confirmed + 7 unknown**. Logical admissions, physical admissions and settlements match; none remains in flight. The 59 unused requests were not reassigned to new games or repeated attempts. No paid API fallback or extra credits were used.

Known token fields and elapsed times are retained per condition in the [sanitized machine-readable results](prime-rlm-arc-results.json). Usage fields are kept as reported by the provider, without reconciling cached or other token categories into an invented total. Missing usage remains missing, never zero; monetary or latency superiority is not claimed.

## Failures and validity

- S/ls20 received HTTP 200 for request 170, then ECONNRESET before a later native retry hit the 32-request cap. Its remote cause is unknown. Two levels and 97 actions are trusted progress, not WIN. The unknown request remains charged.
- B/ls20 hit a baseline stream-consumer bug after its authoritative observe response. Observe executed, but no game action did. The response was not fully drained, the ledger fenced another admission, and its one request remains unknown. This control is invalid for a quality contrast. It was retained and never replayed. The consumer repair was accepted before the remaining unstarted conditions.
- B/cd82 and B/sp80 stopped on actual CONTEXT_WINDOW_EXCEEDED responses after 24 and 12 requests respectively. Each retains one unknown request with missing usage. These are workflow resource failures; they are distinct from the earlier consumer defect.
- Every R/S condition used its 32-request allowance without WIN. Native/bridge terminal errors remain in the raw receipts; an ACTIVE game is not marked completed because the allowance ended. B/lp85 also used 32 requests, cleared seven levels and 195 actions, and remained ACTIVE.
- The automatic score uses trusted broker observations and leaves protocolReview=not-reviewed. A separate bounded audit checked final journals and R/S tool histories, including last native cells: no child or action-submission loop was found in that review. Local search loops and loops constructing one action batch are not action-submission loops. The review remains partial, not complete author-protocol certification.
- The frozen R/S initial prompt referenced missing /workspace paths and the legacy client name. Both recovered the staged working-directory guidance/client; initial rejected bootstrap batches were blocked before the engine. This common R/S adaptation consumes budget and differs from B. It is not hidden or repaired retroactively in these outcomes.

## Execution versions and retained evidence

The original manifest and result files were never rewritten. The original run-receipt records only its first phase; four sequential continuation receipts retain the later attempts. The final analysis and sanitized JSON aggregate all twelve conditions, rather than relabeling the first receipt as final. Unstarted-only continuations bind the original manifest, immutable earlier results/start markers, closure proof, and exact accepted execution bytes. Unknown calls were closed only after transport/process/socket cleanup; they were neither refunded nor reclassified as successful.

| Conditions | Executed source head |
| --- | --- |
| First S/ls20 | `37a63d48f281e1ff0b8f7055fa155514ef70395a` |
| R/ls20 and failed B/ls20 | `075a63f9e9df96870cc81e7d47273236cbf885a6` |
| Remaining nine conditions | `10ade5f2f58a70373984051f01d28ecb8dbcb1c0` |

The native runtime and compiled plugin stayed unchanged across these repairs. R/S share a transport codec, so this is not an independent provider-private protocol control. All twelve per-result hashes, ledger/manifest hashes, source heads and resource fields are in the sanitized JSON. Raw model content, credentials, game implementations and private runtime files are excluded from Git.

| Evidence identity | SHA-256 |
| --- | --- |
| Original approved plan | `256608c1f9424dace9e13b4690ad1e29174b91a1567889fbe7da1c938405672a` |
| Original manifest | `5f437ee56760060d891e3988291a9eea5679fce050236ce1e507c0e3a549cb0d` |
| Final provider ledger | `d877c1006a6967bd064ffd30b28b2093e8525eb75685d304f06180d0f3bb4a32` |
| Frozen preparation fingerprint | `c2d55d0d8f60118e3d7fdcd548e85304fb85aea92a27c19487c5fa4521b11f22` |

## Post-panel fixes and delivery boundary

After all model conditions and cleanup had ended, the default plan was marked completed. New prepare/run/resume attempts using that completed plan are rejected before compilation, provider loading, credential access or start-marker writes. Non-provider analysis can still generate derived reports. The original approved plan bytes are preserved privately and at the measured Git heads. The budget section in the completed plan describes the original authorization snapshot, while its completion section gives actual spending.

Future preparation now translates only the two fixed author /workspace references to the staged guidance and client paths, records both original and rendered prompts plus the exact mapping, and retains the original guidance/client bytes. This mechanical correction is covered by zero-model file/staging tests. **It was not applied to the measured panel and has no real-model efficacy evidence.** Another experiment still needs explicit approval.

These are source-only follow-up repairs. The previously accepted installed app artifact remains the earlier identified commit in the [verification record](prime-rlm-verification.md#installed-app-acceptance); this panel does not imply an updated local installation, a release or a market publication. The original-paper and held-out Continual Harness efficacy gates remain not run.


## Final source validation

The final affected portable ARC suite passed **46 checks**, including the completed-plan no-side-effect gate and all twelve synthetic prompt/file stages. Homepage and market-guide regeneration/check passed without changing the released-plugin list. The native runtime and compiled plugin were not changed after the earlier accepted original/plugin differential and real isolation smoke, so that evidence was reused. Full required PR CI is reported separately on the final pushed head; no installed-app acceptance was repeated or implied.
