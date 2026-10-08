# @deepseek-ai/dsh-resident-operator-local

[English](README.md) | 中文

`ctx.residentOperators` 的本地 Service Provider 与独立 daemon。DSH 插件只是可释放的 Unix socket 客户端；`dsh-resident-operatord` 是唯一 SQLite 写者，并跨 DSH/HMR 释放继续存在。它负责 command receipt、单 Session lease、state revision、有界结构化事件及大结果的内容寻址 Artifact。

Claude Code 使用官方 Agent SDK 持久化与恢复 Session，并通过不提交 prompt 的 SDK 控制通道读取订阅可见模型。资格审查会解析一个绝对路径的用户自有 `claude` 可执行文件，SDK 模型发现与真实回合也使用同一个文件，而不是 SDK 自带的后备程序；因此版本、钥匙串刷新行为、TLS 信任和订阅状态不会在资格与执行路径之间分叉。普通 `providers()` 读取会复用各 Driver 的已缓存模型目录；`providers({ refreshModels: true })` 会把 `operator.list` 的显式刷新意图转发出去，让 Claude 重新枚举 `supportedModels`；并发的强制刷新会合并，普通与强制资格读取都不会启动模型回合或登录。普通原生 Codex 执行通过 Codex 共享的 app-server daemon，经过其属主本地 Unix WebSocket 控制 socket 使用非临时 thread。资格审查会使用通过资格审查的可执行文件，通过 `model/list` 与 `account/rateLimits/read` 在全新的短生命周期 stdio app-server 子进程中读取模型目录和可选订阅配额遥测，并受 15 秒上限约束；该子进程每次读取后都会关闭，不会启动 `thread/start` 或 `turn/start`，也不会重启共享 daemon。CLI `proxy` 只是 WebSocket 原始字节桥，不是 NDJSON transport。两个 Driver 都会在本机 CLI 无法证明原生订阅登录时默认拒绝，且不支持 API-key fallback。资格审查会将缺少可执行文件或超时报为 `RUNTIME_UNAVAILABLE`，将格式错误或不支持的状态输出以及产品命令失败报为 `INVALID_RESULT`，将登出或非原生订阅报为 `AUTH_MODE_MISMATCH`，并将已报告的配额耗尽报为 `QUOTA_EXHAUSTED`；Claude 的 `auth status --json` 可能在有效的 `loggedIn: false` 文档上以 1 退出，Resident probe 会将该文档解析为 `AUTH_MODE_MISMATCH`，而被 kill、收到 signal、超时、格式错误及其他非零响应仍会失败；daemon 会在每个不可用提供方的 status 中返回该代码，并用它拒绝执行。Claude Code 需位于基线 `2.1` 发布线且不低于 `2.1.239` 才通过资格审查。Codex 需由 daemon 实际运行的二进制生成的协议 schema 声明 Driver 发送或处理的每个 app-server 方法（`dsh-subagent-codex` 中的 `CODEX_APP_SERVER_METHODS`）；缺少任一方法即为 `PROVIDER_VERSION_MISMATCH`，此时资格审查会跳过模型目录，不与不兼容的服务端通信。

## Direct Codex model execution

带生成限制且禁用工具的 Codex 判断／聊天请求直接使用订阅 Responses API，不暴露工具，不创建原生 Session 或伪造原生 session id。有效模型在执行前通过实际已核验目录解析。认证只在 `CODEX_HOME` 是绝对账号目录时读取 `$CODEX_HOME/auth.json`，否则读取 `~/.codex/auth.json`；要求既有 `chatgpt` 认证与未过期 access token。该路径不进行更广的凭据发现、登录、刷新、原生配置或宿主 skill（技能）加载、CLI 执行或 MCP 加载。登录过期以 `AUTH_EXPIRED` 失败。普通原生执行保留现有 guard 和 app-server 路径。

