# Orchestration

English | [中文](README.zh.md)

`ctx.orchestrations` owns the provider-neutral API for compiling, starting, observing, approving, pausing, resuming, cancelling, and explicitly resolving durable TaskGraph runs. A sealed `NodeExecutionPlanV1` is immutable after its physical-operator receipt is accepted.

## Model Experience

Indirectly, through the model-facing orchestration Consumer. This Service Definition does not register tools or prompt text.

#### KV Cache effect

None directly. Each Consumer owns the bounded summary it returns to a model.

## Known Limitations and Deferred Work

- Capability updates support pre-dispatch and next-turn generations. In-turn checkpoint application remains unavailable unless a future physical Provider explicitly attests it.
