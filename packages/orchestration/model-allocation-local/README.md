# @deepseek-ai/dsh-model-allocation-local

English | [中文](README.zh.md)

Deterministic Provider for `ctx.modelAllocation`. It ranks qualified native subscriptions before metered API offers, treats every reported quota bucket independently, gives high-tier models to planning and verification, gives low/mid-tier models to parallel execution, and increases usable parallelism when an allowance reset is close.

The Provider receives normalized offers and never imports Codex, Claude, DeepSeek, Resident daemon, or Scheduler implementations.
