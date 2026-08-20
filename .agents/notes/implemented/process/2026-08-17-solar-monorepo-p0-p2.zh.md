# Agent Note: 通过 P0-P2 建立 Solar monorepo

Status: implemented

[English](2026-08-17-solar-monorepo-p0-p2.md) | 中文

## 问题

DeepSeek-Solar-Harness 的开发分布在核心 checkout、内部又包含 Harness checkout 的 Desktop 仓库、用户创建的 Code-as-Harness 项目，以及若干修改过的插件仓库中。该结构可以产生可工作的本地应用，但一个 clone 无法评审或修改完整的 Solar 自有源码闭包。统一仓库还必须避免修改任何作为导入来源的源码仓库，以及已安装的 `/Applications/DSH Desktop.app` 运行态。

## 决策

受保护 `solar` 分支是集成权威，任务在 `/Users/sihaoli/Projects` 下的 linked worktree 中执行。核心保留在 monorepo 根目录，Desktop 位于 [`products/desktop`](../../../../products/desktop)，受管源码位于 [`plugins/managed`](../../../../plugins/managed)，产品元数据位于 [`distribution`](../../../../distribution)。Desktop 导入保留来源 revision `c4485d5a8b73b5fecc6b6424187a3524b4b2890c` 的历史，并移除嵌套 Harness gitlink。

受管源码注册表接受六个组件 revision：governance `9b315f75299b8b677a08c844cf294e35cdd366b9`、Agent Teams `ff3369241dbf9763e34e11292823d5d78a9d8713`、Luna Vision Bridge `0173d93fab9f480d9a7548ac65cf04c3488fb8bb`、Memory Evolve `ce7f0faa0e0240f117c29795e9224c0d9ed18183`、Web Billing `690fdb1172366e139e590c4a8fe3f11c95b7ac90`，以及 Web UI `7b99d9eb69202199fffe378b289425b224691d23`。每份源码历史都通过 subtree 导入，[`plugins/registry.yaml`](../../../../plugins/registry.yaml) 记录 package 身份、source 与 upstream URL、branch、接受 SHA、许可证证据和原生检查。Memory Evolve 后续发现的远端 revision 继续作为候选，不会在迁移期间改变已接受的本地 revision。

Code-as-Harness 精确表示用户在 Codex 中创建、并导入 [`plugins/managed/governance`](../../../../plugins/managed/governance) 的 `agent-development-governance` 项目。它自己的导出器在 [`tools/agent-development-governance`](../../../../tools/agent-development-governance) 生成经过 digest 校验的 runner；[DSH 入口 skill](../../../skills/dsh-code-as-harness/SKILL.md) 则把 agent 路由到已导入的权威 skill 与合同。仓库 Profile 选择根、Desktop 与组件原生门禁，Solar CI 执行同一个 runner。

本次结构迁移期间 DSH Desktop 保持版本 `2.4.2`。产品 manifest 要求 annotated stable tag 匹配 `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$`；迁移不会分配新应用版本、构建可安装 artifact、启动 Electron、替换已安装应用或部署其他机器。

## 验证

仓库校验器绑定产品身份、Desktop version 与标签模式、接受的源码 SHA、subtree 导入记录、许可证证据、不存在嵌套产品 gitlink，以及治理导出 manifest。反例测试会拒绝旧 `desktop-v...` 标签格式、非法或未绑定的源码来源，以及嵌套 Desktop Harness gitlink。每个导入组件保留自己的原生 lockfile 与验证命令，Code-as-Harness full verification 和 attestation 则覆盖完整 `origin/solar` 差异。

第一次完整执行发现，已接受 core 基线中仍有一项尚未完成的 Cordis package name rescope。仓库自带的确定性 rescope 工具完成了这 26 个 core 位置，没有引入 waiver 或降低门禁。根 lint 与 rescope 工具现在排除由独立原生门禁负责的 `products/desktop` 和 `plugins/managed`，反例测试则固定该所有权边界。

用作导入来源的源码仓库继续作为独立 checkout。迁移读取其中的接受 commit，但不改变它们的 branch、working tree、remote 或历史。已安装应用继续作为运行态输出；除确认 bundle metadata 没有被替换之外，它不是迁移验证目标。

## 曾考虑的替代方案

**保持仓库分离并记录绝对路径。** 否决，因为路径不能提供一个可评审的源码闭包、不可变来源或协调一致的 PR 证据。

**复制当前目录树但不保留历史。** 否决，因为 snapshot 会隐藏源码归属，并降低后续上游比较与冲突分析的可靠性。

**保留 Desktop 内嵌 Harness submodule。** 否决，因为这会复制核心源码权威，并在 monorepo 内继续保留仓库拆分。

**导入发现到的最新远端 revision，而不是接受的本地 revision。** 否决，因为发现不等于兼容性证据；上游移动属于独立候选分支与资格审查周期。

**把 Code-as-Harness 当成通用策略。** 否决，因为用户创建的项目、可执行 runner、DSH plugin、Profile 和 attestation 语义共同构成必需权威。

## 后果

Fresh clone 可以检查完整 Solar 自有源码集合，把每个导入组件追溯到接受 revision，并通过一个受保护集成分支路由改动。组件包管理边界保持显式；后续的 [Desktop 打包源码闭包](2026-08-20-desktop-source-closure.md) 已把每个 sealed 应用 package 映射到同仓已跟踪源码，而不改变这些边界。

必需人类评审会阻止本 migration 分支自行合并进 `solar`。上游发现与资格审查自动化、Desktop 源码输入集成、打包产品验收和发布自动化仍属于独立开发阶段，由根 README 路线图与上游资格审查 ADR 管理。
