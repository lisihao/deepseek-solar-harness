# dsh-model-worker

English | [中文](README.zh.md)

Registry seam for optional one-shot model workers. The orchestration allocator can consider their offers after native-subscription operators; Providers never schedule the TaskGraph.

## Model Experience

None, as this registry seam contributes no model-visible content directly.

#### KV Cache effect

Worker Providers own the request prefix for their sealed execution lane.

## Known Limitations and Deferred Work

- Version 1 is one-shot and text-oriented.
- Durable native sessions, workspace tools, and TaskGraph scheduling remain owned by the physical-operator and orchestration services.
