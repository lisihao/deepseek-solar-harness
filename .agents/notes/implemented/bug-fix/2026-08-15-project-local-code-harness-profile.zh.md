# Agent Note: 将 Code-as-Harness 治理绑定到项目 Profile

Status: implemented

[English](2026-08-15-project-local-code-harness-profile.md) | 中文

## Problem

Code-as-Harness 从 Session 工作目录派生受治理项目，并让共享执行器发现项目 Profile。受治理 Session 需要仓库自有指令、可执行门禁和精确的治理实现，否则它可能进入 fail-closed 状态机，却没有可准入的完成路径。在仓库上层目录打开的 Session 也不能继承治理，因为该父目录既不对应单一 Git worktree，也没有一套适用规则。

全仓测试命令能够让 Profile 保持确定性，却违反本仓库为待交付差异选择最窄行为证据的策略。反过来，如果 Profile 完全不运行行为测试，类型正确但行为错误的源码变更也可能获得 attestation。

## Decision

DeepSeek-Solar-Harness 自有 `.agent-governance/profile.json`。Profile 用根指令、workspace manifest、lockfile、CLI 入口、产品清单和受管插件注册表识别本仓库。必需指令来源包括根策略、仓库内的 `dsh-code-as-harness` 入口 skill，以及从用户在 Codex 中创建的项目导入到 `plugins/managed/governance` 的权威 skill 和合同。

Quick 验证会检查 Git 空白、解析 Profile JSON，并校验 Solar 产品身份、导入源码来源、许可证、Code-as-Harness 身份和 `DSH-desktop-v<major>.<minor>.<patch>` 标签合同。Full 验证会按需增加根 typecheck、lint、基于 `origin/solar` 的相关 Vitest、文档同步和发布门禁。Desktop 与每个受管组件执行自己的包管理、测试、类型、构建或文档命令，不会被误当成根 package。

Code-as-Harness 实现就是用户创建的 `agent-development-governance` 仓库，该仓库已导入 `plugins/managed/governance`。它自己的导出器把经过 digest 校验的可执行 bundle 安装到 `tools/agent-development-governance`；仓库 skill 只是路由适配器。Cordis 治理插件继续承担 Session 状态机与 attestation 适配。远端 CI 和受保护 `solar` 分支评审仍是独立权威。

## Alternatives considered

**在已安装插件中配置一个绝对外部 Profile 路径。** 拒绝，因为开发仓库将不再拥有自身适用规则，其他 checkout 会继承机器相关路径，而且 Profile 更新可能与它所证明的提交独立漂移。

**对每个 Git worktree 启用治理，再报告 audit 失败。** 拒绝，因为尚未采用 Profile 的普通仓库会被迫进入无法成功的纠正续轮。

**每次源码变更都运行完整 Vitest 套件。** 拒绝，因为仓库 pre-push 策略要求最窄相关证据。`--changed=origin/solar` 包含与待交付分支有关的已提交和工作树变更，组件自有源码则使用自己的原生测试套件。

**使用通用或第三方同名 Code-as-Harness 项目。** 拒绝，因为只有用户在 Codex 中创建的 `agent-development-governance` 项目负责本产品的治理语义与完成证据。

**省略本地行为测试。** 拒绝，因为 typecheck 与 lint 不能证明运行时行为，也不能为源码变更的 attestation 提供充分依据。

## Consequences

DSH 编码 Session 可以发现自身规则、按 digest 校验导出的实现、根据待交付差异选择根命令与组件原生命令，并生成绑定项目的 full attestation。未处于已采用治理的 Git worktree 内的 Session 保持 unmanaged，不再进入无法完成的循环。嵌套工作目录证明仓库根，而非某个 package 子目录。

Full 源码验证依赖已 fetch 的 `origin/solar` 引用；共享文件影响多个包时，相关测试集可能较大。堆叠分支可能包含下层分支的测试，因为稳定基线是受保护的集成分支；这会增加本地耗时，但不会遗漏待交付行为。远端 CI 仍决定能否合并，并可能执行比本地 Profile 更广的检查。
