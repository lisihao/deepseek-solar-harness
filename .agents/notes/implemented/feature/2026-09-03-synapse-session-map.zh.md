# Agent Note：将 Synapse 会话地图作为密封、可卸载的产品插件

Status: implemented

[English](2026-09-03-synapse-session-map.md) | 中文

## 问题

DSH 的 canonical Session Log 保存线性历史和分支事件，但 Desktop 产品此前没有提供空间化视图来浏览相关会话、分支、prompt 和工具活动。上游 `dsh-synapse` 已经以普通 DSH Web 插件实现了这种交互；若在 Desktop 内重新实现，会制造第二套 UI 协议和不必要的 fork。

## 决策

DSH 将上游 `dsh-synapse` v0.4.1 release 纳入为受控、密封且可卸载的产品插件。已接受的源码、MIT 许可证、release commit 和 fidelity 记录位于 `plugins/managed/synapse`；Desktop 安装可复现的本地 archive，其 manifest 会把每个已打包、非生成字节映射回仓库内受跟踪的源码。普通 product-bundle 列表只挂载该插件一次，并同时用于本机 Desktop 和 Product Server composition。DSH Core、Scheduler、TaskGraph、Physical Operator、模型 Provider 和 Agent Loop 的任何 contract 都不依赖 Synapse。

Synapse 始终只是 projection。DSH Session Log 是会话身份、历史和分支的 canonical source。插件私有的 `synapse/workspaces.json` 保存画布布局，以及可视地图使用的有界内容投影；它不是第二个 session authority。移除插件或删除其私有数据，不得删除或改写 DSH session。

首次集成保留已接受的上游 runtime 行为，不会静默替换成 Solar 专用重写。已知上游边界会显式记录：本地 JSON store 使用进程内 advisory lock；原始 workspace path 没有通过 `realpath` canonicalize；插件没有实现多 Server replication，也没有独立 authentication system。这些是明确的后续候选项，不是本 release 已声明的能力。

## 验证

受控源码检查固定上游 release，并执行其原生测试。Desktop package 测试要求唯一的 `synapse` Loader row 和 `dsh-synapse` package。vendored-input gate 证明精确的受跟踪来源；packaged-runtime 和 composition gate 要求 Host entry、Web client entry、stylesheet、application script、patch 与 package manifest 在 Electron 打包后全部存在。安装后验收会核对 Synapse route、client module、可见的会话地图入口、重启持久化，以及既有 Ego Lite 与 ChatGPT Web row 仍保持挂载。

## 曾考虑的替代方案

**在 Desktop 内重新实现画布。** 否决，因为这会 fork 交互模型、把能力耦合到 Electron，并放弃一个已经兼容的 DSH Web 插件。

**为 Synapse 修改 DSH Core 或 Session Log schema。** 否决，因为可视 projection 不需要执行或持久化 authority；这种耦合还会导致插件无法安全卸载。

**跟随上游 `main` 分支。** 否决，因为移动 revision 无法提供可复现的 Desktop 打包；v0.4.1 与已审计 `main` revision 的 runtime 文件相同，并且具有稳定的 release identity。

## 后果

用户获得可视的会话与分支地图，而 DSH 的执行方式和 canonical history 存储不变。插件可在 capability seam 上独立演进或卸载。今后若要 canonicalize workspace、替换私有 store 或增加远程 replication，必须单独冻结 contract 和 migration 决策，不能隐藏在本次导入中。
