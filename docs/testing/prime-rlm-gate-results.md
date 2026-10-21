# Native-limit panel: observed plugin gains over bare

Date: 2026-10-21, Asia/Shanghai. **The recursive plugin outscored its paired bare-model run in two exploratory epochs of one original OOLONG question.** Main scores were S=0.75 versus D=0.5625; a fresh paired repeat gave S=0.75 versus D=0.177978515625. These are real subscription runs with independently recomputed official scores, not local scripted self-tests. The [sanitized JSON](prime-rlm-gate-results.json) contains complete condition-level accounting and evidence hashes.

This establishes an observed whole-plugin benefit on this problem under the tested unequal-compute settings. **It does not establish a recursion-specific benefit:** the main panel's recursion-disabled S0 also scored 0.75. Scores are the official numeric-error metric, not accuracy percentages; neither completed S answer is exact. One reused question cannot establish a stable or general reasoning improvement, significance, held-out confirmation or exact paper reproduction. An older same-question bare run also scored 0.75 and remains visible in the [previous panel](prime-rlm-controlled-results.md).

## Completed conditions

The fixed four-condition panel used source `78f4f9b954653a628a91ea56a1244b9184c345e7` after the [native-limit controls](prime-rlm-gate-protocol.md) passed. Each condition was attempted once. R/S/S0 had the same 32-request whole-tree ceiling; their actual consumption differed.

| Main condition | Task result | Official score | Root / child requests | Elapsed time |
| --- | --- | ---: | ---: | ---: |
| D1, bare model | Completed | 0.5625 | 1 / 0 | 404096 ms |
| R32, original Prime | Incomplete; no final answer | Unscored | 7 / 25 | 394869 ms |
| S32, recursive plugin | Completed | 0.75 | 11 / 11 | 433303 ms |
| S0_32, non-recursive plugin | Completed | 0.75 | 12 / 0 | 267966 ms |

After the main result and its first-request envelope audit closed, a new namespace froze one D1/S32 repeat on the same task and same source. The maximum was 33 new requests, charged from the actual cumulative prefix of 743. It used 26; neither condition was retried. This is an additional exploratory epoch, not a replacement of any earlier failed or adverse attempt. R and S0 were **not** rerun in this epoch.

| Repeat condition | Task result | Official score | Root / child requests | Elapsed time |
| --- | --- | ---: | ---: | ---: |
| D1, bare model | Completed | 0.177978515625 | 1 / 0 | 244240 ms |
| S32, recursive plugin | Completed | 0.75 | 13 / 12 | 490128 ms |

The paired score differences are +0.1875 and +0.572021484375. They describe these outputs, not an estimated population effect. Bare scores vary substantially across retained runs; selecting only a convenient older baseline would be misleading. The main S−S0 difference is zero. No recursion-specific repeat contrast exists, and the earlier Q03 recursion ablation favored S0. No task-family or routing threshold is inferred here.

## What was held fixed, and what differed

Both epochs used `openai-codex/gpt-6.1-sol`, high reasoning, the same full 787-record original question, unchanged official scorer and common operational guidance. D receives the context inline with no tools and one request. The plugin receives the exact context through a file and can use persistent Python, files and native recursive children. This compares the complete computation-enabled operator with a bare response; it is not an equal-compute or tools-only comparison.

The task is `oolong-trec-32k-15000243` from `oolongbench/oolong-synth@616cca899e8b51ea0ad5446ebab39aa72b3192bc`. The original scorer is pinned at source `0bb7eabe839218fee7fe8d007f41cfcf2fd3ae24c`, SHA-256 `247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c`. Independent grading read each actual final answer and recomputed its score; private gold and label data were not supplied to the agents or published. Original data/scoring does not make these different-model, adapted-prompt, reused-item runs a reproduction of the original paper.

The pinned Prime binary and Python/runtime remain unmodified at `7cbffa77b38facd7c87277fa3c82bcadbe816880`. All native arms explicitly receive original gateMaxRetries=32 and maxContinuations=32, maxTurns=32, maxTokens=4000000 and a 1200000 ms wall limit. R/S use native depth one; S0 uses depth zero. Factory and refinement learning are disabled. Production omissions still preserve the original native defaults. The separate zero-model controls verified strict native completion, original R/S recursion and depth-zero rejection; they are mechanism evidence, not these quality scores.

