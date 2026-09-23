# prompt/ — user-managed prompt guidance

English | [中文](README.zh.md)

Product plugins that store, select, inject, and manage task-level prompt templates without changing the agent loop.

| Package | Role | ctx key |
|---|---|---|
| [`task-template/`](task-template/README.md) | Template Service Definition, deterministic selector, and private file Provider | `ctx.taskTemplates` |
| [`task-template-context/`](task-template-context/README.md) | Direct Agent request Consumer | — |
| [`task-template-rpc/`](task-template-rpc/README.md) | Authenticated Host management RPC | — |

The reusable method layer and the optional personal preference/memory layer are stored together under the DSH private-data root, but are versioned separately. Consumers record exact selection receipts so model-visible guidance is reconstructable without copying private data into the repository.
