# @deepseek-ai/dsh-continual-harness

English | [中文](README.zh.md)

Provider-neutral Continuous Harness seam. It snapshots versioned instructions, memories, skills, subagent patterns, and bounded outcome references for a TaskGraph node. It is not another Scheduler, model provider, or transcript store.

The Scheduler consumes only immutable snapshots and records bounded Evidence references after settlement.

## Model Experience

None, as this seam contributes no model-visible content directly.

#### KV Cache effect

Only the bounded Continuous Harness entries sealed into a node can change its request prefix.

## Known Limitations and Deferred Work

- Version 1 supports pre-dispatch immutable snapshots and post-settlement outcomes only.
- Live transcript capture, mid-turn mutation, and cross-machine synchronization are deferred.
