# Prime RLM evaluation specification: fidelity, reasoning quality and paper claims

Status: **test design only; no plugin, model experiment or benchmark execution is certified**. Prepared for 昊哥, 2026-10-20 (Asia/Shanghai). This specification accepts the clarified requirement to preserve Prime's RLM and Continual Harness mechanisms. It does not approve the host substitutions in the [integration draft](../integrations/prime-agent-rlm.md).

The observable deliverable of this documentation task is a falsifiable case catalogue, a frozen-comparison protocol, independent grading, a statistical decision rule and an evidence manifest. Implementation of the test runner, fixture generator, grader, plugin and paid experiments is a later stage. No test runner or paid experiment is created or launched here.

## 1. Three separate questions and decision gates

| Gate | Question | Evidence required | Claim it cannot establish alone |
|---|---|---|---|
| G1: fidelity | Does the package execute the pinned Prime implementation and preserve its required semantics? | Runtime/source identity plus differential mechanism tests against the original Prime host. | Better reasoning or paper reproduction. |
| G2: efficacy | Does adding RLM improve verified answers at a fixed resource envelope for a specified model and task population? | Blind paired comparisons, no-subcall ablation, complete-tree accounting and uncertainty intervals. | Universal improvement for every model/task. |
| G3: paper | Which original-paper observations are reproduced under a recorded protocol? | Claim-by-claim original benchmarks, settings and metrics; deviations disclosed. | Exact reproduction when model/data/prompt versions differ. |
| G4: continual improvement | Does retained/refined state improve later unseen tasks? | Frozen-state train/validation/test separation and refinement controls, including its full cost. | RLM-only benefit or changed model weights. |

All four have independent `pass`, `fail`, `inconclusive` or `not_run` decisions. A status such as `completed` or a correct protocol response is not a quality score. Main RLM efficacy trials keep Continual Harness refinement and cross-task learning off. G4 is a separate experiment.

The previous draft preserves Python files but replaces Rust host behavior. That is not evidence of G1. A missing original-host component or unresolved semantic deviation blocks a full-fidelity claim even if task scores are high. A compatible subset must be named and separately accepted before testing it as the requested full extraction.

## 2. Fixed references and scope of inference

