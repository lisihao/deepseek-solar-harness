# ADR-005：Code-as-Harness 是 Agent 完成准入权威

状态：已接受

[English](adr-005-ai-agent-authority.md) | 中文

## 背景

仓库文本可以指导 AI Coding Agent，但不能证明哪些文件发生变化、哪些门禁实际运行、证据是否新鲜，以及交付字节是否等于评审过的提交。

## 决策

在 DSH 中，Code-as-Harness 只指用户创建并导入 `plugins/managed/governance` 的 `agent-development-governance` 项目。它导出的 bundle 与 Profile 在每个指向 `solar` 的 PR 上由 `solar-governance.yml` 运行；该 CI 结果、其他必需检查和受保护分支共同决定准入。仓库内 `dsh-code-as-harness` skill 用于复现失败的门禁或按要求运行 harness，绝不是第二套实现。

Agent 在隔离 worktree 中工作，push 前通过 `dsh-pre-push-checks` 运行与改动相关的聚焦证据。它们不在每个任务中本地重复 audit、plan、full verify 或 attestation：CI 会针对实际 push 的提交运行这些步骤，本地重跑只消耗 Agent 时间和 token，不增加准入证据。Desktop 打包与安装只在明确的发布或安装请求下遵循 `products/desktop/AGENTS.md`。

## 后果

Agent 不能仅凭宣称遵循规则来自我认证。PR 在其 head 提交上通过治理工作流和必需检查之前保持未合并。聚焦的本地检查可能漏掉只由 CI 运行的门禁；这类失败会在 PR 上暴露并在那里修复，而不是靠完整的本地预演来预防。提示词与 skill 负责引导行为，可执行控制负责决定是否接受。
