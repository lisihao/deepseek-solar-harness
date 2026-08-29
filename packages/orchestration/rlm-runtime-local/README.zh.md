# @deepseek-ai/dsh-rlm-runtime-local

[English](README.md) | 中文

`ctx.rlmRuntime` 的 owner-local Provider，提供持久 TypeScript REPL namespace、节点内 Child Registry、家庭范围消息、Command Receipt、变量快照、Goal 和游标事件。

## Runtime 行为

一个逻辑 RLM Session 持有一个 lexical namespace。可编程 `context` 对象和可独立恢复的 binding 跨 Provider 重启保留；单个 binding 失败会保持具名 degraded 状态，不阻断其他 binding 恢复。Kernel 使用 TypeScript AST 发现顶层声明，包括解构和同一语句内的多个声明。可克隆的值从最新 V8 value snapshot 恢复；V8 无法克隆的静态 import、function、class 和直接函数表达式 binding 从声明源码恢复。带私有捕获状态的工厂闭包会明确降级：本 Runtime 不会假装 V8 可以序列化 closure。

快照上限与 Prime v0.8 默认值一致：单个 binding 16 MiB、包含 `context` 的可编程状态总量 256 MiB。超限或其他无法恢复的 binding 会被独立跳过，其余 namespace 继续恢复。

`rlm(task, { name })` 通过 Consumer 提供的 Host binding 准入 Child，并在 Child result settle 前返回 handle。`skills.list()` 投影父执行已经密封的 Skill catalog；`skills.call(name, args)` 只通过 Consumer 持有的 Host binding 转发该 catalog 中可用且由 Host 签发的 alias，因此 Runtime 代码既不能提交 import path，也不能在同一 Attempt 中观察到目录更新。Cell 串行执行，已准入的 Child execution 可以并发推进。显式消息和 Artifact reference 才是答案通道。Local Provider 还实现了版本化的 Agents View `attach → input → detach` 控制面：一个存活 caller 只能持有一个 lease，控制输入通过现有 message/continuation pump 排队，进程重启后可回收死进程遗留的 lease。

状态原子写入配置的 owner-local root。重启恢复会分别恢复可序列化变量，把未完成 Receipt 变为 `indeterminate`，并要求显式放弃，绝不重放无法证明的原生 effect。`compact.run()` 只记录 Receipt 绑定的 Host 调度决定；真实原生历史压缩必须由 Host 在 turn boundary 执行，TypeScript namespace 不会被重置。

## Model Experience

Indirectly, through a Consumer that exposes the Provider as the `typescript_repl` model tool.

#### KV Cache effect

Provider 不直接组装模型上下文。Tool schema 和有界 Cell result 由 Consumer 持有，不改变已经可复用的 Prompt prefix。

## Known Limitations and Deferred Work

- **不是操作系统安全沙箱** — TypeScript namespace 具有 owner daemon 的操作系统权限；TaskGraph scope/effect 准入必须在派发前完成。
- **源码恢复边界** — 声明源码恢复可保留直接 function/class/import 以及它们对其他已恢复顶层 binding 的引用；它重新创建声明代码，不会保留工厂 closure 捕获或已变更 class 静态字段等可变运行时状态。
- **兼容子集** — 原生 Provider tool 与 Continuous Harness 持有剩余 Prime 端到端兼容项。
