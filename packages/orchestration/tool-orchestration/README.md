# Tool Orchestration

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.orchestrations`. It registers one `orchestration` tool for compiling and starting a complete version-one logical TaskGraph, listing runs, and inspecting bounded run state. The system prompt directs the main model to use durable orchestration proactively for complex work while keeping simple work on the current turn.

## Model Experience

### Durable TaskGraph policy and tool

#### What the model sees

The `orchestration` tool schema and one stable policy section describing complex-task admission, explicit Graph authority, automatic low-risk start, human approval for risky work, and restart-safe inspection.

#### Token effect

The policy is a fixed prompt section. Tool results are bounded to run, node, attempt, generation, operator, Evidence references, and blockers.

#### KV Cache effect

The stable policy and schema preserve their prefix. Dynamic tool results append to the Session only after calls.

## Known Limitations and Deferred Work

- The baseline Consumer accepts a complete `LogicalTaskGraphV1` as JSON. A future semantic Intent/Graph Compiler Provider may replace model-authored graph construction without changing `ctx.orchestrations`.
