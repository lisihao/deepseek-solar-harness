# Agent Note: 将 Code-as-Harness 治理绑定到项目 Profile

Status: implemented

[English](2026-08-15-project-local-code-harness-profile.md) | 中文

## Problem

已安装的 Code-as-Harness 插件从 Session 工作目录派生受治理项目，并让共享执行器发现项目 Profile。DeepSeek-Solar-Harness 没有 `.agent-governance/profile.json`，因此在该仓库中打开的 Session 会进入 fail-closed 状态机，却无法通过第一次 audit。旧版插件还可能把在仓库上层目录打开的 Session 错标为受治理，即使该父目录既不对应单一 Git worktree，也没有一套适用规则。

全仓测试命令能够让 Profile 保持确定性，却违反本仓库为待交付差异选择最窄行为证据的策略。反过来，如果 Profile 完全不运行行为测试，类型正确但行为错误的源码变更也可能获得 attestation。

## Decision

DeepSeek-Solar-Harness 自有 `.agent-governance/profile.json`。Profile 用根指令、workspace manifest、lockfile 与 CLI 入口识别本仓库；把根指令、贡献指南、测试策略和 pre-push skill 记录为必需指令来源；并将源码、文档、工具、发布和治理路径映射到仓库原生命令。

Quick 验证运行 Git 空白检查并解析 Profile JSON。Full 验证为源码、工具或发布变更增加仓库 typecheck 与 lint，然后用 `--changed=origin/master` 运行 Vitest，使行为覆盖跟随完整待交付分支差异，而不是默认执行所有测试。文档与治理变更运行 `doc-sync`；发布变更还会运行 build 与包 hygiene 命令。

外部 Cordis 插件仍然是状态机与 attestation 适配器。它把嵌套 Session 工作目录锚定到最近的 Git 根，并且只在该根包含项目 Profile 或部署显式提供 Profile 时启用。远端 CI 与分支保护仍是独立权威。

## Alternatives considered

**在已安装插件中配置一个绝对外部 Profile 路径。** 拒绝，因为开发仓库将不再拥有自身适用规则，其他 checkout 会继承机器相关路径，而且 Profile 更新可能与它所证明的提交独立漂移。

**对每个 Git worktree 启用治理，再报告 audit 失败。** 拒绝，因为尚未采用 Profile 的普通仓库会被迫进入无法成功的纠正续轮。

**每次源码变更都运行完整 Vitest 套件。** 拒绝，因为仓库 pre-push 策略要求最窄相关证据。`--changed=origin/master` 包含与待交付分支有关的已提交和工作树变更，同时把穷尽式平台覆盖留给 CI。

**省略本地行为测试。** 拒绝，因为 typecheck 与 lint 不能证明运行时行为，也不能为源码变更的 attestation 提供充分依据。

## Consequences

DSH 编码 Session 可以发现自身规则并生成绑定项目的 full attestation。未处于已采用治理的 Git worktree 内的 Session 保持 unmanaged，不再进入无法完成的循环。嵌套工作目录证明仓库根，而非某个 package 子目录。

Full 源码验证依赖已 fetch 的 `origin/master` 引用；共享文件影响多个包时，相关测试集可能较大。堆叠分支可能包含下层分支的测试，因为稳定基线是受保护的默认分支；这会增加本地耗时，但不会遗漏待交付行为。远端 CI 仍决定能否合并，并可能执行比本地 Profile 更广的检查。
