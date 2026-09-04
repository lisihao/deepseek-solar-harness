# dsh-synapse v0.4.1 保真记录

## 来源锁定

本目录复制自 `https://github.com/liangmianya/dsh-synapse.git` 的 tag `v0.4.1`，其发布 commit 为 `589aed43fece8a38fe9267d47ed9756eab343fec`。复制内容来自该 commit 的完整 Git 发布树，包含上游源码、测试、文档、图片、`LICENSE`、`package.json`、锁文件和 CI 文件；文件树信息见 [SOURCE-LOCK.json](SOURCE-LOCK.json)。

`index.js`、`client.js`、`app.js` 是上游运行时代码的逐字节 faithful copy。下游没有在运行时代码中加入适配层、重写、功能开关或行为修改；本文件和 `SOURCE-LOCK.json` 是额外的下游来源元数据。

## DSH 权威边界

- DSH Session Log 是会话内容、生命周期、消息顺序、分叉和工具事件的唯一权威来源。创建、打开、追问、分叉、归档、模型/工具执行以及权限决定仍由 DSH 原生会话运行时负责。
- Synapse 是 Web presentation/projection layer。它读取 DSH 已提交的 session events，通过 `session/created`、`session/event` 和 Web session snapshots 生成画布卡片；它不会取代 DSH Session Log，也不会把画布卡片反向写回会话日志。
- Synapse 自己的 `$DSH_HOME/synapse/workspaces.json` 只保存画布组织元数据和派生卡片内容。该 JSON 是可丢弃、可重建的 projection/replica，不是会话事实来源；删除或重置它不会删除 DSH conversations。

## JSON 投影与单写者约束

- 投影写入通过 `WorkspaceStore` 的进程内串行 mutation 队列，并用临时文件加 rename 完成一次 JSON 状态替换；事件突发会合并为一次 deferred flush。
- `workspaces.json` 不是 multi-writer database。跨进程只提供锁文件、mtime 变化警告和 stale-lock 处理；两个 `dsh web` 实例仍可能发生 last-writer-wins 覆盖，没有冲突合并或复制协议。
- 因此一个共享 DSH Web profile 只运行一个 `dsh web` writer。需要恢复时从 DSH Session Log 重新投影，而不是把两个 JSON 副本合并成新的会话权威。

## 依赖与明确非依赖

上游运行时只接入既有 Web server/session seams：`index.js` 注入 `webServer` 与 `sessions`，`client.js` 注入 `sessions` 与 `workspaces`，`cordis.patch.yml` 把服务加入 DSH `web` profile。它不启动第二个 HTTP server，不创建第二个 model/agent runtime，不替换认证或权限检查。

本插件没有对 `TaskGraph`、`LLM` 或 `Physical Operator` 的 import、调用或持久化依赖；它不拥有调度、模型请求、provider routing、工具 schema、物理执行或 orchestration 状态。该声明只描述 Synapse 插件边界，不否认宿主 DSH 自身可以提供这些能力。

## 验收定位

本快照的运行时保真验收是对上游 commit 与复制版本的 `sha256` 比对：三份运行时文件必须逐一相同；语法检查和上游 Node test command 必须通过。任何未来运行时修改都必须创建新的来源锁定和保真记录，不得把修改后的代码标记为 faithful。
