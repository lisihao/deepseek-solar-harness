# Capability Capsule

[English](README.md) | 中文

`ctx.capabilityCapsules` 快照不可变 manifest，并解析 Attempt 范围内的绑定。解析受到 Graph 的能力、effect、scope、算子和已批准 secret 上限约束。

## Model Experience

间接产生影响：编排消费方渲染带 hash 的指令和资源引用。

#### KV Cache effect

一个已封存 Attempt 内的绑定保持稳定。后续目录 revision 只影响尚未 accepted 的 Attempt 或新的能力 generation。

## Known Limitations and Deferred Work

- 本地提供方支持内容寻址磁盘目录和测试胶囊。生产目录与轮次内 checkpoint 应用后置。
