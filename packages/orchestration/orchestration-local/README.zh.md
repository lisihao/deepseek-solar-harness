# Local Orchestration

[English](README.md) | 中文

本包通过独立 `dsh-orchestratord` 提供 `ctx.orchestrations`。可释放的 DSH 插件是 Unix socket 客户端；daemon 是唯一 SQLite 写者，并在 DSH 或 Desktop 重启期间继续运行已 accepted 的 TaskGraph。

打包后的 Desktop 使用 `desktop-<SemVer>` 作为本地 daemon build identity。严格握手会拒绝来自其他应用版本的 daemon，要求旧进程关闭，保留其 SQLite 状态与 Artifact，再启动当前已安装版本。源码开发在未显式提供 `DSH_BUILD_COMMIT` 时继续使用 `development` identity。

daemon 承载确定性的 direct Intent 提供方、basic Context 提供方、所有者本地内容寻址 Capsule Registry、配额感知模型分配器、持久 Continuous Harness Provider、Graph 校验器、冲突感知 Scheduler、不可变 ExecutionPlan Compiler，以及派发 Resident Claude Code 或 Codex turn 的私有物理算子 composition。状态位于 `<DSH_HOME>/orchestrations`；socket 仅所有者可用，数据库使用 WAL。

Scheduler 会在 Graph 的 `maxParallel` 上限内启动彼此独立的节点，不设置阶段级 barrier。依赖、重叠的写入/effect scope 和 worker 上限只会串行化受影响节点；每个等待原因都会随 Run 持久化。每次 Attempt 都会获得内置 `context.clean-task` 指令 Capsule 和新的 Resident lane，因此复用的 Codex 或 Claude Code 宿主不会继承旧原生 thread，也不会 fork 父对话历史。

只有节点策略列出了返回的错误码且仍有 Attempt 预算时，自动重试才会创建新 Attempt。Resident 响应流断开会成为可重试的 `RUNTIME_UNAVAILABLE`；原生产品明确报告额度用尽时归类为 `QUOTA_EXHAUSTED`。允许额度重试时，下一个 Attempt 在重新密封前会排除已耗尽的 quota pool（没有 pool 身份时排除精确 offer）。格式错误的结果与不确定 command 绝不会自动重放。正常关闭 daemon 会在报告关闭完成前结束已接受的控制连接，因此被替换的 build 不会存活在拒绝连接的 socket 后面。

Attempt 运行时，daemon 会将有界 Resident 进度阶段复制到编排事件流。结算会把完整算子结果保留在 Evidence 产物中，并向终态事件添加有界的面向用户输出预览。这些投影会展示执行与结果，但不会复制提示词、私有推理、终端屏幕或产品本地 transcript。

## Model Experience

间接产生影响：由 `@deepseek-ai/dsh-tool-orchestration` 呈现。daemon 保存 Compiler 产物并返回有界投影，但自身不增加提示词段落。

#### KV Cache effect

每个 Attempt 接收一个已封存 Context Packet。后续 Graph、胶囊或能力 generation 会产生新数据包，不会修改已经缓存的请求。

## Known Limitations and Deferred Work

- 基础胶囊绑定支持指令和只读 resource/data 引用。Tool、MCP、secret 和可执行 Guard 绑定在提供方实现其强制机制前均会失败关闭。
- Claude Code 与 Codex 只支持派发前和下一轮次注入；即时轮次内 checkpoint 更新返回 `CAPABILITY_HOTSWAP_UNSUPPORTED`。
- RLM 只在一个已封存节点内进行有界递归；它是执行策略，不是另一个产品或全局 Scheduler。
