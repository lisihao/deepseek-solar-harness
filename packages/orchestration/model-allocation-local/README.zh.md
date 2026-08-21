# @deepseek-ai/dsh-model-allocation-local

[English](README.md) | 中文

`ctx.modelAllocation` 的确定性 Provider。它优先使用合格的原生订阅，把每个上报的配额池独立核算；规划/验证优先高阶模型，并行执行优先低/中阶模型，临近配额重置时提高可用并发。

Provider 只接收规范化 Offer，不导入 Codex、Claude、DeepSeek、Resident daemon 或 Scheduler 实现。
