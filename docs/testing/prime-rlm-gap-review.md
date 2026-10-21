# Prime RLM reproduction gaps and upstream handoff

Date: 2026-10-21, Asia/Shanghai. Analysis and public handoff only; no new model experiment, runtime patch or installation. Accounting remains **769 = 755 confirmed + 14 retained unknown**, zero in flight, under 800.

The current evidence does not establish whether Prime's published aggregate performance generalizes to our deployment. It also does not justify an allegation that the published results are fabricated. Our two latest paired outputs favor the complete plugin over bare responses on one reused question, while the non-recursive control ties the recursive plugin. Calling that a general proof was too strong; the supported statement is a limited observed whole-workflow gain.

## Confirmed differences

| Boundary | Published reference or intended control | What our evidence actually covers | Consequence |
| --- | --- | --- | --- |
| Native reference R | A full official-provider Prime run would independently control the adapter/provider path | R uses the original Prime binary but the same `solar-dsh/selected` loopback and parent DSH provider codec as S | R/S agreement can miss a shared bridge defect; it is not official-provider conformance |
| Differential scope | Complete model/tool/history behavior, if claiming full reproduction | First actual R/S request options match after narrow owned-path/id normalization; separate scripted native mechanisms pass | Initial-envelope equivalence does not prove whole-trajectory equivalence or equal success probability |
| Long-context benchmark | Prime's blog table includes Yahoo 128k and specific model/harness pairings | One TREC-coarse 32k item, Codex gpt-6.1-sol/high, reused during operational fixes | Different distribution/model/prompt; not the published benchmark or an exact RLM-paper reproduction |
| Bare comparator | Isolating recursion requires matched tools and S/S0; equal-compute claims also need matched resources | D is one tool-free inline-context request; S has persistent Python/files/children and at most 32 tree requests; S0 has the same score as S | Valid observed complete-operator contrast, no demonstrated causal recursion gain |
| Native runtime and mode | Public ARC runner lists Prime v0.3.3, RPC/autonomous, Opus 5/xhigh | Rust CLI 0.10.0 at `7cbffa77`, ACP, Codex gpt-6.1-sol/high, macOS and an explicit SDK facade | Version, provider, mode, platform and task-interface parity are not established |
| ARC resources and outcome | Public 25-game protocol has a 500-action cap and reports RHAE | Our four-game extension also imposes 32 model requests/tree; main output is 0/4 full-game WIN per arm, with one invalid control and other failures retained | An action is not a model request; WIN count is not the published RHAE metric |
| ARC recursion | The public game guidance explicitly prohibits RLM/subagent calls | Our ARC panel uses depth zero as that protocol requires | That headline is not a recursive-child on/off experiment; it cannot validate or invalidate a recursion-specific effect |
| Learning state | Continual Harness efficacy requires its own training/held-out transfer protocol | Factory and refinement learning are disabled in our quality comparisons; local CRUD/refine/rollback mechanisms were exercised separately | Mechanism preservation is not a measured learning gain |

