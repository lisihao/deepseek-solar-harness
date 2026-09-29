# Agent Note: 原生工具权威与目录新鲜度

Status: implemented

[English](2026-09-29-native-tool-authority-and-catalog-freshness.md) | 中文

## 问题

Resident Driver 可能在拥有模型工具描述符的 DSH Session 变化或释放后仍持有密封描述符。如果不重新检查属主就发送原生工作，请求可能到达不同的 Session 或工具集合。本决定补充[一等 DSH 工具权威](2026-09-02-first-class-model-tool-authority.md)决策。

Codex 执行使用属主的共享 app-server daemon，但长期运行的共享 app-server 可能在本地 Codex 模型缓存更新后仍保留陈旧模型目录：观察到共享 daemon 没有报告 `gpt-6.1-sol`，而新的 stdio 进程报告了该模型。因此模型和配额发现需要从通过资格审查的可执行文件获取新鲜数据，同时不能重启活动的共享工作。缓存目录是调度快照，不是实时产品响应。提供方正常完成也不能证明任务已验收。

持久 Codex thread 还必须区分等价的属主重新绑定与已改变的 DSH 工具 schema；目录发生变化时不能静默继续原生历史。

## 决策

原生回合启动前，Driver 会调用属主 `tool.describe`，要求协议版本 1、活动 Session 身份和密封工具的精确名称全部匹配。缺少工具桥会拒绝准入；描述不匹配返回 `PROTOCOL_MISMATCH`；属主不可用返回 `RUNTIME_UNAVAILABLE`。Codex 动态工具描述和原生指令会把每个暴露名称标识为 DSH 所有，并说明调用由 DSH 权限和日志记录管理，包括看似 shell 或文件工具的名称。

Codex 会保存原生工具策略与完整 DSH 工具 schema 的 SHA-256 摘要，并对工具名称和嵌套 schema 键进行规范化排序。桥接端点和绑定 Session 身份被排除，因此属主重新绑定不会改变摘要。持久 Codex thread 的摘要不同，或 `dsh-tools-authoritative` 下的旧 thread 没有摘要，都会以 `PROTOCOL_MISMATCH` 失败并提示调用 `session.reset`；reset 必须显式清除原生 thread 身份和摘要，不会静默创建全新的原生历史。

Codex 回合和压缩继续通过共享属主本地 app-server daemon 使用非临时 thread。资格审查会使用通过资格审查的可执行文件启动新的短生命周期 `--stdio` app-server 进程，读取 `model/list` 和可选 `account/rateLimits/read`，总计 15 秒有界。读取后会关闭该进程；它不能启动 `thread/start` 或 `turn/start`，也不会重启或替换共享 daemon。模型目录是必要数据；配额遥测仍是调度参考，读取失败时保持未知。

State schema v6 新增可空的 `resident_sessions.native_tool_catalog_sha256`；v5 到 v6 的迁移是增量迁移，会保留已有 Session、Receipt、lease、event 和 Artifact。拥有相同规范请求的活动 command 只有在新属主通过 `tool.describe` 后才能重新绑定工具桥；每次新的工具调用都会读取当前描述符，进行中的调用绝不会重试，结果丢失时仍按 indeterminate 处理。`connectTimeoutMs` 会经由 client、daemon 和 Driver 只约束工具桥准入，不会限制原生回合时长。

`completed` 表示提供方回合正常结束。它不是任务验收、任务正确性、完整恢复覆盖或已验证端到端结果的证据。

## 备选方案

- **不重新调用 `tool.describe` 而直接信任密封描述符。** 否决，因为 release 或 rebind 可能让描述符在语法上仍有效，但属主已不再提供相同 Session 和工具名称。
- **通过长期运行的共享 daemon 读取目录。** 否决，因为它可能在本地 Codex 缓存更新后仍保留陈旧目录；目录刷新不能重启或替换活动共享工作，因此使用独立 stdio 子进程读取当前数据并自行关闭。
- **让目录变化后的持久 Codex thread 继续执行。** 否决，因为 DSH 工具 schema 变化会改变原生权威，即使端点可以重新绑定也不能继续；调用方必须先显式 reset，再开始新的原生历史。
- **把缓存目录当作实时数据。** 否决，因为模型可用性和配额可能在状态读取之间变化；缓存继续只是调度快照。
- **把提供方 `completed` 当作任务验收。** 否决，因为提供方生命周期与 DSH 任务验证属于不同权威。

## 后果

准入错误会在原生回合执行前可观察地返回，模型可见工具边界会明确保留 DSH 归属。Codex 执行继续使用属主共享 daemon 和持久 thread 语义，同时目录探测进程独立拥有并清理短生命周期子进程。

本决定不新增完整原生恢复或任务验收保证；调用方必须使用自己的验证证据。现有提供方状态、Receipt 结算和配额参考语义保持不变。
