# Debate Local Provider

English | [中文](README.zh.md)

`@deepseek-ai/dsh-debate-local` is the owner-local persistent Provider for the provider-neutral `@deepseek-ai/dsh-debate` Service Definition. It implements `start`, `list`, `inspect`, `readEvents`, and `control` over an atomic `<root>/state.json` document. The root is intended to be owner-private.

The Provider has one execution boundary: an injected `DebateRoundExecutor`. One call represents one complete round and returns results keyed by roster slot. The production adapter maps that call to one existing TaskGraph; this Provider does not start a Scheduler, invoke Codex or Claude CLI, create TaskGraph nodes, or call a real subscription/API. Role-to-model binding remains a replaceable capability-aware roster plan supplied by the Consumer.

## Lifecycle and durable state

- `enabled` creates an `awaiting_approval` run; `control({ action: "approve" })` admits it. `auto` admits on `start`, and `disabled` records a structured stopped run without executing a turn.
- Every mutation is revision-fenced, command-idempotent, writer-locked, and atomically replaced. A durable command receipt reaches `accepted` before any TaskGraph call, then advances through `running` to `settled` or `indeterminate`. Replaying a settled command returns its recorded response; an unproven command is never executed again automatically. Events are append-only and `readEvents` returns the last consumed sequence as its continuation cursor.
- A TaskGraph-backed executor may call its per-round `onProgress` sink while a slot is still `dispatched`. The Provider validates and immediately appends only the whitelisted public projection as `debate.agent.progress`, deduplicated by `(round, slot, orchestration run, source sequence)`; it never persists raw prompt text, hidden reasoning, credentials, or native session/command IDs.
- The snapshot retains the fixed roster, round projections, claim ledger, dissent, unresolved gaps, evidence references, provenance, and per-slot token/cost ledger. Missing usage or cost marks the public projection `unknown` or `partial`; a configured budget whose consumption cannot be proven produces terminal `budget_limited`, not apparent success.
- After convergence evaluation reaches `converged`, `budget_limited`, or `max_rounds`, the run remains `synthesizing` until `debate.synthesis.settled` commits the final `completed`, `budget_limited`, or `max_rounds` state. Final states cannot reopen or dispatch another round. Newly admitted runs persist a public topic from `objective`, or from `prompt` when no objective is supplied; legacy records without topic text remain missing rather than borrowing another topic.
- `control` can approve, pause, resume, stop, or reject. A running pause is persisted as a round-boundary intent, while stop aborts the injected round executor; an interruption whose downstream TaskGraph outcome cannot be proved becomes `indeterminate`. A paused run can be resumed only with its current revision and a matching `resume` command.

## Deterministic round protocol

The local implementation makes the following boundaries observable in the turn request and event stream:

1. Round one is `blind-independent`. Each fixed roster slot receives an empty prior ledger, dissent list, and unresolved list. The Provider emits all dispatch events before invoking the round executor and applies its slot-keyed results in stable roster order.
2. Later rounds use `claim-ledger`, or `high-severity-unresolved` when a high/critical unresolved gap remains. Participants must reuse prior-ledger claim IDs. The decision judge may add at most four reconciliation claims required to combine the current round's participant evidence; dissent and unresolved entries must still reference either a prior claim or one reconciliation claim emitted by that judge result. Unknown or unbounded follow-up IDs fail the turn.
3. Every executor result must submit a calibrated turn-level `confidence` in `[0, 1]`. Claims and dissent also carry confidence and evidence references; the Provider keeps those values in the ledger/event projection.
4. Convergence requires settled-agent and policy thresholds, no newly introduced unresolved claim, and confidence-weighted agreement. Opposed claims and dissent contribute their reported confidence to disagreement; the score is the mean claim confidence multiplied by `(1 - disagreement)`. Otherwise the state deterministically advances until `maxRounds`, token, turn, or cost budget produces `max_rounds` or `budget_limited`.
5. A converged ledger is synthesized through the decision-judge projection; dissent remains visible. Consumers should retain an independent majority vote/synthesis baseline and compare it with debate. `auto` is a caller choice, not a claim that debate universally improves quality.

The roster is deliberately small and the default contract bounds rounds, turns, agents, tokens, and cost. The Provider sorts the contract's fixed role IDs deterministically, while the Consumer remains responsible for capability qualification and model selection.

## Blind quality and cost evaluation

The package exports `evaluateBlindDebateQualitySuite` for reusable Standard-versus-Debate evaluation. Daily development uses frozen, method-anonymous fixture arms and a separate reveal key, so scoring never invokes a model or exposes the method assignment before both outputs are recorded. The report includes quality delta, token and account-sourced cost deltas/ratios, average rounds, and Debate early-stop count/rate. Missing usage or cost is reported as `unknown` or `partial`, never zero.

Every suite carries an explicit `evidence.evidenceKind`:

- `synthetic-fixture` and `recorded-keyless` can return only `fixture-regression-passed`; they verify evaluator and product regressions but cannot support a claim that Debate improves real output quality.
- `real-subscription` is reserved for the single approved final blind recording. Only a passing report with this provenance can return `measured-lift-passed` and `supportsQualityClaim: true`.

The committed fixture contains no `standard` or `debate` method key. Its separate assignment file is applied only after the anonymous arms are frozen. The evaluator itself performs no subscription or API call.

## Design basis

This package applies, without claiming to reproduce or validate the cited papers, the following design lessons:

- [arXiv:2305.14325](https://arxiv.org/abs/2305.14325) motivates the bounded propose/refute/common-answer progression.
- [arXiv:2601.19921](https://arxiv.org/abs/2601.19921) motivates independent diverse candidates, explicit calibrated confidence, and delayed exposure of peer outputs; homogeneous early debate can be worse than voting.
- [arXiv:2508.17536](https://arxiv.org/abs/2508.17536) motivates retaining a majority-vote comparison and treating debate gains as non-guaranteed.
- [arXiv:2601.17152](https://arxiv.org/abs/2601.17152) motivates capability-aware role assignment as a replaceable plan rather than a hard-coded executor.

These are design inputs and limitations, not a quality guarantee. The local Provider does not implement Consumer/UI views, a real model adapter, quota admission, source-content retrieval, or cross-process execution recovery. A Consumer must own those integrations and evaluate vote, synthesis, standard, and debate paths with offline fixtures before enabling a more expensive mode.

## Model Experience

### Injected `DebateRoundExecutor` execution

#### What the model sees

The injected `DebateRoundExecutor` receives a bounded, role-labelled request and returns slot-keyed results. This Provider has no direct model or subscription surface and never assumes that two role slots share a model context.

#### Token effect

The policy bounds agents, rounds, turns, and tokens. The local Provider adds no model prompt of its own and records only usage reported by the executor.

#### KV Cache effect

The Provider records cache-read/write token counters when the executor reports them. It neither creates nor shares a cache and does not treat cache reuse as evidence of agreement.

## Known Limitations and Deferred Work

- No UI, daemon, Scheduler, Codex/Claude adapter, or real API subscription is included. `@deepseek-ai/dsh-debate-orchestration` supplies the existing-TaskGraph Consumer separately.
- A turn executor failure is terminal for the current run (`failed` or `indeterminate`); retry policy belongs to the owning Consumer. Restart recovery deliberately marks an accepted/running command `indeterminate` instead of reconstructing or replaying downstream execution.
- State replacement is atomic but intentionally does not claim fsync-level crash durability; the shared atomic-write utility owns that boundary.
- Synthetic quality fixtures are regression evidence only. A real quality claim still requires one separately authorized `real-subscription` blind recording.