旧 `disabled` 请求未暴露工具且未指定 `generationLimits` 时，生成使用 `provider-default`；系统不会为它编造 token 或字节预算。既有且仅含 `typescript_repl` 的封存桥也通过直接 Codex API 工具循环保持兼容：暴露的工具定义必须与封存目录匹配，调用其 call-only 端点时不发送 `tool.describe`。这一有限的旧桥可以沿用提供方默认值；其他启用工具的请求必须有显式限制。新狗窝请求始终提供显式预算，文件工作使用受治理文件策略。

提供 `governedWorkspacePolicy` 时，直接 Codex 循环只暴露 `workspace_files`：范围内的列出、读取、搜索、写入和删除。它拒绝符号链接遍历与禁止路径，不提供命令或网络工具。模型输入与 SDK 输出、确切工具参数及已结算工具结果保存在私有且经 fsync 的记录中；这些记录不是无损原始 wire 捕获。未知文件 effect 或 effect 后持久化失败会成为 `COMMAND_INDETERMINATE`，不重放。整个循环限制输出字节、报告 token 用量和工具调用数。当前 Codex SDK 不向后端发送硬输出 token 上限；这些是观察限制，不保证限制后端 token 消耗。

## 协议、存储与恢复

JSON-RPC 2.0 通过仅属主可访问的 Unix socket 以 NDJSON 传输。协议 v14 要求每个业务请求先在同一连接完成兼容握手，返回 daemon 实例身份，并拒绝未经资格确认的连接。握手会检查 Resident 协议、state schema、daemon build、必需方法集及已配置 Driver manifest，但不会探测原生产品；产品版本、协议 hash 和订阅资格由 `operator.list` 负责。协议 v14 会校验可选的 `native_context` 是否为密封算子上下文摘要，并将其纳入规范命令 hash，因此旧 daemon 不能静默接受带上下文的重放。协议 v12 新增 `dsh-tools-authoritative`：在该策略下，原生回合启动前 Driver 才会调用属主 `tool.describe`，验证活动 Session 以及密封工具的精确名称。缺少工具桥会拒绝准入；描述不匹配返回 `PROTOCOL_MISMATCH`；属主不可用返回 `RUNTIME_UNAVAILABLE`。Claude Code 只接收桥接的 DSH MCP 工具；Codex 接收动态 DSH 工具，其描述会明确标出 DSH 归属以及 DSH 权限与日志记录，另有空的原生 environment 列表、只读 sandbox、禁止审批升级的策略、明确的权限指令，并自动拒绝意外的产品原生审批请求。Codex app-server 0.151.0 尚不能从展示面移除每个内置只读 utility，因此 DSH 只承诺工具桥是唯一执行与工作区修改权威，不会声称所有原生 utility 都已隐藏。协议 v11 首次在 turn 准入时密封 `native_tool_policy`；`disabled` 会移除 Claude Code 的 Agent SDK 工具表面，向 Codex 提供明确的禁用工具指令，并在产品仍请求原生工具时继续默认拒绝，且只允许包含单一 `typescript_repl` 工具的模型工具桥；其他工具或扩展后的工具桥都会被拒绝。协议 v10 新增 `operator.authenticate`：它只能由所有者显式触发，并会把并发请求合并到同一个产品登录进程；轮询、启动、资格探测和产品失败绝不会自动弹出登录。Claude 登录失败会报告 `AUTH_REQUIRED`、`NETWORK_UNAVAILABLE` 或 `CALLBACK_LISTENER_MISSING`；daemon 不保留重试计时器，只有所有者再次显式操作才会创建新 attempt。daemon 调用资格审查实际解析到的同一个 Claude 可执行文件，token 仍只由 Claude Code 与系统凭据存储持有。协议 v9 在密封的通用模型工具桥旁携带 DSH 组装系统提示；v8 新增基于 Receipt 的 `session.compact`；v7 首次为 RLM turn 引入该工具桥；v6 新增通用 Driver SPI 与优雅 `system.shutdown`。每个请求都会在派发前重新检查 socket。升级退休操作会绑定失败握手所观察到的 daemon 实例与进程身份。同一 root 的客户端会在进程内合并恢复，独立 daemon 进程则在 socket 启动前通过事务型 SQLite 权威声明串行化；并发客户端因此不能误杀替代进程，也不能夺取正在启动的 daemon。daemon 在单写 WAL 数据库中保存 `resident_sessions`、turn `command_receipts`、`session_compaction_receipts`、`session_leases`、有界事件及 Artifact 索引。Codex 原生工具目录摘要覆盖原生工具策略以及每个 DSH 工具的名称、描述和递归规范化键的输入 schema，并按工具名称排序；桥接端点与绑定 Session 身份被排除，因此属主重新绑定不会改变摘要。恢复带有不同摘要的 Codex thread，或在 `dsh-tools-authoritative` 下恢复没有摘要的旧 thread，会以 `PROTOCOL_MISMATCH` 失败，并提示调用 `session.reset`；reset 必须显式清除原生 thread 身份和摘要，不会静默创建全新的历史。

