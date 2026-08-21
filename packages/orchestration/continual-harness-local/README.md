# @deepseek-ai/dsh-continual-harness-local

English | [中文](README.zh.md)

Owner-local persistent Provider for `ctx.continualHarness`. It stores only bounded outcome summaries, tags, and Evidence references under the orchestration daemon root. It never stores raw prompts, full transcripts, credentials, or model-private state.

Snapshots are scope-filtered, versioned, content-addressed, and immutable once sealed into a node attempt.
