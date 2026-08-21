# @deepseek-ai/dsh-continual-harness

[English](README.md) | 中文

与 Provider 无关的 Continuous Harness seam。它为 TaskGraph 节点快照版本化指令、记忆、Skill、子代理模式及有界结果引用；它不是另一套 Scheduler、模型 Provider 或对话存储。

Scheduler 只消费不可变快照，并在结算后记录有界 Evidence 引用。
