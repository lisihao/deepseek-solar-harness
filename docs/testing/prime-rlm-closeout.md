# Prime RLM candidate closeout and research handoff

Date: 2026-10-23, America/Toronto. Audience: the owner and a later Argon/Opus reviewer. This closes the current engineering iteration as an **installed development candidate with explicit acceptance gaps and no stable market release**. It pauses efficacy exploration; it does not certify general usability, recursion-specific quality improvement, full reference fidelity, or publication.

## Decision and scope

Keep the existing ordinary-conversation operator and Settings diagnostics. Freeze the current Prime pin and adapter behavior. Do not run new model experiments, update Prime, change models/reasoning, modify native algorithms, reinstall, merge PR #280, or publish as part of this closeout. The existing separately authorized community watcher remains a read-only evidence source; a reply is not permission to restart implementation or experiments.

The user's goal remains valid: demonstrate a reproducible quality gain on some problems, then use that evidence to decide when DSH should invoke RLM. That goal is **not achieved by this closeout**. Task-family recommendations and cost-based routing thresholds come after credible quality evidence, rather than being inferred from the present small sample.

## Frozen delivery identity

| Item | Identity / boundary |
| --- | --- |
| Plugin | `@lisihao/dsh-solar-rlm@0.1.0-dev.0`, `incubator/rlm`, macOS arm64 |
| Source checkpoint before this documentation change | `d25df9c5fd5ac8eaf8f76146cc4f88ccee57fcb2` |
| Installed executable-source commit | `817d6a998ed4b0c7d120590404efe146d71bd6b5` |
| Installed packed artifact SHA-256 | `320e0e74a8dac4161e1f5cd238dc22d636f207ba9d6b0fc8902f0e0fd5cb87c4` |
| Original Prime source | `7cbffa77b38facd7c87277fa3c82bcadbe816880`, CLI 0.10.0, MIT |
| Native Prime binary SHA-256 | `6e2780ce477b52e23f24afcc24fc332026aa628fa9cd9a7a25659b997e61cca0` |
| Offline capsule SHA-256 | `ffa9ef5854d625ee7f22dca0876867a78b886d1b249102f491e9a9ab56c1983d` |
| Host baseline | Published DSH `0.2.1-rc.2`, Cordis `4.0.5`; official Desktop, no app patch/build |
| Delivery | [PR #280](https://github.com/lisihao/deepseek-solar-harness/pull/280), open and unmerged at closeout inspection; no release tag or market publication |

The local stable artifact is under the main V4 checkout at `artifacts/rlm-operator-20261022/817d6a9/lisihao-dsh-solar-rlm-0.1.0-dev.0.tgz`. On 2026-10-23 a read-only comparison checked all 37 regular package files against the installed package: zero mismatches. This reuses the earlier installation; it is not a new installation or a runtime test.

## Public preview versus this installed candidate

The current `v4` curated catalog independently distributes an **older preview** from `6a47ed6afdc8e433f8748172322f93c8a56eb074`, archive SHA-256 `5d64a1122d3c2afe8977178c4b90f4553063223da8d8dc1fbe0036bfc7684537`. It has the older standalone view and asynchronous tools. It is not the installed `817d6a9` ordinary-operator artifact identified above, despite their identical development version strings. Preview download availability is separate from a stable Solar market release; this closeout replaces neither the public archive nor its catalog identity.

The feature branch also synchronizes the current `v4` homepage/distribution documentation and preserves its curated-distribution checks alongside the RLM checks. No RLM executable source changes are introduced by that synchronization. Do not mistake a feature-branch synchronization for merging PR #280.

## What is implemented and what actually passed

Prime owns the original Rust daemon/session engine, persistent Python REPL, recursive children, messaging, Factory, Harness CRUD, refinement and rollback. Solar owns DSH tool registration, input snapshots, process ownership, model-transport conversion and evidence. Native source patches carried: **none**. The custom provider bridge is an explicit adaptation, not proof of equivalence to Prime's official provider route.

| Evidence lane | Actual state |
| --- | --- |
| Ordinary operator | `solar_rlm` is registered; explicit task/cwd/tree-request/time limits; waits for a native result and returns it to the parent tool call. Async `solar_rlm_run`, `solar_rlm_inspect`, `solar_rlm_control` remain available. |
| Result/error lifecycle | Failed, cancelled, indeterminate and empty-answer rounds remain errors. Inspection does not replay a task. Known-session follow-up/resume uses Prime's native mechanism. |
| Source checks | Previously passed build/typecheck, 174 Vitest, 46 ARC, 57 recursion and 37 quality-runner keyless checks. Reuse applies to unchanged executable inputs; RLM executable inputs are unchanged; branch synchronization preserves both sets of check commands. |
| Ordinary Agent loop in a disposable profile | Passed using the built package, an actual local DSH Agent/Session and scripted providers: model-visible schema, original Prime Python call, result returned to parent, durable tool call/result and session flush. |
| Installed GUI and native mechanism check | Recorded passed: Settings-only entry, old conversation slot removed, wide/narrow rendering, 14 native checks using 18 scripted responses and zero real-provider requests. |
| Installed ordinary conversation with a real parent model | **Not run** for the ordinary-operator build. Real-model discovery/selection and complete installed real-provider execution are not accepted by the scripted checks. |
| General provider compatibility / full fidelity matrix | Not established. Native mechanisms and selected bridge paths have evidence; complete official-provider trajectory parity does not. |
| Original-paper reproduction / held-out Continual Harness gain | Not established / not run respectively. CRUD/refine/rollback mechanism evidence is not a learning-benefit experiment. |
| Merge / release / market | Not performed. This remains a development candidate. |

The host startup authentication incident was recovered separately by backing up and removing only DSH's accumulated local auth cookies. That is not an RLM quality result. Historical verification sections describe older checkpoints; use the latest ordinary-operator installed acceptance and this table for current scope.

## How the frozen operator is intended to be used

In an ordinary DSH conversation, ask the assistant to invoke RLM for a named task and workspace. The model supplies explicit request/time limits within configuration caps. Tool assembly/filtering and the model determine whether it discovers/selects the operator; registration does not force use. Settings is a maintenance/diagnostic surface, not a second chat interface.

Selected inputs are immutable file snapshots and read programmatically. State lives under `$DSH_HOME/solar/rlm`. Results exposed to the parent are bounded to 32,000 characters; complete evidence remains in linked journals. Prime runs code with native OS permissions, not inside a general-purpose Python sandbox. The bridge supports an inspected Chat Completions subset; unsupported fields/mappings fail explicitly.

Default configuration caps are 100 logical model requests and 3,600,000 ms, with an explicit smaller/equal allowance per run. Requests include descendants and refinement; provider-internal retries and missing billing usage prevent treating this as a universal monetary cap. Native autonomous gate retries and continuations default independently to three when omitted; increasing `maxTurns` alone does not increase them. See the [plugin README](../../incubator/rlm/README.md) for the actual configuration contract.

Factory is opt-in. Continual Harness mechanisms remain present, but the quality comparisons disabled Factory/refinement equally to avoid mixing recursion and learning. Live Factory asyncio state is not reconstructed after a cold kernel restart.

## Quality evidence: retain both gains and counterexamples

All completed conditions below used Codex `gpt-6.1-sol / high`. These are isolated source evaluations, not the unrun installed ordinary-conversation acceptance.

| Comparison | Observed result | Supported interpretation |
| --- | --- | --- |
| Q03, 438 MultiNLI records | S0 label correctness 408/438; recursive S 404/438. Pair F1 S0=0.307692, S=0.240000. | One completed recursive ablation is negative. Four real children contributed every final label; no loss/merge defect was observed. |
| Retrospective bare Q03 supplement | Bare D pair F1=0.205882 versus retained S=0.240000, but bare label correctness 408/438 exceeds S=404/438. | Mixed, retrospective main-metric benefit, not an independent confirmation or causal recursion gain. |
| Original TREC 32k item, main panel | D=0.5625; S=0.75; S0=0.75. Original Prime R used 7 root + 25 child requests, exhausted 32 and wrote no final answer. | Whole-operator benefit over this bare output, zero measured S-minus-S0 gain; R remains incomplete and unscored. |
| Same TREC item, new D/S epoch | D=0.177978515625; S=0.75; S0 and R were not repeated. | Another exploratory whole-operator contrast on a reused item, not held-out or recursion-specific confirmation. |

OOLONG numeric scores are not label accuracy percentages. An older same-item bare answer scored 0.75 and remains retained. ARC's author protocol prohibited subagents; its panel cannot test recursive-child gain. Transport failures, invalid controls, unstarted conditions and unknown charges remain in their original reports.

The completed Q03 error analysis locates the immediate quality loss: recursion fixed four flat errors and introduced eight, while both methods missed 26 records. Aggregation was consistent with predicted labels; exact per-user count predicates amplified classification mistakes into pair errors. No independent semantic verification pass was observed. This identifies where the final errors came from; it does not establish which prompt, chunking or model property caused them.

## Why the evidence is still inconclusive

1. **Few completed causal comparisons.** Many charged requests went to transport/debugging/unfinished trees, not independent completed questions. A large request count is not a large evaluation sample.
2. **More delegation did not reliably buy correction.** In the valid Q03 trajectory the parent split/merged without an observed independent semantic review. In TREC, S0 already matched S. Neither result proves that a different verification strategy would win.
3. **Shared bridge is an uncontrolled reference boundary.** Original R and plugin S both use `solar-dsh/selected` and DSH's provider codec. First-request envelope equivalence cannot rule out shared multi-turn history/reasoning/tool/termination defects.
4. **Operational policy changed the permitted strategy.** The later TREC policy allows at most two disjoint children and instructs the parent to end its turn and not steer/poll/collect/classify until settlement. It avoids a confirmed deferred-start ordering trap, but is not an unrestricted reference recipe. Its causal effect was not isolated.
5. **Reference settings differ.** Our reused TREC 32k/custom MultiNLI tasks, model, ACP mode, limits and scoring outputs do not reproduce Prime's published benchmark setup. Unequal actual compute also prevents an equal-cost claim.

The [RLM paper, v2](https://arxiv.org/html/2512.24601v2) reports both gains and negative results: no-subcall ablations sometimes win, prompts behave differently across models, and output/termination handling can fail. Its main experiments used depth one, so depth one alone is not evidence of a deficient reproduction. Its leaf subcalls are LMs, whereas Prime children are full agent sessions; the same number of requests is not the same experimental setup. These facts motivate investigation, not a diagnosis that the selected model is unsuitable.

## Newly checked upstream leads

Source/merge status below was read on 2026-10-23; static source observations are not locally executed regressions.

| Lead | Evidence strength | Relevance and limit |
| --- | --- | --- |
| [PR #3708: spawn admission race](https://github.com/PrimeIntellect-ai/prime-agent/pull/3708) | Merged 2026-10-21, `dd384e3a2b3f8bfa9456c79a52909ed6c211e38a`. Our pin sets `prompt_admitted=true` before task acknowledgement. Fix is 21 commits ahead; v0.10.1 release commit contains it. | Early collect can settle an unprompted child with no answer. Presence in our pin is confirmed; occurrence in a particular historical trace is not. It cannot account for lost labels in the completed Q03 pair, since all labels arrived. |
| [Discussion #3663 answer latch](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3663#discussioncomment-19097018) | Community report, not a maintainer-confirmed diagnosis of our run. Fixed source `lifecycle.rs` only replaces an uncaptured/missing preview, matching the reported latch condition. | Interim waiting text may outlive a later final answer in collect. Q03 consumed actual files; this is not its established semantic-error cause. |
| [PR #3679 ACP failure classification](https://github.com/PrimeIntellect-ai/prime-agent/pull/3679) | Live API reports merged 2026-10-22, `07ae06883e6c765bed08952811247565d589f018`; cached web pages may show older status. | Adds typed failure data for exhausted transport/context/provider errors. Helps distinguish infrastructure failures; does not itself increase answer accuracy or authorize replay. It landed after the v0.10.1 release commit. |
| [PR #3685 compaction orchestration notes](https://github.com/PrimeIntellect-ai/prime-agent/pull/3685) | Merged; adds outstanding-work instructions to summary prompts. | Relevant only if an affected trace actually compacted and lost orchestration state. That has not been established for these completed comparisons. |
| [Discussion #3618 native Codex identity/cache](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3618#discussioncomment-19047473) | Community injection/removal comparison; not a semantic-quality study. | Native Codex OAuth caching/transport is a different path from our custom DSH bridge. Do not promote cache behavior to the cause of wrong labels. |

No upstream fix was applied. Do not replace the fixed runtime with an unpinned latest version and pool its outputs with prior results. [UPGRADING.md](../../incubator/rlm/UPGRADING.md) remains the upgrade boundary.

## Research sequence for Argon / Opus

Start with **review**, not a new trial. Using Argon or Opus as a reviewer is separate from changing the model inside the measured RLM. Neither role authorizes a model/provider switch or experiment.

| Step | Question / smallest useful work | Exit evidence |
| --- | --- | --- |
| R0: retained evidence, no calls | Locate original receipts; compare task admission, first task row, first settlement and actual final-answer times for incomplete trees. Inspect semantic error categories in completed outputs. | Per-run timeline with source/receipt hashes; identify missing receipts explicitly. No invented reconstruction or replay. |
| R1: deterministic runtime checks | After scoped authorization, test prompt-in-flight collect, interim-then-final answer, failed child, deferred kickoff and strict parent completion using scripted providers. Compare fixed old pin and one selected unmodified candidate. | A discriminating old/fixed result for each defect, all local requests identified as scripted. This is mechanism evidence only. |
| R2: full transport fidelity | Inspect/replay existing provider records and compare official Codex request construction with the bridge: model/reasoning identity, history, tool IDs/arguments/results, opaque replay state and stop/error interpretation. | Boundary-by-boundary supported / deviates / unknown matrix. Do not call a shared-bridge R/S comparison an official-provider control. Any new real call waits for experiment approval. |
| R3: reference baseline | Recover pinned paper data/prompts/scorer and a documented Prime recipe; state which reference is being tested. Freeze model, root/leaf policy, runtime, parameters and completion rules before calls. | A reproducible baseline manifest. If exact historical assets/provider are unavailable, call it partial reproduction. |
| R4: quality and recursion ablation | Only after the prior gaps are addressed, run a predeclared, independently graded D / S0 / S panel on unseen fixed items. Compare whole workflow with D and recursion with S0; retain repetitions, failures and unknowns. | Completed-tree results with error locations and actual resources. No stopping at the first positive output or selecting an older convenient baseline. Length/budget sweeps and routing thresholds follow reference establishment and credible quality evidence. |
| R5: separate learning study | Freeze Harness before measurement; separate learning/training tasks from held-out tasks and record every memory/skill/refinement change. | Held-out transfer evidence; do not attribute it to recursion alone. |

New task-specific prompts, semantic review stages, child budgets or root synthesis reservations must be disclosed as experimental strategy changes, not silently called original Prime behavior. A statistical or general improvement claim needs enough predeclared independent items/repetitions and an appropriate uncertainty analysis; this document does not invent a sample size or guaranteed outcome.

## Accounting and restart boundary

Last verified experimental checkpoint: **769 charged = 755 confirmed + 14 retained unknown**, cap **800**, zero in flight at closure. The 31 unspent requests are not a mandate to run. This closeout adds **zero** model requests. Before any future experiment, reconcile the actual ledger; never refund unknowns or infer capacity from a document alone.

The current instruction pauses new experiments. A later restart needs explicit authorization and frozen scope, model/provider/reasoning, complete-tree budget and completion/grading rules. Argon/Opus review, community feedback, a green CI job, a new release or spare budget is not that authorization. Merge, release, market publication and installed runtime upgrades remain separate decisions for 昊哥. Jev remains paused.

## Copyable reviewer request

```text
Review this RLM closeout and the linked evidence. Do not implement, install,
upgrade, send public messages or start model experiments. The objective is
to explain why recursion-specific improvement remains unestablished and
design the smallest discriminating next investigation.

Separate observed facts, source-confirmed risks, hypotheses and missing
evidence. Distinguish whole-operator benefit over bare D from recursion
benefit over S0, plumbing from quality, and shared-bridge R/S parity from
official-provider fidelity. Keep adverse results and 14 unknown charges.

First rank likely gaps using existing traces; then specify no-call reviews,
scripted defect checks, and only afterward a proposed frozen real-provider
panel. Explain what would falsify each hypothesis. Treat Argon/Opus review
and using them as experimental backbones as different decisions. Do not
assume changing models or increasing recursion depth fixes the problem.

Return: evidence-ranked findings, counterevidence, unresolved questions,
minimum follow-up plan, and the exact authorization still required.
```

## Evidence map

- [Integration architecture and adapter boundary](../integrations/prime-agent-rlm.md)
- [Canonical verification / installation history](prime-rlm-verification.md)
- [Completed recursion ablation](prime-rlm-recursion-results.md) and [sanitized data](prime-rlm-recursion-results.json)
- [Native-limit panel and repeated bare comparison](prime-rlm-gate-results.md) and [sanitized data](prime-rlm-gate-results.json)
- [Retrospective Q03 bare supplement](prime-rlm-q03-bare-supplement-results.md)
- [Prior reproduction-gap review](prime-rlm-gap-review.md)
- [Prospective evaluation contract](prime-rlm-evaluation.md)
- [Prime community request #3709](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3709): live read at `2026-10-23T08:58:57Z` found zero comments/replies and no accepted answer. This is a dated snapshot, not a claim about future replies.

Private raw traces, labels, credentials, full answers and profile backups remain local and are not attached to a public handoff. A later reviewer must be told when evidence is unavailable; sanitized hashes are provenance, not a replacement for inspecting the corresponding raw event when diagnosing causality.