业务请求继续使用严格的协议 v14/state schema v6 握手。初次握手返回完整 peer 响应时，退休会复用已观测的 peer 身份。相邻的 schema5 peer 若对初次 schema6 握手不返回响应，退休才会进行一次范围受限的兼容性探测，并且只会在 peer 身份和 PID 与 authority 记录匹配后发送 shutdown。无法确认或不匹配的 peer 都返回 `PROTOCOL_MISMATCH`；shutdown 仍会优雅排空，不会 kill PID 或丢弃活动工作。

必需方法集包含 `command.inspect`，协议仍为 v14，state schema 仍为 v6。检查无需原生产品资格审查或执行，直接读取命令回执。缺少该能力的 v14/schema6 daemon 会以 `PROTOCOL_MISMATCH` 拒绝握手；此情况不会扩大自动退休规则。在已授权的 MacBook 安装中替换它，要求先明确识别由属主控制的 idle daemon，再重启。既有的已观测 peer 退休检查和相邻 v14/schema5 兼容方法集保持不变。

原生压缩只会在 Session 为 idle 且调用方 state revision 完全一致时准入。Claude Code 恢复同一个 Agent SDK Session，发送原生 `/compact`，并可携带指导语；Codex 恢复同一个非临时 app-server thread 后调用 `thread/compact/start`，由于该方法没有 instructions 字段，Codex 会明确拒绝非空指导语。daemon 会在调用产品前写入 accepted Receipt；相同已结算命令返回缓存结果，内容变化时报冲突，accepted/running 阶段崩溃或传输终态不明时进入 `COMMAND_INDETERMINATE`。再次压缩前必须显式处置，daemon 绝不会自动重放外部产品副作用。持久 Receipt 与事件只记录 canonical request hash 及是否提供指导语，不保存指导语正文。

原生产品工具桥执行时，工具桥既可以密封忠实 RLM 专用的 `typescript_repl` 表面，也可以密封当前 Agent 面向模型的完整 DSH 工具目录。RLM 专用工具桥可以使用 `disabled`；`inherit` 与 `dsh-tools-authoritative` 保留各自的通用工具桥规则。Claude Code 通过进程内 Agent SDK MCP server 接收；Codex 通过 app-server 的 `thread/start.dynamicTools` 与 `item/tool/call` 接收。通用调用回到拥有该会话的 DSH Host，经普通 Tool Runtime 执行，因此保留 scope、guard、approval、事件日志和插件归属。每个原生调用身份以外层 Resident command 划分命名空间；Host 在 DSH Session 中保存 request-hash Receipt，因此产品重连后重复同一调用会返回同一结果，而不会再次产生副作用。调用方提供的 lane 会把 RLM 原生 thread 与普通 Resident 对话隔离；后续 Codex turn 会恢复创建时已经固定动态工具表面的 thread。拥有相同规范请求的活动 command 可以刷新工具桥端点；只有 `dsh-tools-authoritative` 需要先由新属主通过 `tool.describe`，而 `inherit` 与 `disabled` 保留无需 `tool.describe` 的仅调用工具桥兼容性。每次新的工具调用都会读取当前端点，进行中的调用绝不会重试，结果丢失时仍按 indeterminate 处理。

Codex 模型发现是执行前提，订阅配额遥测只用于调度参考。临时的限额遥测故障会保留已通过资格审查的模型目录和执行路径，暴露 `quotaUnavailableReason`，并把配额池标为未知，而不是误报整个原生订阅不可用。

