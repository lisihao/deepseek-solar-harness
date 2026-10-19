# Agent Note: Host 子调用策略

Status: implemented

[English](2026-10-18-host-child-spawn-policy.md) | 中文

## 问题

离线对照需要禁止子调用、只允许根调用，或允许有界递归，同时保持上下文放置和工具循环选择独立。此前 Runtime 限制约束递归和子节点数，但不能表达这些独立权限。

## 决策

Runtime Definition 提供 childSpawnPolicy。Local 将缺省值显式解析为 recursive，maxTotalChildren 等于 maxTurns；none 要求零，root-only 允许深度零的父节点，recursive 保留原深度约束。新后代继承精确的解析后策略和限制。[Local README](../../../../packages/orchestration/rlm-runtime-local/README.md) 是准入与恢复细节的主文档。

原同步 spawn 提交点在 dispatchChild 让出执行前持久保存已接纳后代。同命令 receipt 保持幂等。删除、失败和 indeterminate 等每个已接纳后代，继续占用同一根树的累计上限。重开既有 execution 时，不能在替换 Host binding 前改变其保留策略。

Local state 版本 7 要求解析后策略，并在未知工作恢复可写入之前校验父子引用、唯一身份、深度、继承限制和策略及累计上限。旧版本 1–6 和未知未来版本被拒绝，不迁移、不改 state 文件。Session 日志格式不变。

## 已考虑的替代方案

从提示词推定权限或隐藏子调用 helper，都不改变 Host 准入权威。把现有要求正数的 maxDepth 设为零，会混淆递归深度与权限。另加额度账本则会复制原同步已接纳子节点状态。

## 影响

保证仅适用于一个 LocalRlmRuntime 实例和一棵根树；不证明跨进程文件锁或无关根共享预算。它不计量 token，也不改变 WP1。Fake Host 测试覆盖策略拒绝、并发最后名额、删除与失败不退款、重启保留，以及写入前拒绝损坏持久关系。实际 Consumer 上下文外置、Loader 装配、完整物理计量、生产 token 上界和实测 RLM 收益仍是后续工作。未改已安装 Runtime。
