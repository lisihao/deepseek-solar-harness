# ADR-001：Solar 下游产品

状态：已接受

[English](adr-001-downstream-solar-product.md) | 中文

## 背景

Solar 代码线已经承载有意独立于 DeepSeek Harness 官方仓库的产品行为。继续把这些提交视作临时补丁，会掩盖产品所有权、发行身份和后续变更方向。

## 决策

DeepSeek Solar Harness，简称 DSH，是一个以下游方式演进、macOS 优先的产品。`solar` 是受保护的集成分支，变更只能通过经过评审的任务分支进入。DeepSeek Harness 官方仓库和所有外部插件仓库都是只读上游输入。Solar 自动化与 Agent 禁止向上游 push、创建上游 PR、发布上游包或使用上游发布凭据。

DSH Desktop 拥有独立于上游核心与插件版本的语义化版本。每个稳定版本必须使用符合 `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$` 的 annotated tag，例如 `DSH-desktop-v2.4.3`。

## 后果

Solar 可以独立演进，不再把修改后的代码伪装成上游发行版。每次产品发布都必须标识 Solar 提交、已接受的上游版本、受管插件版本、校验和、测试证据和回滚目标。上游变更在兼容性与能力检查接受之前始终只是候选项。
