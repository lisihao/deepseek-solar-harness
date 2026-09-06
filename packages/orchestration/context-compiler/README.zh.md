# Context Compiler

[English](README.md) | 中文

`ctx.contextCompiler` 生成不可变、受预算约束的 `ContextPacketV1` 投影，包含来源溯源、降级、脱敏和胶囊指令记录。各来源系统仍是权威。

## Model Experience

间接产生影响：编排执行计划为物理算子渲染一个已封存的数据包。

#### KV Cache effect

每个已封存 Attempt 都有稳定的数据包 hash；新的 Attempt 或能力 generation 可以替换该数据包。

## Known Limitations and Deferred Work

- 本地基础提供方只纳入节点任务、工作区、scope、验收条件、上游产物引用和胶囊指令；检索、压缩与多源融合后置。
