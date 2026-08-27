# Orchestration

English | [中文](README.zh.md)

`ctx.orchestrations` owns the provider-neutral API for compiling, starting, observing, approving, pausing, resuming, cancelling, explicitly resolving durable TaskGraph runs, and reading their immutable content-addressed artifacts. A sealed `NodeExecutionPlanV1` is immutable after its physical-operator receipt is accepted.

An RLM node may opt into Prime-compatible Autonomous Mode. The Graph or run admission selects `disabled | auto | enabled`; the resolved continuation, token, elapsed-time, and host quality-gate policy is content addressed and sealed into that attempt's `NodeExecutionPlanV1`. Autonomous Mode is a host continuation policy inside one node, not a Goal and not another Scheduler. It remains disabled by default.

## Model Experience

Indirectly, through the model-facing orchestration Consumer. This Service Definition does not register tools or prompt text.

#### KV Cache effect

None directly. Each Consumer owns the bounded summary it returns to a model.

## Known Limitations and Deferred Work

- Capability updates support pre-dispatch and next-turn generations. In-turn checkpoint application remains unavailable unless a future physical Provider explicitly attests it.
- Autonomous host quality gates currently execute only local shell commands within the Graph's declared `autonomous-gate` effect budget.
