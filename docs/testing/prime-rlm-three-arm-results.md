# Original-question bare / Prime / plugin results

Date: 2026-10-21, Asia/Shanghai. The fixed [protocol](prime-rlm-three-arm-protocol.md) produced **no completed native-versus-bare quality pair**. The bare answer completed; both original Prime and the plugin consumed their 32-request tree ceilings without writing an answer. The [machine-readable report](prime-rlm-three-arm-results.json) retains all attempts.

| Arm | Official score | Root / child calls | Task status |
| --- | ---: | ---: | --- |
| Bare D1 | 0.2373046875 | 1 / 0 | Complete |
| Original Prime R32 | Unscored | 7 / 25 | Incomplete |
| Plugin S32 | Unscored | 7 / 25 | Incomplete |

The unchanged official score is 0.75^absolute_error. Independent grading reproduced the bare score. Worker lifecycle completion and clean shutdown are true for both native arms, but neither proves task completion. The runner's stop text “all conditions completed” means the declared conditions were attempted; the explicit per-condition status remains incomplete. No draft is promoted to a completed answer.

The recovery added 65 confirmed logical/physical requests and no unknown. Including the initial connection failure, cumulative usage is **589 = 575 confirmed + 14 retained unknown**, under the user's 600 ceiling. Across both attempts, six conditions comprise one completed, two incomplete, one unknown and two not run. Historical unknown calls are not refunded. No paid API fallback or retry was used.

## Real-provider original/plugin differential

Both first requests have the same model, high reasoning configuration, tools, native harness instructions, task and public file content after replacing only their exact owned directory, conversation-log path, route session id and message durable ids. The public dates and task contents are untouched. The normalized envelope SHA-256 is 914ceaf32e44762bd73fe66844cf29c728015090ea5522381cdd617b89e9b4fc. This rules out an observed initial-envelope content gap in this sample; it does not prove every later trajectory is equal or all packaging behavior is correct. Both native executions actually made 25 depth-one child calls.

## Confirmed timing failure

All eight original and all six plugin children first received a clarification without their initial assignment. This is **not permanent task loss**: the original task row was later written into each child's durable session, and some plugin children actually continued with it before reaching the limit.

The pinned original [child host](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_children/host.rs#L236) deliberately waits for the parent turn boundary before calling the child's initial prompt. An [agent message](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/worker/input.rs#L313) can enter the steering lane immediately. The models spawned children, kept the parent turn open, and sent clarifications; the children then spent calls discovering their missing assignment. R additionally produced six “Unknown active session: parent” tool errors. This explains a concrete failure mode in these runs, not every earlier negative result.

A zero-model native reproduction exercised original Prime and the plugin with and without an immediate follow-up. Both controls received the initial task first (six local scripted calls each). Both early-message cases received the follow-up first and the original task later (seven each). All four final fixtures completed and cleaned up. Two earlier fixture attempts had a script completion/serialization error; their records remain retained and are not accepted as full fixture passes. No Prime source or runtime was changed.

## Bounds and next declared recovery

The 787-record case uses the pinned paper-period original OOLONG question and scorer, with common batching instructions and gpt-6.1-sol/high. That is a declared transfer adaptation, not exact paper reproduction. Configured maxTokens=16384 is not serialized as a backend output-token cap by this subscription SDK; actual usage is retained. Cache-related provider totals are reported as received rather than reconstructed from selected fields.

The separate [Q03 supplement](prime-rlm-q03-bare-supplement-results.md) still shows a mixed primary pair-F1 gain: recursive S 0.240000 versus bare D 0.205882, while label accuracy favors D and no-recursion S0 outperforms S. None of those adverse facts is replaced by this panel.

The remaining eleven authorized calls are reserved for one explicitly exploratory same-question plugin recovery. Its instructions explain the native parent-turn boundary, prohibit premature child steering, cap decomposition at two children and retain an eleven-call parent/native ceiling. The change is operational prompting, not a Prime mechanism change. Its outcome must be reported separately, including failure. This is not a fresh confirmatory three-arm study or a causal recursion comparison.

Execution source: 82a0e0d3e60e41abbc52282128285b207a802a7a. Prepared fingerprint: d4248f2c7ccbef6276f4e318fddac9bd298c73e84a7997c77ac2944d3aa2f1e5. Receipt SHA-256: 198af00fae2f93efaba9e97aa52eeee343ceafbc66b020313ad033fb990022d2. Independent accounting, scorer, process and both retained-socket closure checks passed. Private sessions, labels, provider payloads, account data and credentials are excluded from Git.
