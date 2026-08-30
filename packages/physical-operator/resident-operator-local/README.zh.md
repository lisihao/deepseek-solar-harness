# @deepseek-ai/dsh-resident-operator-local

[English](README.md) | 中文

`ctx.residentOperators` 的本地 Service Provider 与独立 daemon。DSH 插件只是可释放的 Unix socket 客户端；`dsh-resident-operatord` 是唯一 SQLite 写者，并跨 DSH/HMR 释放继续存在。它负责 command receipt、单 Session lease、state revision、有界结构化事件及大结果的内容寻址 Artifact。

Claude Code 使用官方 Agent SDK 持久化与恢复 Session，并通过不提交 prompt 的 SDK 控制通道读取订阅可见模型。资格审查会解析一个绝对路径的用户自有 `claude` 可执行文件，SDK 模型发现与真实回合也使用同一个文件，而不是 SDK 自带的后备程序；因此版本、钥匙串刷新行为、TLS 信任和订阅状态不会在资格与执行路径之间分叉。Codex 通过固定版本 app-server daemon 的本机属主 Unix WebSocket 控制 socket 使用非临时 thread，并通过 `model/list` 读取目录；CLI `proxy` 只是 WebSocket 原始字节桥，不是 NDJSON transport。两个 Driver 都会在本机 CLI 无法证明原生订阅登录时默认拒绝，且不支持 API-key fallback。

## 协议、存储与恢复

JSON-RPC 2.0 通过仅属主可访问的 Unix socket 以 NDJSON 传输。握手会拒绝 Resident 协议、state schema、daemon build、必需方法集、已配置 Driver manifest、产品版本、产品协议 hash 或原生订阅资格不一致。协议 v11 会在 turn 准入时密封 `native_tool_policy`：`disabled` 会移除 Claude Code 的 Agent SDK 工具表面，向 Codex 提供明确的禁用工具指令，并在产品仍请求原生工具时继续默认拒绝。该策略不能与模型工具桥同时使用。协议 v10 新增 `operator.authenticate`：它只能由所有者显式触发，并会把并发请求合并到同一个产品登录进程；轮询、启动、资格探测和产品失败绝不会自动弹出登录。Claude 登录失败会报告 `AUTH_REQUIRED`、`NETWORK_UNAVAILABLE` 或 `CALLBACK_LISTENER_MISSING`；daemon 不保留重试计时器，只有所有者再次显式操作才会创建新 attempt。daemon 调用资格审查实际解析到的同一个 Claude 可执行文件，token 仍只由 Claude Code 与系统凭据存储持有。协议 v9 在密封的通用模型工具桥旁携带 DSH 组装系统提示；v8 新增基于 Receipt 的 `session.compact`；v7 首次为 RLM turn 引入该工具桥；v6 新增通用 Driver SPI 与优雅 `system.shutdown`。配置新的 Driver 集合时，客户端会先退出不兼容的旧 daemon 再重连。daemon 在单写 WAL 数据库中保存 `resident_sessions`、turn `command_receipts`、`session_compaction_receipts`、`session_leases`、有界事件及 Artifact 索引。

原生压缩只会在 Session 为 idle 且调用方 state revision 完全一致时准入。Claude Code 恢复同一个 Agent SDK Session，发送原生 `/compact`，并可携带指导语；Codex 恢复同一个非临时 app-server thread 后调用 `thread/compact/start`，由于该方法没有 instructions 字段，Codex 会明确拒绝非空指导语。daemon 会在调用产品前写入 accepted Receipt；相同已结算命令返回缓存结果，内容变化时报冲突，accepted/running 阶段崩溃或传输终态不明时进入 `COMMAND_INDETERMINATE`。再次压缩前必须显式处置，daemon 绝不会自动重放外部产品副作用。持久 Receipt 与事件只记录 canonical request hash 及是否提供指导语，不保存指导语正文。

工具桥既可以密封忠实 RLM 专用的 `typescript_repl` 表面，也可以密封当前 Agent 面向模型的完整 DSH 工具目录。Claude Code 通过进程内 Agent SDK MCP server 接收；Codex 通过 app-server 的 `thread/start.dynamicTools` 与 `item/tool/call` 接收。通用调用回到拥有该会话的 DSH Host，经普通 Tool Runtime 执行，因此保留 scope、guard、approval、事件日志和插件归属。每个原生调用身份以外层 Resident command 划分命名空间；Host 在 DSH Session 中保存 request-hash Receipt，因此产品重连后重复同一调用会返回同一结果，而不会再次产生副作用。调用方提供的 lane 会把 RLM 原生 thread 与普通 Resident 对话隔离；后续 Codex turn 会恢复创建时已经固定动态工具表面的 thread。

