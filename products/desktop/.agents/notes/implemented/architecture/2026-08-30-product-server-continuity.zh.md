# Agent Note：Product Server 连续性与远程安装

状态：implemented

[English](2026-08-30-product-server-continuity.md) | 中文

## 问题

Desktop 只能在启动时从多个 Product Server 中做选择。之后 Leader 发生变化就需要重启应用，费用只代表当前 Server，而且 Mac mini 没有一条从固定 GitHub Release 到原子管理 Product Server 的可重复路径。release smoke 停止 Host 后还会遗留其持久化测试 daemon。

## 决策

Frontend 保持轻量：绝不启动本地 Host。Electron 自有 monitor 通过 Remote Sync 定期资格检查完整的已配置 Server 目录。可调度 Leader 变化时，它会释放旧浏览器 generation 与访问 session，再在同一个应用进程挂载新的远端 origin。人工变更部署角色或呈现模式仍保留有序重启边界。

loopback billing bridge 会在明确的逐来源 deadline 内请求每个已配置 Server 的账本，把部分失败保留为显式来源记录，按 ledger 身份去重备用入口（缺失时退回 deployment 身份），聚合唯一 Server totals，并且只加一次未启动的 MacBook 历史基线。`dsh-web-billing` 只消费普通的 `desktopFrontend.sources` 投影，不依赖 Desktop runtime 代码。

macOS Product Server 安装器接收稳定的 `DSH-desktop-vX.Y.Z` 标签与完整 40 位 commit。它在目标 Mac mini 上克隆 GitHub、本机构建并运行 release-shaped smoke，通过 owner IPC 排空 Host 与两个持久 daemon，再原子切换 `current`，将之前的目标保留为 `rollback`，激活 LaunchAgent，并验证 HTTP、Remote Sync 1.4、Resident provider 以及 read/execute/interrupt/materialize/artifact 能力。默认安装会写入单成员 `cluster.json`，其执行准入目录包含 GitHub 发布仓；`--execution-repo` 可选择另一单仓，`--cluster-config` 则安装操作者提供的多 Server 成员与仓库目录。激活失败时会先恢复上一份集群配置，再恢复并复验上一版本。PID signal 只是在 executable 与 instance root 都匹配后的 fenced 崩溃兜底。它不复制 MacBook 产物。

## 验证

Desktop 聚焦测试覆盖 Leader 重绑定、多 Server 费用、Electron redirect 与两处页脚控制面。脚本测试覆盖固定发布参数校验、LaunchAgent 生成、必需 Remote Sync capability 与有界 daemon 静默退出。Desktop typecheck 验证 Electron main/runtime 边界。release-shaped Product Server smoke 仍是集成门禁，并且现在拥有完整清理责任。

## 影响

Leader 变化不再要求重启应用，执行与持久化状态仍由权威 Server 持有。费用仍是各插件账本的估算，但会暴露不可用来源而不是静默忽略。Mac mini 部署变得可重复、可回滚，但只允许从已经发布的固定 Release 执行；本变更不会部署开发工作树。
