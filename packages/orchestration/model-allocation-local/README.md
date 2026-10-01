# @deepseek-ai/dsh-model-allocation-local

English | [中文](README.zh.md)

Deterministic Provider for `ctx.modelAllocation`. It ranks qualified native subscriptions before metered API offers, treats every reported quota bucket independently, gives high-tier models to planning and verification, gives low/mid-tier models to parallel execution, and increases usable parallelism when an allowance reset is close.

The Provider receives normalized offers and never imports Codex, Claude, DeepSeek, Resident daemon, or Scheduler implementations.

Explicit operator fallback is fail-closed and late-bound. Preferred offers are evaluated first; a merely busy preferred lane waits. Only availability, authentication, requested-model, or quota qualification failure opens the caller-provided fallback list, and the resulting plan records the requested operator/model plus a stable reason code. Without a fallback list, explicit selection retains its previous failure behavior.

Offers with equal scores are ordered by their `rank`, then by offer id.

When `adaptiveExecutionPreference: { version: 1, ... }` is present on a coding execution request, this Provider prefers Codex Luna for a low-risk first attempt and Codex Terra for medium/high risk, cross-domain work, or any prior failure. A missing target family falls back to the existing deterministic score. Explicit planning/verification preferences can gate candidates to Codex Sol or Claude Opus/Fable; an explicit Claude execution preference gates to Sonnet and suppresses the Codex adaptive target for that request. The existing quota admission, subscription-first, and API-last behavior is unchanged.

## Public evidence ranking

`rankComparablePublicEvidence(candidates, { taskType })` compares benchmark evidence among candidates that already passed the hard gates and sit in the same quality band. It is a pure function. `allocate()` uses it only through the evidence mode below.

- Two records compare only inside one cohort: the same benchmark, version, harness, metric, score kind, unit, reasoning effort, task type, execution surface, and billing identity, plus the exact provider and model. The cohort key names all ten conditions.
- Intelligence, subjective, preference, and community scores are reference-only. A rate is compared by its 95% Wilson interval and counts only when the intervals do not overlap; a missing sample count, an equal value, or an unknown metric or unit abstains. Values are never averaged across sources, and records of one source family and cohort with differing lineage or value abstain.
- Candidates are ordered only by unanimous pairwise verdicts. Disagreeing sources, a pair with no shared valid cohort, and a preference cycle each make the whole ranking abstain, so the baseline order stays.
- The result gives each candidate a tier (0 is preferred) and a receipt of the sources used, in conflict, and set aside. It never returns a source value.

The function is a TypeScript port of Codex Workbench's `public_evidence_ranking.py`. `tests/fixtures/public-evidence/expected.json` holds the Python reference output for 56 scenarios, and `generate_expected.py` rebuilds it from a Workbench source tree (`WORKBENCH_SRC=…/src python3.12 generate_expected.py > expected.json`). The test also checks that the file records the sha256 listed in `distribution/workbench-scheduling-sources.json`. Four differences are deliberate: a numeric string value is rejected, duplicate candidate ids throw, `str.casefold` becomes `toLowerCase`, and `str.strip` becomes `String.trim`.

### Evidence mode

When a request carries `evidence`, `allocate()` ranks only the offers that tie for the top score, after tier, quota, capacity, pinned-model, and preference gating; the tier breaks the tie before `rank` and offer id. The Provider setting `publicEvidence` selects what happens:

| Value | Effect |
|---|---|
| `off` | Evidence is ignored and the plan has no `evidence` receipt. |
| `shadow` (default) | The ranking runs and the plan's `evidence` receipt records what it would pick, but the choice is unchanged. |
| `apply` | When the ranking `used` same-cohort evidence, its preferred offer is chosen and the plan's rationale gains `public-evidence-tiebreak`. |

A ranking that abstains, or cannot run because an offer lacks a model or reasoning effort, never changes the choice and never fails the allocation; the receipt says why.

## Model Experience

Indirectly, through the sealed operator and model choice applied to each node.

#### KV Cache effect

Changing an allocation can select a different provider request, but allocator state is not injected into prompts.

## Known Limitations and Deferred Work

- The baseline is deterministic policy, not a learned optimizer.
- It can accelerate only from quota windows reported by Providers and does not forecast prices or latency.
- Adaptive routing is a bounded risk heuristic, not a quality guarantee; end-to-end evaluation must compare it with the standard scorer.
- Nothing supplies `evidence` yet. Collecting and converting the Radar and AI Frontier payloads into records that name an offer as the seam describes, recording the receipt in the Smart Collaboration routing event, and the periodic cycle are later stages of the scheduling migration. Until then the receipt never appears in a running product.