Codex 响应流的传输故障（包括 responses 请求断开）会报告为 `RUNTIME_UNAVAILABLE`；Claude Code 或 Codex 明确报告订阅额度用尽时会归类为 `QUOTA_EXHAUSTED`；格式错误的终态输出仍报告为 `INVALID_RESULT`。编排调用方只能重试节点策略明确准入的错误码。

Receipt 按 `accepted -> running -> settled` 推进。`completed` 表示提供方正常结束原生回合，不表示 DSH 已验证任务验收或任务正确性。有界 `turn.progress` 阶段会暴露连接、原生 Session 就绪、推理/工具活动与结果整理进度，但不保存 prompt 或 transcript。Driver 还会追加可由 cursor 续读的 `turn.observation` event，用于公开模型文本、工具生命周期、审批请求和用量更新。每条 observation 都由 daemon 分配 sequence、time、command id 与 turn id；preview 有界，凭据形态的值会被清洗。thinking、原始 prompt、system prompt、工具参数/结果、stderr、环境、凭据和完整原生 transcript 都不会成为 observation 输入。协议 v5 在 Receipt 与 accepted 事件中携带必需的调用方 lane 以及清理后的 160 字符展示任务摘要，并让 `session.list` 无需原生产品资格探测即可读取持久状态。状态迁移按列名复制历史记录，因此早期 `ALTER TABLE` 形成的列顺序不会在重建表时错置 Receipt 字段。同一算子的并发资格探测请求共享一个进行中的探测；Claude Code 按顺序检查版本、订阅状态和模型目录。准入前，daemon 会根据实时产品目录校验显式模型/强度，补全 Smart Auto 字段，并把有效 profile 锁定到算子/工作区/lane Session。手动指定强度但让模型自动选择时，候选范围只包含明确支持该强度的模型；若不存在兼容模型，准入会明确失败，而不是选出不兼容组合。后续 profile 变化在 reset 前都会失败。重新连接的 DSH 或 Desktop 客户端可以从 daemon 权威状态检查该 profile、lane、活动 turn、最新阶段及已结算结果。daemon 在无法证明结算前崩溃时，启动恢复会将 Receipt 标为 `indeterminate`。相同 command 与 canonical hash 重放会返回同一 Receipt，内容或 profile 变化则冲突。重试只能在显式处置后用新 command ID 准入，并唯一关联旧 Receipt。正常停止会排空已准入 turn，并在报告关闭完成前结束所有已接受的控制连接；进程被强制终止时由启动恢复处理，绝不自动重放。

调用 Driver 前，新轮次准入会在同一原子操作中，将完整的规范已解析输入私有记录为 `turn.accepted` 事件中的 `inputSnapshot`：工作区、提示词、可选系统提示词与原生上下文，以及原生工具策略。相同 command/hash 的重放既不替换该快照，也不追加准入记录；hash 不同则冲突。公开的 `readEvents` 与 `latestEvent` 投影会移除该快照。不含该字段的旧 accepted 事件仍可读取，但不保证能重建输入。此记录使用现有事件存储，不修改 schema、表或协议版本。决策见[输入保留](../../../.agents/notes/implemented/bug-fix/2026-10-04-remote-native-workspace-context.md)。

命令准入后，调用方取消和客户端 dispose 只会分离本地轮询句柄，不会发送 `turn.interrupt`。因此 daemon 权威的原生 turn 能跨 DSH、HMR 或 Desktop 重启继续运行。可信调用方若确实要停止产品工作，必须使用显式 interrupt 方法。

## 原生 CLI 运行时

