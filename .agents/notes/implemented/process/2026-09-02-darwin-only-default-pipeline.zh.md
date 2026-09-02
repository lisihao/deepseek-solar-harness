# Agent Note: 仅 Darwin 的产品与默认流水线

Status: implemented

[English](2026-09-02-darwin-only-default-pipeline.md) | 中文

## Problem

受支持产品收缩为 macOS 后，DSH 仍保留 Windows 与 PowerShell 兼容包。普通工作区安装、构建、类型检查、lint、测试、覆盖率、hygiene、CI、发布与 Desktop 验证仍会纳入这些包和若干仅 Win32 的源码及测试文件。这些工作消耗开发者与托管 runner 时间，引入产品从不加载的原生依赖，还可能让不受支持的平台阻断 Darwin 交付。

## Decision

受支持的 DSH 产品及其默认开发流水线仅面向 Darwin。拉取请求 CI、发布包族、Desktop 打包、工作区安装、TypeScript 项目、Oxlint、Vitest 覆盖率与 Knip 均排除四个 Windows/PowerShell 包及其仅 Win32 的配套文件。仓库内活跃的文件系统与 JSONL 持久化包不再导入或依赖基于 Koffi 的 Win32 发布辅助实现。Desktop 可以保留上游 lockfile 继承的平台条件记录，但不会运行 Koffi 的构建脚本，也不会选择 Windows 产物、runner 或验证通道。只要不会选择 Windows 包、产物、runner 或验证通道，通用 Node 回退逻辑可以保留。

兼容实现作为休眠源码保留，用于上游对照与显式诊断。它不是工作区成员、发布成员、受支持工具 schema、产品依赖或普通验证输入。未来若重新启用 Windows 支持，必须先作出明确产品决策，并恢复其依赖、构建、测试、CI、发布和打包闭包，之后才能声明支持。

## Alternatives considered

**删除全部兼容源码。** 不采用，因为隔离保留源码有利于未来进行上游对照；只要移除所有活跃引用，它就不会增加默认流水线成本。

**只跳过 GitHub 作业，但让 Windows 包继续进入普通验证。** 不采用，因为本地安装、lint、类型检查、测试、覆盖率、hygiene、发布和 Desktop 组装仍会在不受支持的产品面上耗时，也仍可能阻断交付。

## Consequences

DSH 不声明提供 Windows 产物或支持。仓库构建与验证不再解析、编译、测试、打包或发布休眠的 Windows/PowerShell 实现，Desktop 也不会构建或验证它。休眠源码与第三方 lockfile 记录可能漂移；这是不受支持兼容材料的已接受属性。未来若重新引入，必须恢复完整的平台证据，不能把源码或 lockfile 记录存在等同于支持。
