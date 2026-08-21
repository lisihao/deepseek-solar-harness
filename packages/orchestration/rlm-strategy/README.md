# dsh-rlm-strategy

English | [中文](README.zh.md)

Provider-neutral node-local recursive execution seam. It resolves an immutable bounded RLM plan before dispatch; it is not a physical operator and never mutates or schedules the global DSH TaskGraph.

## Model Experience

None, as this seam contributes no model-visible content directly.

#### KV Cache effect

The resolved Provider owns any bounded recursion instructions added to the sealed node request.

## Known Limitations and Deferred Work

- The first release supports pre-dispatch and next-turn boundaries only.
- Checkpoint-based mid-turn capability hot swap remains unsupported by Claude Code and Codex Providers.
