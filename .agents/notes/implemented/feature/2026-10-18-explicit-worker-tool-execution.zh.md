# Agent Note: 显式 Worker 工具执行

Status: implemented

[English](2026-10-18-explicit-worker-tool-execution.md) | 中文

## 问题

CodeAct 对照 Consumer 需要与 RLM 共用实际工具循环和物理请求准入，不能声称开启了 RLM plan。此前只有该 plan 才能选择 DeepSeek worker 的工具循环。

## 决策

model-worker Definition 提供可选的显式 toolExecution，Provider 声明 supportsToolExecution 能力。不支持的 Provider 在执行前被拒绝。DeepSeek 优先使用显式限制；只有缺省且 RLM plan 已开启时才推导原有限制，否则保持普通单请求生成。缺失或不兼容的 bridge 在首次模型请求前失败。两种工具路径共用 generateWithTools、collectResponse 和 evaluationOptions。

maxToolRounds 限制工具执行轮数，不是物理尝试数。N 轮可能需要 N+1 次模型请求；最后一次响应不能再执行工具。原请求准入、物理观察器、缺失 usage 和终止结果保持权威。Worker 不在拒绝、取消或未知结果后重启命令。[Provider README](../../../../packages/orchestration/model-worker-deepseek/README.md) 是请求约定的主文档。

## 已考虑的替代方案

为 CodeAct 开启 RLM plan 会混淆对照的工具能力与 RLM 选择。另写工具循环则会复制对照必须共用的执行和计量路径。

## 影响

这个内部接缝允许 fake adapter 通过实际 Worker 和 IPC bridge 进行比较。等提示词检查比较模型可见消息字段、工具、生成参数、准入和 bridge 请求；排除自动生成的消息身份与时间字段。这不证明上下文外置、独立 spawn 策略、整树预算、论文忠实复现或实测收益。装配的离线 Consumer 与 Loader transcript 仍是后续独立集成工作；不包含付费实验或安装。