Configured model maxTokens is 16384. The subscription SDK does not serialize a backend output-token ceiling, so enforcement is not claimed. The JSON preserves reported input/output/total usage, including cache-related totals; these fields are not recomputed or converted into a monetary price. All root, tool-return and descendant requests are counted.

## Original/plugin differential and actual recursion

The first actual R/S request options match after normalizing only exact owned run-directory prefixes, the conversation-log path line, top-level sessionId and message ids. Dates, task semantics, tools and route remain intact. The normalized SHA-256 is `5f7d85d16ce50f10867c9842e6ffa0fd2e08db267c8dc88840a8af61a4863787`. This checks the initial provider envelope; it does not prove trajectory equality or equivalent completion probability.

The main S run has two actual depth-one children. Their output files contain 394 and 393 records. A dedicated read-only witness verifies that the root reads both files and that the 787-record aggregate has the same record/ID sequence, unique continuous IDs, and no merge conflict before final-answer writing. This is actual child contribution, not only a populated roster. The model used original `rlm.spawn` and file-based aggregation; no explicit join/collect call was observed in this real run. The separate scripted native proof covers settled collect. Coverage and merge consistency do not establish that every semantic label is correct.

Main S0 recorded twelve root requests, zero child requests and native depth zero, with no recorded Factory/helper-session bypass. Its completed answer earned the same score as S. The repeat independently records thirteen root and twelve child requests at depth one; its grading/accounting passed. The detailed per-record contribution witness above applies to the main epoch only.

## Why original Prime remained incomplete

R consumed its entire 32-request tree budget: seven root and twenty-five child requests. The final visible root and two child responses ended with `ARC_REQUEST_LIMIT`; three further bridge attempts were denied before any provider dispatch and add no physical model requests. Native metadata reports zero autonomous continuations used. No actual gate-failure/limitReason evidence was present, so this run is not relabeled as a native gate failure.

The native worker ended normally with exit code zero and cleanup complete, but no final answer existed. It therefore remains a task-level incomplete, unscored outcome. Process completion, a completed child status and partial classification files are not substitutes for an accepted answer. The evidence supports tree-budget exhaustion here; it does not show that the wrapper generally outperforms original Prime, that larger limits fix every failure, or that the earlier lock-screen hypothesis caused this result.

The optional native-limit forwarding repaired an operational configuration gap. Its local default-versus-explicit controls demonstrate that the separate default continuation and gate-retry limits could stop fixture work early. Raising both passed those controls without changing Prime. The real quality differences cannot be attributed solely to that repair because outputs and trajectories are stochastic and earlier outcomes remain mixed.

## Accounting, independent verification and delivery

The main panel added 67 confirmed logical/physical requests, closing at 743. The repeat added 26, closing at **769 = 755 confirmed + 14 retained unknown, zero in flight, under the 800 cap**. No new unknown occurred. The 14 historical unknowns remain charged, and all earlier failed/incomplete/adverse results remain retained. The remaining 31 requests are unspent; unused capacity is not a reason to add more exploratory draws.

Independent verification reproduced all completed scores, compared ledger totals and per-arm limits, bound task/source/compiled/runtime hashes, checked native depth, S0 recorded controls and first-request R/S equivalence, and reported no mismatches. Main and repeat closed their provider, relay, network and long-read resources. External process/socket probes found no qg1/qg2-owned process; all retained daemon sockets refused connections. No process was killed or IPC file deleted by these probes. Failed verifier attempts were retained and corrected without model replays.

The unchanged implementation source passed build/typecheck, 165 Vitest, 46 ARC, 57 recursion and 37 quality checks, built-package disposable-profile behavior and homepage consistency. Its [source CI passed](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39578708699); those applicable checks are reused for this report-only update. Native proof and current execution hashes are recorded in the JSON. Main independent-verification SHA-256 is `dbabb4aec2f2d3820c99b4a46142c03f8ce6f67cf3f5a023ba1fa82943fc12d0`; repeat is `072116f8c98af610483158dd3abe8c4f7f37242edaac291c212032379d8655d3`.

These are isolated real-provider source evaluations. The installed plugin remains the earlier `6a47ed6afdc8e433f8748172322f93c8a56eb074` artifact; this repair/report has not been installed. Installed-app local self-tests, installed-app real-provider acceptance, source experiments, general efficacy, Continual Harness learning benefit and publication remain distinct. No paid API fallback, credit purchase, merge, release, market publication or automation was performed. Raw/reference answers, private labels, sessions, provider payloads and account data remain outside Git.
