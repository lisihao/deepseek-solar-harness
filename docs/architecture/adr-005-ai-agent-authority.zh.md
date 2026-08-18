# ADR-005：Code-as-Harness 是 Agent 完成准入权威

状态：已接受

[English](adr-005-ai-agent-authority.md) | 中文

## 背景

仓库文本可以指导 AI Coding Agent，但不能证明哪些文件发生变化、哪些门禁实际运行、证据是否新鲜，以及交付字节是否等于评审过的提交。

## 决策

在 DSH 中，Code-as-Harness 只指用户在 Codex 中创建并导入 `plugins/managed/governance` 的 `agent-development-governance` 项目。由它导出的仓库内执行 bundle、Profile、attestation、DSH 完成工具、CI 和受保护分支共同决定准入。仓库内 `dsh-code-as-harness` skill 只是 DSH 入口，绝不是第二套实现。

每个 Agent 任务都要从严格 audit 和变更感知 plan 开始，在隔离 worktree 中工作，使用项目原生控制，完成 full verify 与 attestation，并在 push 前重新验证提交后的精确字节。完成还要求远端 SHA 一致，以及所有适用的运行时或 Desktop D00-D08 证据。

## 后果

Agent 不能仅凭宣称遵循规则来自我认证。接线缺失、证据陈旧、门禁跳过、远端移动或完成权威不可用时，状态只能是 `pending` 或 `error`。提示词与 skill 负责引导行为，可执行控制负责决定是否接受。