Public references: [Prime evaluation table and method](https://www.primeintellect.ai/blog/prime-agent), [pinned ARC method](https://github.com/PrimeIntellect-ai/arc-agi-3-prime-agent/tree/398d4dd63cf01d00adbea41c13437ba0b8ad40fc). The Prime table also includes below-comparator outcomes; it is not a claim of a win for every task/model. Our result/configuration sources are the [native-limit panel](prime-rlm-gate-results.md), [ARC protocol](prime-rlm-arc-protocol.md), [ARC results](prime-rlm-arc-results.md) and the public implementation pinned in [DSH PR #280](https://github.com/lisihao/deepseek-solar-harness/pull/280).

## Confirmed local defects versus unresolved causes

The adapter initially omitted two independent original limits: autonomous gate retries and autonomous continuations, both defaulting to three at our Prime pin. Raising maxTurns did not raise either. Optional forwarding was repaired, and strict scripted default/explicit and recursion/depth-zero controls passed. This is a verified configuration gap. It does not establish that the gap alone explains a real quality difference.

Earlier runner stream-consumption, path staging and cleanup-classification defects were retained and corrected before remaining unstarted conditions continued. The measured ARC panel still includes bootstrap file-not-found overhead and an invalid baseline. It should not be presented as a clean replication failure.

In the latest native-limit panel, R used seven root and twenty-five child calls and exhausted the external shared tree budget. `ARC_REQUEST_LIMIT` is our bridge's name, not a Prime error code. ACP end_turn, process exit zero and completed child metadata did not produce a final answer; R stays task-incomplete and unscored. There is no evidence of an actual native gate-failure terminal in that particular run. The [related upstream user report #3366](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3366) concerns completed status after provider failures, but uses other versions/providers and has no maintainer-confirmed diagnosis of our trace.

The alias `selected` was investigated as a possible loss of shipped model-specific prompt additions. At the pinned source, [model_prompts.toml](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/prompts/layers/model_prompts.toml) contains a GLM-5.3 rule, not a GPT rule. That observation does not support blaming a missing shipped GPT prompt rule. Other provider/model-id/history conversions remain unverified against Prime's official Codex provider.

The 32-request tree ceiling, parent/child budget split, at-most-two-child policy and forced end-turn waiting are plausible constraints on strategy. A different model can also behave differently with the same harness. None has been isolated as the cause. Increasing budgets, changing the model or selecting another task after seeing outcomes would require a new frozen experiment; it is not done by this analysis.

## Upstream request and PR boundary

The reviewed, sanitized integration scheme, all latest condition scores/request counts, retained adverse ARC outcomes and five maintainer questions were submitted to **[Prime Agent Discussion #3709](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3709)**. It requests:

1. A small known-good recursive reference recipe with exact source, public item IDs, prompts, model/provider settings, scorer, whole-tree limits and a recursion-disabled control.
2. Official-provider/ACP conformance requirements for a custom Codex Chat Completions bridge, including model identity, history/tool/reasoning mapping and effective limits.
3. The supported spawn/wait/collect sequence and whether our evaluation's operational restrictions distort the intended strategy.
4. Parent synthesis budget reservation or child budget assignment, plus reliable terminal evidence for budget/provider errors versus accepted task completion.
5. A recommended Rust commit/mode for comparison with the historical runtime and any known relevant parity limits.

The user explicitly authorized approaching Prime and requesting a PR. The external repository has an additional maintainer-controlled intake condition: its [CONTRIBUTING.md](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e82362747072cdbcf914e6c9ab9742c3bcbe292/CONTRIBUTING.md) says, "Pull requests from unvouched contributors are automatically closed." The published [contribution workflow](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e82362747072cdbcf914e6c9ab9742c3bcbe292/.github/workflows/contribution-gate.yml) enables that check. At this review, `lisihao` has READ permission and is absent from the published [VOUCHED list](https://github.com/PrimeIntellect-ai/prime-agent/blob/0e82362747072cdbcf914e6c9ab9742c3bcbe292/.github/VOUCHED.td).

The concrete documentation proposal and request are available in the Discussion for review. **No upstream PR has been opened; a PR that passes the contribution gate requires a maintainer invitation/vouch under that policy.** This is an external maintainer dependency, not missing permission from the user. No approval is invented, no alternative account is used, and no automatic-close gate is bypassed. No background monitoring or follow-up automation is enabled.

Only public task identity, source pins, scheme, sanitized scores/resources and evidence hashes were sent. No original/reference answers, generated labels, hidden reasoning, private session logs, provider payloads, account data or credentials were attached. No installed-app efficacy or release is implied.

Publication readback on 2026-10-21 verified that Discussion #3709 exactly matches the reviewed input (body SHA-256 `7a047a8e894433d5f264dc41588460623cf0bf5df8a209128a6f3a01c9638511`). At that check it had zero comments and no accepted answer. This snapshot is not a claim about future replies.
