# `@deepseek-ai/dsh-debate-orchestration`

English | [中文](README.zh.md)

This package binds one Debate round to the existing durable `ctx.orchestrations` TaskGraph service. Participant nodes are independent and may run in parallel; the single `decision-judge` node depends on all participants and therefore receives their settled Evidence through the ordinary Context Packet path.

## Authority

The plugin injects only `orchestrations`. It never imports, injects, or calls `physicalOperators`, and it does not create another scheduler. Every node pins the roster's operator and native model, disables RLM and Autonomous Mode, requests no write or execution effects, and is dispatched only after the existing Scheduler seals its `NodeExecutionPlan`.

The first adapter accepts native-subscription roster slots only because the current TaskGraph service can enforce exact native Resident model profiles. Metered/local slots fail explicitly until their Scheduler offer path exposes the same exact-model guarantee.

One round produces one TaskGraph. The adapter returns a slot-keyed result map after reading the immutable execution Evidence retained by `ctx.orchestrations`. Missing usage remains absent; the Debate Provider projects it as unknown rather than zero.

The Debate command receipt is durable before this adapter is called, and the TaskGraph start command is deterministically `debate:<run>:round:<n>`. A stop signal uses the existing Orchestration `cancel` control and waits for a confirmed cancelled projection. Revision conflict or an otherwise unproven cancellation returns `DEBATE_INDETERMINATE`; the Provider does not replay the round.

The optional `dshHome` configuration follows the harness-wide home resolution rules. Debate run state is stored under `$DSH_HOME/debates`; Bundle users do not configure an independent state path.

## Model Experience

### Sealed `NodeExecutionPlan` round

#### What the model sees

Each participant executing a sealed `NodeExecutionPlan` sees its fixed role persona, the user request, objective, source lineage, prior claim ledger, dissent, and unresolved gaps. The judge additionally receives bounded participant Evidence through the ordinary Context Packet path.

#### Token effect

Each roster slot receives one bounded prompt. Participant turns can overlap, while the judge starts only after their Evidence settles.

#### KV Cache effect

No cross-node cache contract is assumed.

## Known Limitations and Deferred Work

- The current TaskGraph Context Packet gives the judge bounded previews of participant Evidence. Source refs outside the orchestration artifact store remain lineage-only until their owning source provider materializes them.
