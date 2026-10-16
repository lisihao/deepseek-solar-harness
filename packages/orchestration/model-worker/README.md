# dsh-model-worker

English | [中文](README.zh.md)

Registry seam for optional one-shot model workers. The orchestration allocator can consider their offers after native-subscription operators; Providers never schedule the TaskGraph.

An execution request may carry the orchestration parent Agent for a Provider that starts a physical operator; an in-process Provider may ignore it.

## Evaluation block

`ModelWorkerExecuteRequest.evaluation` (`ModelWorkerEvaluationV1`) is set only by an orchestration layer that holds an evaluation scope. It names the wire `model`, the `maxOutputTokens` ceiling of one physical request, the reasoning effort, a reader of the output tokens still available, and a factory of per-request admissions. A worker that receives it must send exactly those generation values on every physical request and must not fall back to a provider default. A request without it keeps the worker's ordinary behavior.

## Model Experience

None, as this registry seam contributes no model-visible content directly.

#### KV Cache effect

Worker Providers own the request prefix for their sealed execution lane.

## Known Limitations and Deferred Work

- Version 1 is one-shot and text-oriented.
- Durable native sessions, workspace tools, and TaskGraph scheduling remain owned by the physical-operator and orchestration services.
