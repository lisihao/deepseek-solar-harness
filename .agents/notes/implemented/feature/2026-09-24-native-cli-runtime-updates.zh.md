# Agent Note：按所需协议审查原生 CLI 并由 DSH 更新

状态：已实现

[English](2026-09-24-native-cli-runtime-updates.md) | 中文

## 问题

Resident 资格审查把 Codex 固定为其生成的 app-server schema 的某一个 SHA-256，把 Claude Code 固定为某一个精确版本。Codex schema 摘要每个版本都会变化：`0.149.1`、`0.151.0` 和 `0.156.1` 的摘要各不相同，而 Desktop 实际已在运行摘要与固定值不符的 `0.149.1` daemon。因此精确固定会拒绝所有新版 CLI，无论 DSH 能否使用；DSH 也无法提示存在新版 CLI，更无法安装。

## 决策

当 app-server daemon 实际运行的二进制生成的协议 schema 声明了 Resident wire 发送或处理的每个方法时，Codex 即通过资格审查。`dsh-subagent-codex` 中的 `CODEX_APP_SERVER_METHODS` 列出这些方法，并由测试保证该列表与 `wire.ts` 中的方法字面量一致。Claude Code 需位于基线 `2.1` 发布线且不低于 `2.1.239`，因为编译进来的 Agent SDK 以该发布线为目标。

`ResidentOperatorService` 新增可选的 `cliRuntimes()` 与 `updateCli(product)`。本地 Provider 从可配置的 npm 兼容注册表下载最新平台原生包，校验其 sha512 完整性，并在切换前完成候选版本的资格审查。Claude Code 候选版本会成为 `<dshHome>/runtimes` 下由 DSH 托管的副本，并由 Resident daemon 放在 PATH 最前面的 wrapper 选中；命令在每次调用时解析，因此激活无需重启，系统安装也保持不变。Codex 执行使用 Codex 共享的 app-server daemon，该 daemon 运行 Codex 自己管理的包，因此通过审查的 Codex 候选版本会通过 Codex 自带的 `app-server daemon update` 激活。Resident 面板显示正在运行的版本与最新版本，并向 loopback 所有者提供经验证的更新。

## 备选方案

**每个版本重新固定摘要。** 这能保持精确保证，但每个 Codex 版本都要等 DSH 发版后才能使用，而这正是本次变更要消除的问题。

**运行 DSH 私有的 Codex app-server。** 这样可以把 Codex 版本与属主安装隔离，但需要独立的 daemon、登录状态和传输；共享 daemon 才是 Codex 保存持久 thread 的地方。

**通过 npm 安装。** 两个产品都发布了平台包，其原生二进制无需 Node 即可运行，因此下载一个经校验的 tarball 可避免依赖 Finder 启动的 Desktop 中存在 npm 或 Node。

## 后果

- 删除或重命名所需方法的 Codex 版本会以 `PROVIDER_VERSION_MISMATCH` 被拒绝，更新结果会说明需要等待 DSH 适配。只改变请求字段而不重命名方法的版本仍会通过该门禁，并在运行时失败。
- Codex 更新会中断正在运行的 Codex 任务，并同时更新属主的 Codex standalone 安装。
- 在 SDK 基线调整前，`2.1` 发布线之外的 Claude Code 会被拒绝。