Codex 模型发现是执行前提，订阅配额遥测只用于调度参考。临时的限额遥测故障会保留已通过资格审查的模型目录和执行路径，暴露 `quotaUnavailableReason`，并把配额池标为未知，而不是误报整个原生订阅不可用。

Codex 响应流的传输故障（包括 responses 请求断开）会报告为 `RUNTIME_UNAVAILABLE`；Claude Code 或 Codex 明确报告订阅额度用尽时会归类为 `QUOTA_EXHAUSTED`；格式错误的终态输出仍报告为 `INVALID_RESULT`。编排调用方只能重试节点策略明确准入的错误码。

Receipt 按 `accepted -> running -> settled` 推进；有界 `turn.progress` 阶段会暴露连接、原生 Session 就绪、推理/工具活动与结果整理进度，但不保存 prompt 或 transcript。协议 v5 在 Receipt 与 accepted 事件中携带必需的调用方 lane 以及清理后的 160 字符展示任务摘要，并让 `session.list` 无需原生产品资格探测即可读取持久状态。状态迁移按列名复制历史记录，因此早期 `ALTER TABLE` 形成的列顺序不会在重建表时错置 Receipt 字段。同一算子的并发资格探测请求共享一个进行中的探测；Claude Code 按顺序检查版本、订阅状态和模型目录。准入前，daemon 会根据实时产品目录校验显式模型/强度，补全 Smart Auto 字段，并把有效 profile 锁定到算子/工作区/lane Session。手动指定强度但让模型自动选择时，候选范围只包含明确支持该强度的模型；若不存在兼容模型，准入会明确失败，而不是选出不兼容组合。后续 profile 变化在 reset 前都会失败。重新连接的 DSH 或 Desktop 客户端可以从 daemon 权威状态检查该 profile、lane、活动 turn、最新阶段及已结算结果。daemon 在无法证明结算前崩溃时，启动恢复会将 Receipt 标为 `indeterminate`。相同 command 与 canonical hash 重放会返回同一 Receipt，内容或 profile 变化则冲突。重试只能在显式处置后用新 command ID 准入，并唯一关联旧 Receipt。正常停止会排空已准入 turn，并在报告关闭完成前结束所有已接受的控制连接；进程被强制终止时由启动恢复处理，绝不自动重放。

命令准入后，调用方取消和客户端 dispose 只会分离本地轮询句柄，不会发送 `turn.interrupt`。因此 daemon 权威的原生 turn 能跨 DSH、HMR 或 Desktop 重启继续运行。可信调用方若确实要停止产品工作，必须使用显式 interrupt 方法。

## 配置与安全

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `dshHome` | 解析后的 DSH home | `resident-operators/` 的父目录。 |
| `autoStart` | `true` | 无兼容 socket 时启动独立本地 daemon。 |
| `connectTimeoutMs` | `5000` | 有界连接与启动等待。 |
| `pollIntervalMs` | `250` | turn 结算轮询间隔。 |
| `driverModules` | `[]` | 由 detached daemon 加载的独立产品 Driver 包。 |

根目录权限为 `0700`，socket、lock、pid、SQLite 文件与 Artifact 为 `0600`。系统不保存原始 prompt 或终端屏幕；Receipt 只保存 canonical hash，持久化错误会脱敏 prompt 与疑似凭据。产品子进程使用共享的凭据清理环境，产品原生权限和 approval 策略仍是权威，两个 Driver 都不会回退到 API key。

当宿主是已启用 RunAsNode fuse 的 Electron 应用时，客户端只向 detached daemon 的 bootstrap 子进程加入 `ELECTRON_RUN_AS_NODE=1`。daemon 会在资格审查或启动 Claude Code、Codex 前移除该标记，因此产品进程不会继承 Electron 启动模式；普通 Node 宿主也会清除意外继承的旧标记。

## Model Experience

Indirectly, through the dual-mode physical-operator provider and `physical_operator` tool. The daemon stores no raw prompt or terminal screen; a large final result becomes a SHA-256 artifact reference.

#### KV Cache effect

No direct invalidation; the model-visible physical-operator Consumer owns its schema.

## Known Limitations and Deferred Work

- 协议 v11 与 state schema v5 只支持本地 Unix socket，schema v1 至 v3 会迁移到兼容 `legacy` lane，schema v4 会新增压缩 Receipt 表，正式验收平台为 macOS；Windows named pipe 后置。
- 产品原生权限策略仍是权威；DSH 文件沙箱不会自动限制外部产品。
- 人工写接管、durable Jobs 投影、远程算子池与亲和调度均不在首发范围。DSH Session 会为 Trace 保留模型可见最终答案及桥接工具调用/结果，但绝不保存产品私有推理或原始终端 transcript。