`cliRuntimes()` 报告每个产品正在运行的版本以及注册表中的最新版本。`updateCli(product)` 从 `cliRegistryUrl` 下载最新的平台原生包，校验注册表给出的 sha512 完整性，并在切换前完成候选版本的资格审查；不兼容的候选版本会被丢弃，正在运行的 CLI 保持不变。通过审查的 Claude Code 候选版本会解压到 `<dshHome>/runtimes/claude-code/<version>`，并通过原子重写 `<dshHome>/runtimes/bin/claude` wrapper 激活。daemon 会把该目录放在 PATH 最前面，并在每次调用时解析产品命令，因此下一次资格审查或回合即使用新副本，无需重启 DSH，系统中的 `claude` 安装也不会被改动。Codex 执行经过 Codex 共享的 app-server daemon，该 daemon 运行 Codex 自己管理的包；因此通过审查的 Codex 候选版本会先运行其自带的 `app-server daemon update`。standalone 安装会报告该命令不受支持，此时通过该安装自身的 `codex update` 更新其运行的包；是否成功取决于 daemon 报告的包版本，而不是退出状态。随后 app-server 会重启到新包。不是由 `codex app-server daemon` 启动的 app-server 无法自动重启，更新会报告需先结束该进程，DSH 才会启动新版本。该更新会中断正在运行的 Codex 任务，并同时更新属主的 Codex standalone 安装。同一产品的并发更新共享一次尝试。

## 配置与安全

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `dshHome` | 解析后的 DSH home | `resident-operators/` 的父目录。 |
| `autoStart` | `true` | 无兼容 socket 时启动独立本地 daemon。 |
| `connectTimeoutMs` | `5000` | 有界 socket 连接、daemon 启动和模型工具桥准入等待。 |
| `pollIntervalMs` | `250` | turn 结算轮询间隔。 |
| `driverModules` | `[]` | 由 detached daemon 加载的独立产品 Driver 包。 |
| `cliRegistryUrl` | `https://registry.npmjs.org` | 发布原生 Claude Code 与 Codex CLI 的 npm 兼容注册表。 |
| `cliDownloadTimeoutMs` | `600000` | 每次 CLI 注册表请求、包下载和 Codex daemon 更新的时间上限。 |

根目录权限为 `0700`，socket、lock、pid、SQLite 文件与 Artifact 为 `0600`。已解析的轮次输入只保存在私有 accepted 事件快照中；系统不保存终端屏幕或产品私有推理。Receipt 保存 canonical hash，公开进展不含该快照，持久化错误会脱敏 prompt 与疑似凭据。产品子进程使用共享的凭据清理环境，产品原生权限和 approval 策略仍是权威，两个 Driver 都不会回退到 API key。`connectTimeoutMs` 还会从 client 经 daemon 到 Driver 约束工具桥准入；它不会限制原生回合的时长。

当宿主是已启用 RunAsNode fuse 的 Electron 应用时，客户端只向 detached daemon 的 bootstrap 子进程加入 `ELECTRON_RUN_AS_NODE=1`。daemon 会在资格审查或启动 Claude Code、Codex 前移除该标记，因此产品进程不会继承 Electron 启动模式；普通 Node 宿主也会清除意外继承的旧标记。

## Model Experience

通过双模式 physical-operator 提供方与 `physical_operator` 工具间接影响模型。私有输入保留遵循上述准入规则；大型最终结果会成为 SHA-256 产物引用。

#### KV Cache effect

No direct invalidation; the model-visible physical-operator Consumer owns its schema.

## Known Limitations and Deferred Work

- 协议 v14 与 state schema v6 只支持本地 Unix socket，schema v1 至 v3 会迁移到兼容 `legacy` lane，schema v4 会新增压缩 Receipt 表，schema v6 会通过 v5 到 v6 的增量迁移新增可空的 `resident_sessions.native_tool_catalog_sha256`，并保留已有 Session、Receipt、lease、event 和 Artifact；正式验收平台为 macOS，Windows named pipe 后置。
- 只有相邻的 schema5 到 schema6 升级会使用直接兼容性探测；其他退休路径必须有完整的已观测 peer 身份，无法确认时会安全失败。
- 产品原生权限策略仍是权威；DSH 文件沙箱不会自动限制外部产品。
- 人工写接管、durable Jobs 投影、远程算子池与亲和调度均不在首发范围。DSH Session 会为 Trace 保留模型可见最终答案及桥接工具调用/结果，但绝不保存产品私有推理或原始终端 transcript。