- Prime reference: `PrimeIntellect-ai/prime-agent@7cbffa77b38facd7c87277fa3c82bcadbe816880`, MIT. Compare the actual original host plus its Python runtime, not a second copy of the Solar adapter. Python `prime-agent-runtime` version `0.1.0` alone does not identify the source.
- Original RLM paper: [arXiv:2512.24601v1](https://arxiv.org/html/2512.24601v1), 2025-12-31. Pin v1 for the requested original-paper track. [v3](https://arxiv.org/abs/2512.24601v3), 2026-05-11, adds material including post-training; its claims are a separate track. Installing a plugin does not reproduce model post-training.
- Author inference library: [alexzhang13/rlm](https://github.com/alexzhang13/rlm). Its current branch is not assumed to be the paper's experiment commit; recover and pin the actual evaluation implementation, prompts and assets before exact reproduction.
- Prime architecture evidence: [Prime Agent paper, sections 2.3–2.6](https://arxiv.org/html/2608.23552v1) and the pinned source/skills. The paper describes an earlier interface; current source uses `rlm.spawn`. A spelling difference is not automatically a behavior difference, and an unchanged spelling does not prove equivalent behavior.

The original RLM study concerns long-context processing and reasoning with external state and test-time computation. It does not show that every short reasoning question improves. This suite measures answer quality, supported evidence, executable outcomes and resource use; it does not grade private chain-of-thought or equate a longer explanation with better reasoning.

## 3. Comparison arms and what each contrast isolates

| Arm | Composition | Main purpose |
|---|---|---|
| D: direct | Same root model, full in-window task input, no tools or descendants; normal answer allowance. | Practical direct-model comparison. |
| E: code agent | Same root model and permitted Python/tools, full input initially model-visible, no descendant model calls. | Controls for code execution instead of attributing all gains to recursion. |
| S0: RLM without subcalls | Same packaged runtime and external-input path as S, recursion disabled through a documented public configuration/capability boundary. | Isolates model subcalling from REPL/externalization. |
| S: plugin RLM | Requested Prime-preserving plugin, external input, model-controlled decomposition and permitted real children; refinement off. | System under test. |
| R: original Prime | Pinned original Prime host/runtime with matched model, input, permissions and effective resource policy. | Differential fidelity and score non-inferiority check. |
| M: summary/retrieval | Paper-defined summary and CodeAct/BM25 baselines, each named separately in results. | Original-paper comparison, not an alias for E. |
| S2: deeper RLM | Same root/child model routes and total budget as S; maximum child depth 2. | Optional S2-versus-S depth study; S itself is the one-level condition. |

D/E/S0/S form the proposed main within-window experiment. R is required for G1 and a reference-quality subset. M belongs to G3. The main S condition uses maximum child depth 1 and S0 permits no model subcalls; the original paper's child calls are ordinary LMs. S2 is supplementary and does not replace that shallow-recursion setting. G1 also tests the current Prime reference's supported deeper recursion separately. Freeze supplemental state and disable refinement/state learning equally during G2 through verified configuration; enable those capabilities only in the separately named G1/G4 conditions.

Do not patch Prime to create S0/S2. First verify the reference's public depth/capability configuration and demonstrate that disabling/changing recursion changes only that capability. If unavailable, use the authors' no-subcall implementation for the paper track and mark the plugin ablation unavailable; do not silently call a different scaffold the same ablation. Record stubbed-provider mechanism tests separately from real-model runs. Depth here is relative to the RLM root; DSH's absolute delegation-depth field must be translated and its boundary checked rather than set to the same number blindly.

The user task text, data bytes and requested answer schema match across arms. Necessary scaffold/tool instructions differ by arm; freeze and publish their full diffs and token sizes. Do not claim identical complete prompts. Match model/provider revision, reasoning effort, sampling settings, output limits, allowed data/tools, stopping criteria and budget rules. No stronger child model in the main causal study. A paper-matched heterogeneous root/child setup is reported separately.

## 4. Prime fidelity cases (F01–F12)

Execute each scripted sequence against R and S with a deterministic test provider where possible, then a small separately authorized real-provider mechanism check. Normalize only declared nondeterminism (IDs, paths, wall-clock timestamps). Never normalize status, messages, error class, admission order, durable result, model-visible state or usage into agreement.

| ID | Stimulus | Required observations and failure criterion |
|---|---|---|
| F01 | Hash the loaded runtime, selected skills and machine package data; identify the actual host code used for each handler. | Exact declared source/payload match. Python hashes alone cannot pass replaced Rust scheduling/refinement logic. Unknown/carried overrides fail the full-fidelity gate. |
| F02 | Set a variable and function in one cell; read/call them in a later cell; exercise top-level await and a bounded display. | Same persistent namespace/result and error semantics; no host-computed substitute answer. |
| F03 | Root code constructs two child prompts using parsed input; each child returns a distinct answer. Keep one child pending at first collect. | Admission handle precedes completion; distinct real sessions/kernel ownership; collect distinguishes pending, answer, error and cancellation. A successful spawn alone does not pass. |
| F04 | A model-controlled child creates a grandchild at the permitted bound; request another level beyond it. | Actual recorded parentage and model calls; exact limit outcome without new-root budget escape. Scripted topology proves plumbing; an unforced model strategy is observed separately. |
| F05 | Parent/child/sibling messages, broadcast, bounded observation, queued recipient and partial delivery. | Original routing/queue/receipt behavior preserved; no dropped or duplicate acknowledged message. A Solar relay is not presumed equivalent without differential evidence. |
| F06 | Collect a completed child, continue it through the reference-supported follow-up path, rename it, then request deletion for live and settled children. | Original identity/result/status and deletion behavior. Where follow-up lacks an exposed API, mark the requirement unsupported rather than inventing one. |
| F07 | Interrupt a running cell and background bash, detach the UI, reattach, then stop the owning Host separately. | Source-defined distinction between UI detach, kernel lifetime and Host shutdown. A Host-bound substitute does not pass daemon-independent lifetime behavior. |
| F08 | Snapshot serializable and nonserializable objects; restore compatible state; restart with a retained child handle and unresolved operation. | Saved/skipped/failed names, real child reconciliation and exact source limitations. No replay to rebuild missing state, no invented live process/answer. |
| F09 | Run a small Factory machine with conditional guard, foreach, join, graph/watch and live stop/resume; cold-restart its kernel. | Original compiler/executor outcomes and its memory-only live-run limitation. Durable machine specifications do not imply durable asyncio execution. |
| F10 | Exercise local/global Harness CRUD for every supported entry kind, restart and inspect revisions/history. | Original state operations and scope; explicit global selection; no cross-run leakage. Package paths may relocate through declared configuration without changing state semantics. |
| F11 | Call `refine.run`, inspect pending state, issue another request in the same turn, end the turn and inspect the next request/state/history; test disabled/no-op. | Original boundary scheduling and request merging, including preservation of prior instructions and OR-combination of the global flag; evidence-based edit application and supplemental-prompt rebuilding. An independently invented refinement child cannot pass by name alone. |
| F12 | Capture actual parent/child requests, nested tools, errors, retries and resources while exercising an artifact result and false/0/null tool returns. | Reconstruct model-visible material and complete-tree outcomes; preserve falsy results and unknown accounting. No fabricated native PTC records. |

The reference may itself contain a known limitation or defect. Preserve/report the actual behavior and distinguish it from a project-required safety invariant. If an adapter must change behavior, retain the failing differential case, document the exact difference and obtain agreement; do not alter the oracle to make it pass.

G1 requires all applicable F cases to pass and every required behavior to be covered. `not_run`, a mocked Rust-host replacement, or an undeclared limitation cannot be counted as faithful extraction. Full model-score equality is neither expected under sampling nor a substitute for this contract.

## 5. Reasoning-quality case families (Q01–Q08)

All small worked examples in section 6 are newly authored synthetic fixtures. They are not official benchmark instances or evidence that RLM succeeds. Private test cases use fresh names, hidden seeds, paraphrases and fact/rule combinations, with independently verified answers.

| ID | Task construction and difficulty axes | Independent oracle / principal score | What it can test |
|---|---|---|---|
| Q01 | Single exact fact among distractors; vary position and length while keeping the answer fixed; include absent and conflicting needles. | Exact answer plus correct absence/conflict status. | Retrieval/external-input control; cannot alone establish reasoning improvement. |
| Q02 | Semantically classify every narrative record, apply negation/time/exception rules, then aggregate by entity/category. Use paraphrases and balanced adversarial lexical cues. | Hidden gold label per record; exact final aggregate, intermediate label accuracy as diagnostic only. | Dense semantic transformation and global aggregation, analogous to OOLONG. |
| Q03 | Produce the complete set of pairs satisfying semantic and temporal constraints across users. Include duplicate facts, empty result, one-sided condition and boundary dates. | Canonical unordered-pair set, set F1, exact set match, duplicate/format diagnostics. | Pairwise aggregation and long-output consistency, analogous to OOLONG-Pairs. |
| Q04 | Resolve aliases, dates and multi-hop dependencies across independent documents; insert plausible outdated/contradictory near matches. Vary hop count and distance without changing data access. | Hidden graph/rule engine, answer accuracy and document/line evidence validity. | Cross-document reasoning, analogous to BrowseComp+; not pure keyword lookup. |
| Q05 | Small repository with a specified behavioral change, cross-file dependencies, misleading comments and error-path constraints. Inspect/patch through ordinary allowed tools. | Withheld executable tests and unchanged regression suite; count task pass only when all mandatory tests pass. | Applied reasoning/coding transfer. Official CodeQA remains a separate multiple-choice benchmark. |
| Q06 | Expand Q02–Q04 data beyond the direct model window, preserving required semantic work and gold facts. | Same independent oracle; quality-versus-total-input-length curve, API validity and resource coverage. | Context scaling, not a fair same-input quality comparison against a truncated D. |
| Q07 | Short arithmetic/logical/semantic tasks where a direct answer is feasible, including traps needing no decomposition. | Exact answers or executable proof checker. | Negative control and regression boundary; a loss is retained in results. |
| Q08 | Assemble a long structured output from distributed semantic decisions; answer exceeds one generation's configured output allowance but can be stored as an artifact. | Parse full artifact; exact coverage, row/set correctness, digest and readable slices. | Output assembly, not merely printing a handle or retrieving a prebuilt answer. |

Q02–Q05 are the predeclared dense-quality population. Q01/Q07 are controls. Q06/Q08 measure scaling/output claims independently; their favorable outcomes cannot rescue a failed within-window quality comparison.

Vary both length and density. In Q01, append irrelevant material. In Q02/Q03, add new relevant records/pairs and recompute the oracle; padding alone does not establish information-density scaling. Q04 varies distractors separately from required hops. Randomize record order, answer position, entity naming and shard boundaries, with transformations applied identically to all paired arms.

## 6. Worked minimal fixtures with exact expected answers

These examples validate task/grader interpretation before generation. The implementation must later supply a separate oracle implementation and a review of semantic gold labels; generator and grader sharing one bug is not an independent check.

### Q02 example: negation and latest-state aggregation

Rule: a shipment counts only if it has arrived by the cutoff, its latest status by the cutoff is not cancelled, and it was not returned by the cutoff. Sum its declared value once. Cutoff: day 10.

| Shipment | Value | Narrative records |
|---|---:|---|
| A | 12 | Day 2: dispatch postponed. Day 6: recipient took delivery. |
| B | 20 | Day 4: recipient took delivery. Day 8: goods came back to sender. |
| C | 7 | Day 9: carrier still has the package; no delivery occurred. |
| D | 9 | Day 3: recipient took delivery. Day 11: cancellation recorded. |
| E | 5 | Day 5: order called off. Day 8: delivery occurred. Day 9: cancellation withdrawn and shipment reinstated. |

Expected included set: `[A,D,E]`; expected sum: `26`. Mutation: move D's cancellation to day 10; expected set `[A,E]`, sum `17`. Boundary rule includes the cutoff day. Neither “contains delivery” nor “ever contains cancellation” is a valid solver.

### Q03 example: semantic labels, temporal universal condition and pair sets

Classify question intent as `person`, `location`, `number` or `other`. An eligible user has at least one person/location question, and every person question for that user must occur strictly after day 6. Emit all pairs of distinct eligible users, lower ID first.

| User | Questions with day |
|---|---|
| 1 | Day 7: “Who wrote the play?”; day 2: “Where does the river end?” |
| 2 | Day 3: “In which country is the lake?” |
| 3 | Day 6: “Which scientist discovered it?”; day 9: “Where is the laboratory?” |
| 4 | Day 8: “Name the person who directed the film.” |
| 5 | Day 9: “How many seats are there?” |

Eligible users: `[1,2,4]`. Gold pairs: `[(1,2),(1,4),(2,4)]`. User 3 fails the strict date condition despite a location question. Mutation: move its person question to day 7; eligible users `[1,2,3,4]`, yielding 6 pairs. Reversed or repeated pairs never add credit; report schema violations separately. If gold and prediction are both empty, set F1 is 1; if only one is empty, it is 0.

### Q04 example: cross-document identity and rule application

All entities are fictional. Document d1: at the day-10 cutoff, engineer Mira works on project Cedar; Cedar is project `P7`. d2: the day-10 P7 owner is team North; ownership moves to South on day 12. d3: North's approved lab on day 10 is L2. d4: L2 has 4 racks; every rack has 6 slots; one rack is reserved in full. d5 is a hard negative describing South's 8-rack lab. Question: how many unreserved slots are available in Mira's project's approved lab at the cutoff, and which documents support the answer?

Gold answer: `18`, required evidence `{d1,d2,d3,d4}`. Mutation: move the ownership change to day 9 and provide South's complete capacity rule; the oracle follows the new owner. A solver reusing `18` fails the mutation. Evidence must support the actual joins and cutoff, not just cite four arbitrary documents.

Q05's analogous fixture is a versioned repository, task statement and private test suite, not a fabricated command/path in this document. Q08 stores the actual generated answer; a URI without validated bytes fails.

## 7. Original-paper reproduction cases (L01–L05)

This section's reference settings come from v1 sections 2.1–2.2, Table 1, observations 2–4 and Appendix E. These historical settings are not current provider availability or performance promises. Other parts of this specification are proposed DSH evaluation policy.

| ID | Paper observation | Original task/protocol anchor | Required reproduction evidence |
|---|---|---|---|
| L01 | External context scales beyond a base model window. | BrowseComp+ offline 1,000-document setting; Table 1 uses 6M–11M tokens. | Exact corpus/task IDs and source metrics; each actual request stays within its window. Report maximum successfully graded input ratio, never extrapolate a 10x trial into 100x. |
| L02 | Dense-task quality improves, including within the window. | OOLONG trec_coarse at 131K: numeric score `0.75^abs(y-y_hat)`, otherwise exact match. | Paired original scorer plus secondary exact accuracy; do not replace the smooth score silently. |
| L03 | Subcalls help on dense work, with exceptions. | OOLONG-Pairs at 32K; 20 query types; pair-set F1; no-subcall ablation. | Frozen query/corpus variants, full pair output and RLM-minus-no-subcalls intervals. Report tasks/models where the ablation wins. |
| L04 | Length and semantic density affect degradation. | S-NIAH/OOLONG/OOLONG-Pairs, Figure 1, `2^13`–`2^18` input-token sweep. | Same underlying task clusters across lengths; quality and degradation curves, original tokenization and any packing deviation. |
| L05 | Useful quality may have comparable cost, with expensive tails. | Table 1 and cost/runtime analysis; CodeQA, summary and CodeAct/BM25 comparisons. | Full-tree API accounting, quality-cost frontier and p50/p95; distinguish runtime-dependent latency from inference-quality reproduction. |

The v1 setup uses GPT-5 medium root with GPT-5-mini subcalls, and a Qwen3-Coder-480B-A35B condition. Original calls were sequential. Reproduction records these choices; a concurrent DSH/current-model trial is a transfer experiment. Original numeric scores are reference observations, not fixed universal acceptance thresholds. v1 itself reports tasks where no-subcalls wins and short-input regressions; this suite must preserve that possibility.

Before an exact-reproduction claim, recover versioned evaluation scripts, original task selection and sampling seeds, prompt text, scorer, model/provider snapshot and pricing basis. If any is unavailable, mark that item as partial/directional reproduction. Existing public IDs may be contamination-prone; use fresh hidden tasks for G2. Different OOLONG splits, tokenizers or CodeQA task forms are not interchangeable.

Do not interpret quadratic pair output as a proof that no faster algorithm exists. The test checks complete semantic outputs and scaling under the selected corpus, not a universal algorithmic lower bound. Do not reproduce post-trained RLM-Qwen3 claims by merely using the plugin.

## 8. Context, compute and budget controls

For each model route, freeze its actual input ceiling and tokenizer revision. Let `W` be the usable shared in-window data allowance after reserving the largest scaffold, task and output allowance across compared arms. Verify actual full requests, not only raw-file token counts. A route claiming a large context limit must pass a request-validity probe before interpretation.

- Main G2 uses one predeclared medium length near `0.5W`, with all input fitting D/E. Same data bytes go to every arm; S/S0 externalize them.
- The length panel uses approximately `0.125W`, `0.5W`, `0.8W` for within-window effects. Preserve actual counts and rounding.
- Q06 extends selected cases to `2W`, `10W`, and, only if separately budgeted, up to `100W`. D is `input_not_supported` when it cannot accept input. An operational utility score may count this inability as zero, but it is not a same-valid-input reasoning loss. Never silently truncate D.
- Within-window direct runs receive the full authorized answer allowance; do not intentionally weaken them with a tiny completion budget or force an unnecessary tool workflow.

Compare quality at fixed common expenditure ceilings, including all root/child/summary/refinement requests, retries, tool time and input/output/cache tokens. Use two predeclared budget levels for a frontier study rather than selecting a favorable point after results. Equal ceilings need not produce equal actual spend; report both. Token and dollar matching are separate analyses, especially with heterogeneous models.

No claim of an enforceable hard cost/attempt cap is allowed if the adapter cannot reserve internal retries. A provider usage gap becomes unknown; cost efficiency cannot pass on a materially incomplete ledger. Keep account/routing, cache policy, service tier and concurrency policy fixed; randomize/interleave arm order to reduce time/load confounding. Paper replication uses sequential calls; deployment latency can use a separate concurrency condition.

## 9. Sampling, blinding and proposed run counts

The following counts are **proposed designs**, not launched runs or approved expenditure.

| Stage | Proposed units | Purpose and stopping condition |
|---|---|---|
| P0 | All F cases and grader/oracle mutations with deterministic providers/fixtures. | Verify mechanics and measurement; no efficacy claim. Missing implementation leaves cases not run. |
| P1 | 12 development cases, 3 per Q02–Q05; D/E/S0/S once: 48 model runs per selected model. | Calibrate difficulty, runtime and complete-tree unit costs; not a significance test. Freeze changes before holdout. |
| P2 | 48 disjoint reference sentinel tasks, R/S, 2 repetitions: 192 model runs. | Paired non-inferiority planning/check; widen sample using development variance before final inference if necessary. |
| P3 | 320 sealed base tasks, 80 per Q02–Q05; D/E/S0/S, 2 repetitions: 2,560 runs for one model. | Main within-window efficacy test with task-clustered analysis. Repetitions are not 640 independent tasks. |
| P4 | 48 P3 base tasks in a sealed length panel, 3 lengths, S/S0, 2 repetitions. | 576 configurations; 192 medium-length results may be reused from P3, leaving at most 384 new runs if fingerprints match. |
| P5 | Q01/Q07/Q08 controls, Q06 scaling and L cases; counts locked per affordable panel. | Separate coverage and paper claims. No automatic execution after P3. |
| P6 | H cases and held-out continual-learning trajectories. | Separate G4 experiment, including adaptation cost. |

P2 and P3 data are disjoint. All scores from the sealed holdout remain unseen until policy/prompts and analysis code are frozen. A second model repeats its own protocol; one-model success supports only that model. Per-family samples are not advertised as adequately powered for tiny effects.

A base task must have an independently generated corpus/repository/problem instance. Multiple questions on the same corpus, repository variants, paraphrases, repetitions and length variants stay in one shared cluster. If assets force a higher grouping unit, bootstrap and power planning use that higher unit and disclose the reduced independent sample count; renaming 320 variants does not create 320 independent tasks.

All run counts above are root-level experimental trials, not API-call counts. One RLM trial can admit many descendant/provider attempts. Budget approval covers that full exposure. In efficacy trials, do not force children to call children or inject a successful decomposition; record whether the model voluntarily uses subcalls, their depth and task-local contribution. A forced hierarchy is mechanism evidence only. If S never uses its enabled subcalls, report that fact and do not explain a score difference as demonstrated recursion use.

A planning calculation for paired binary correctness is `n ≈ (z + 0.84)^2 * q / delta^2`, where `q` is the expected discordant-pair fraction and `delta` the absolute effect. With assumed `q=0.30`, `delta=0.10` and a single two-sided 5% comparison (`z=1.96`), this is about 236 tasks; for three Bonferroni-protected comparisons (`z≈2.394`), about 314. These are planning assumptions, not observed facts or guaranteed power for the macro continuous/F1 endpoint or clustered repetitions. A 5-point effect would need roughly four times that binary sample under the same assumptions. Use development-only variance/simulation to freeze the final sample size before opening the holdout; if the budget cannot support it, label the run exploratory.

Pilot costs determine a reviewable execution envelope: approved stage, exact model routes, independent task count, repetitions, per-run maxima, total reserved exposure and stopping conditions. This design authorizes no paid launch.

## 10. Independent grading and integrity controls (S01–S04)

| ID | Check | Required outcome |
|---|---|---|
| S01 | Keep gold labels, generator seeds that reconstruct gold, grader and hidden tests outside Agent-readable namespaces. Inspect the actual exposed files/tools. | No oracle leakage; task code cannot import the grader or read another arm's answers. A leaked case invalidates the affected panel and its provenance is retained. |
| S02 | Mutate one rule, date, entity or semantic label; permute order and renaming; supply a deliberately wrong/missing/duplicate output. | Independent grader detects every specified semantic change and rejects malformed results. Invariant transformations preserve the gold result. |
| S03 | Replace a child answer with a wrong value in a controlled mechanism fixture, deny a subcall, and inject a missing receipt. | Root behavior and ledger reveal the defect; no host silently fills the correct answer. Perturbations never enter the main efficacy data. |
| S04 | Blind arm identities during grading; compare full output artifacts and source evidence, not a success flag or fluent explanation. | Deterministic grading for machine-checkable tasks; human adjudication follows frozen criteria and records disagreements. |

An independently implemented oracle reconstructs structured gold from the admitted inputs. Semantic labels use an adjudicated annotation set checked independently of the generation code. Another model is not the sole judge of whether its sibling is correct. If open-ended grading is unavoidable, predeclare a blinded human rubric and use an independent judge only as supplementary evidence; count its cost separately.

Use official benchmark scorers without undocumented normalization. For custom pair tasks, canonicalize the mathematical set, report duplicates/schema errors and apply the predeclared validity rule. An empty answer is not a parser failure; distinguish it from missing or truncated bytes. Repository tests execute against the submitted final tree, never a hidden reference patch substituted by the runner.

## 11. Statistical estimands and decision rules

Normalize each task's principal quality score to `[0,1]` without mixing incompatible raw metrics. Average repeated runs within each base task, then average equally within each of Q02–Q05, then macro-average those four families. This predeclared weighting prevents a large easy family from dominating the result. Report strict exact-task success alongside partial metrics.

Primary causal contrast: `Delta_recursion = macroQ(S) - macroQ(S0)`. Main practical contrasts: S minus E and S minus D. Reference transport contrast: S minus R. Report paired task-level differences, confidence intervals, win/tie/loss, each family's scores and valid/failed/unknown run counts.

Use a stratified cluster bootstrap over **base task IDs**, retaining their repetitions/length variants together; predeclare seed and resample count (proposed 10,000). For the three predeclared efficacy contrasts, use Bonferroni simultaneous percentile intervals: each interval is 98.3333% two-sided, with bootstrap quantiles approximately `0.0083333` and `0.9916667`, giving nominal family coverage at least 95% under the interval procedure's assumptions. Also report ordinary 95% descriptive intervals labelled as such. Bootstrap coverage is approximate and requires a development-only calibration check for this estimator. For binary exact success, add paired discordant counts and exact McNemar tests with Holm-adjusted p-values as supporting evidence; they do not replace the primary interval gate. Do not pool model results as independent replications of one model's claim.

Proposed product decision thresholds, to be frozen before holdout access:

1. **Recursion-quality benefit:** S minus S0 has a positive lower bound in its simultaneous interval and at least a 0.05 observed macro-quality improvement. Report effect size and exact-success changes. Threshold choice is a project utility rule, not a paper constant.
2. **Practical improvement:** the same rule must pass for both predeclared S-minus-E and S-minus-D contrasts for the full G2 practical gate. A comparator-specific passing result may still be reported with its simultaneous interval, but cannot be selected after results as an alternative full-pass route. A win over D alone permits only that system-level comparison, not a recursion-specific claim.
3. **Prime reference quality:** one-sided 95% lower bound for S minus R exceeds the proposed non-inferiority margin `-0.03`, alongside G1. Failure to find a significant difference is not non-inferiority; an interval crossing the margin is inconclusive. The 48-case sentinel may be too small and cannot be called sufficient without interval evidence.
4. **Scope protection:** no unreported task-family/control regression. Report Q07 explicitly. To claim non-regression on a domain, its one-sided interval must clear its predeclared margin; an underpowered control panel remains unknown.
5. **Efficiency:** only claim better quality at comparable cost where measured complete-tree cost and the locked frontier support it. Proposed practical same-cost band: median spend ratio <=1.25 at non-inferior quality, with p95 and timeout rates displayed. This is a DSH criterion, not an assertion that v1 proved that ratio.

Freeze and validate the specified interval/threshold implementation before execution. Do not compute unadjusted intervals and label them multiplicity-adjusted. The one-sided Prime non-inferiority check and exploratory family/control analyses are separately labelled; they cannot be used as additional uncorrected routes to pass the joint efficacy gate.

The full positive G2 claim requires recursion benefit and both practical comparisons to pass; reference fidelity, efficiency and domain non-regression retain their own decisions. Passing G2 does not require every family or every individual task to improve. It supports only the locked aggregate population and disclosed family effects. A confidence interval spanning no benefit is `inconclusive`; a convincingly negative effect is `fail`. No optional stopping at a favorable p-value, post-hoc removal of hard cases, or selection of the best repetition.

## 12. Failure, missingness and accounting policy

Every admitted trial appears in the denominator and raw ledger. Deterministically invalid preparation is `rejected_before_dispatch`; reconcile any unknown external effect before a retry. Predeclared repetitions are new planned trials, not retries of an unresolved one.

- A normal model refusal, invalid answer, budget exhaustion or timeout is a task non-success and consumes its actual resources.
- A harness defect or provider outage remains labelled separately, with its observed attempt/effect receipts. Do not discard it to improve accuracy. Report intention-to-run operational utility and the same predeclared subset of verifiably evaluable outputs side by side.
- For an admitted unknown result, keep raw quality unknown. In every specified best/adverse sensitivity scenario, assign run-level bounds first, then aggregate repetitions into base tasks, families and the macro score, retaining every original weight; bootstrap those same task clusters. Never average only known repetitions or silently drop a base task. For a paired effect's adverse bound, treatment unknowns receive 0 and comparator unknowns receive 1; reverse them for the favorable bound. A positive efficacy conclusion must clear the same superiority gate, including its interval and effect threshold, under the adverse scenario; otherwise it is inconclusive.
- Missing billing/usage cannot be entered as zero. Unknown spend blocks the efficiency claim for affected comparisons even if answer quality is known.
- Single-call evidence, root-only tokens or controller completion cannot certify the whole recursive tree. Account for children, late retries, refinement, summarization and verified process settlement.

Record retries and interruptions separately from the number of logical steps and model-provider attempts. Apply a documented common outage policy; never rerun only the losing arm. A cost stop preserves all results to date and produces an incomplete study, not a newly selected smaller confirmatory sample.

## 13. Continual Harness cases and transfer study (H01–H06)

These cases are part of the requested Prime extraction acceptance. G4 runs only after G1 establishes the original refinement mechanism, including host-side planning/application. Replacing that mechanism with an unrelated DSH summarizer is not a passing implementation.

| ID | Design | Evidence and decision |
|---|---|---|
| H01 | Local typed entries and explicit global entries survive the reference-supported boundaries; unrelated sessions start empty. | Compare CRUD, history, prompt injection and isolation against original Prime; no automatic global promotion. |
| H02 | Request refinement after repeated supported failure; inspect state mid-turn, at turn end and next request. | No premature application; original scheduling/planning/application behavior, trigger/evidence and changed supplemental state visible. |
| H03 | Create a refinement with no reusable evidence, then a conflicting/outdated entry and a correction. | No-op/actual conflict-resolution policy matches the source. Empty edits are allowed; entry count alone is not improvement. |
| H04 | Restore the reference-supported prior state/version and rerun a controlled request. | Exact prior supplemental state and resulting prompt material; no claim that rollback undoes already executed external actions. |
| H05 | Learn on development trajectories, freeze the resulting state, test on sealed structurally related tasks with new facts/names/repositories. | Held-out transfer quality, error recurrence and full adaptation/inference cost; no reused answers or hidden test feedback. |
| H06 | Test unrelated tasks, order effects and adversarial but data-only trajectory text. | Disclose negative transfer and order sensitivity; foundational instructions and account/global personal memory are outside writable supplemental state. |

Transfer arms use the same test-time model and task budget: `H0` empty/frozen harness; `Hread` identical allowed trajectory archive but no retained learned edits; `Hlearn` original refinement state learned only from the development split; `Hsham` a size-matched irrelevant-state control. This distinguishes useful learned state from extra history, more prompt tokens or extra model calls. If a sham changes safety/permissions it is invalid; it contains only benign unrelated task material.

Use proposed 24 independent task streams, each with 6 learning tasks, 2 validation tasks and 6 sealed transfer-test tasks. Freeze the learned state immediately after the 6 learning tasks; validation/test feedback cannot edit it. Validation is a predeclared integration diagnostic, not permission to select a best state or tune policies on these evaluation streams; tune policies only on separate development streams. A validation-driven protocol change creates a new frozen study before test access. No task instance, repository clone or generated fact set crosses the split. Predeclare within-family unseen-instance transfer and disjoint-family negative-transfer strata; superficial renaming alone is not sufficient separation. Randomize learning order in a predeclared sensitivity panel. Analyze by independent stream, not by treating its 14 tasks as independent learners. Select final stream count using separate development variance; 24 is a planning start, not a power guarantee.

A separate optional `RLM on/off x Harness learning on/off` interaction study can attribute synergy. Without it, report G2 and G4 separately. Improvement after refinement is an inference-time system effect with fixed weights, not proof that base-model parameters or general reasoning ability changed.

## 14. Evidence manifest and reproducibility package

The future runner writes a versioned manifest and immutable raw result bundle, with these minimum fields:

| Group | Required fields |
|---|---|
| Identity | Study/protocol hash, plugin commit/package hash, Prime commit and actual executed component hashes, runtime/interpreter/OS, scorer and analysis revision. |
| Task | Base task/variant/family/split IDs, data manifest/digests, true tokenizer counts, hidden-oracle identity retained outside the model scope. |
| Model | Actual provider/model revision, reasoning and sampling settings, supported seed behavior, root/child routes and original retry policy. |
| Exposure | Arm, full scaffold/task/schema fingerprints, inputs/tools/permissions, learning-state hash, context/output/time/concurrency and common budget envelope. |
| Execution | Actual run/session/node/cell/operation/provider-attempt IDs, lineage, timestamps, admissions, messages, termination and any unknown-effect fence. |
| Outcome | Full submitted output/artifact digest, independent scores, hidden-test verdicts, failure type and blinded adjudication. |
| Resources | Root plus descendants, token/cache coverage, cost source/time, measured/estimated/unknown values, tool/runtime and physical settlement. |

Store sanitized schemas and public fixture definitions in the repository. Paid transcripts, private tasks, credentials, provider account details and personal memories remain outside GitHub. The published report can provide redacted aggregates and a reproducibility manifest without publishing private runtime artifacts.

Every table row links to the actual result receipt. Proposed example IDs are never represented as real run IDs. A future dashboard is a view of this same immutable evidence, not a second editable truth source.

## 15. Execution stages and authority

1. Review the preservation architecture and this protocol; resolve original-host fidelity gaps before accepting G1.
2. Implement the smallest useful fixture/oracle/runner boundary in an assigned task; verify its measurement with mutations and captured test-provider requests.
3. Run the authorized keyless mechanism gate in disposable homes with built packages. This is not installed-app or efficacy acceptance.
4. Present P1's concrete model/budget envelope for cost approval, then run it once under a single owner. A paid pause remains effective until explicitly lifted for the named stage.
5. Freeze the confirmatory study and sealed data after development-only planning. Execute only the authorized stages, preserving unknown receipts and stopping rules.
6. Publish the claim-by-claim analysis and obtain installed-app acceptance through the separately authorized normal user path. Merge, plugin release, Pages/market publication and recurring automation remain separate actions.

No model/provider is selected or changed by this document. Exact execution settings are mandatory launch-manifest fields; this is a bounded design dependency, not permission for a default paid run. Local/source checks, actual installed usability, efficacy and publication remain distinct statuses.

## 16. Required result report

The final evidence report must include:

- G1/G2/G3/G4 decisions with covered scope, not-run cases and unresolved fidelity differences.
- Per model/arm/family: admitted/evaluable/failed/unknown counts, quality and exact success, paired effects/intervals, win/tie/loss, actual spend coverage, p50/p95 time/cost and budget stops.
- S versus S0 recursion ablation; S versus E/D practical effects; S versus original Prime non-inferiority; short-task regressions and length/density curves.
- Continual Harness transfer results and all adaptation costs in a separate section.
- Original-paper claim matrix, exact-versus-directional reproduction labels and any unavailable historical asset/model version.

Permitted example wording after a passing study: “For model M at the frozen budget, on the held-out dense task population, plugin RLM improved macro-quality by X points over no-subcalls (paired adjusted interval [L,U]); short-task effects were Y; total cost coverage was Z.” These placeholders are not results.

If fidelity fails, say “an adapted implementation was evaluated,” with the actual accepted scope. If uncertainty or missingness prevents a decision, say “not established.” Do not replace this with “RLM verified,” “reasoning universally improved,” or a paper headline percentage.

## 17. Source locators and design verification

Prime source base: [fixed commit](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa77b38facd7c87277fa3c82bcadbe816880). Relevant inspected paths: `prime-agent-runtime/src/rlm/{__init__,repl,factory,harness}.py`; `prime-agent-runtime/test/`; `skills/refine/SKILL.md`; `crates/pa-core/src/session_engine/{rlm_host,refine,refinement_gate}.rs`; `crates/pa-core/src/refinement/`; `crates/pa-daemon/src/rlm_children/`.

Paper locators: [RLM v1 sections 2–3 and Appendices D–E](https://arxiv.org/html/2512.24601v1); [version history](https://arxiv.org/abs/2512.24601); [Prime architecture sections 2.3–2.6](https://arxiv.org/html/2608.23552v1). Benchmark assets/scorers must be pinned at runner implementation; no download or runnable availability is claimed by a source link.

Mechanism evidence index at the fixed Prime commit (source/test inspection only):

| Cases | Concrete source locators |
|---|---|
| F02/F08 | `prime-agent-runtime/test/test_repl.py:664–738,1595–1699`; Python protocol, interruption/late reply and snapshot exclusions. |
| F03/F04/F06 | `crates/pa-core/src/session_engine/rlm_host.rs:264–289,1295–1558`; `crates/pa-daemon/src/rlm_children/host.rs:79–89,304–313`; validation/depth/create-session gates. RecordingHost tests do not prove real supervisor admission. |
| F03 collect | `prime-agent-runtime/test/test_subagent_registry.py:459–571`; typed results and selectors, with mock-host boundary retained. |
| F09 | `prime-agent-runtime/test/test_factory.py:5192–5295`; `prime-agent-runtime/src/rlm/factory.py:1453–1537`; FakeHost/live notices and cold-restart limitation. Default Rust wiring does not register `factory.progress`. |
| F10/H01/H03 | `prime-agent-runtime/test/test_harness.py:146–237,345–380,1110–1185`; persistence, DAG write validation and local/global paths. These do not test host model planning. |
| F11/H02 | `crates/pa-core/src/session_engine/turn_boundary/tests.rs:344–530`; `crates/pa-core/src/session_engine/turn_boundary.rs:298–377`; native pending/merge/settings behavior. |

The current clone's `test_agent_message_skill.py` refers to a removed historical path; do not present that unexecuted file as passing message-delivery evidence. Actual original-host message/lifetime checks remain required.

Documentation validation consists of case-ID/link/source-path/fixture-arithmetic consistency and a bounded independent protocol review. None of F/Q/L/H/S is executed by this documentation change. Statistical rules and proposed sample counts are prospective; no p-value, quality gain, cost saving or faithful runtime execution has been observed here.
