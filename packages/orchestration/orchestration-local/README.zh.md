# Local Orchestration

[English](README.md) | 中文

本包通过独立 `dsh-orchestratord` 提供 `ctx.orchestrations`。可释放的 DSH 插件是 Unix socket 客户端；daemon 是唯一 SQLite 写者，并在 DSH 或 Desktop 重启期间继续运行已 accepted 的 TaskGraph。

打包后的 Desktop 使用 `desktop-<SemVer>` 作为本地 daemon build identity。严格握手会拒绝来自其他应用版本的 daemon，要求旧进程关闭，保留其 SQLite 状态与 Artifact，再启动当前已安装版本。源码开发在未显式提供 `DSH_BUILD_COMMIT` 时继续使用 `development` identity。

daemon 承载确定性的 direct Intent 提供方、basic Context 提供方、所有者本地内容寻址 Capsule Registry、配额感知模型分配器、持久 Continuous Harness Provider、Graph 校验器、冲突感知 Scheduler、不可变 ExecutionPlan Compiler，以及派发 Resident Claude Code 或 Codex turn 的私有物理算子 composition。状态位于 `<DSH_HOME>/orchestrations`；socket 仅所有者可用，数据库使用 WAL。

Scheduler 会在 Graph 的 `maxParallel` 上限内启动彼此独立的节点，不设置阶段级 barrier。依赖、重叠的写入/effect scope 和 worker 上限只会串行化受影响节点；每个等待原因都会随 Run 持久化。每次 Attempt 都会获得内置 `context.clean-task` 指令 Capsule 和新的 Resident lane，因此复用的 Codex 或 Claude Code 宿主不会继承旧原生 thread，也不会 fork 父对话历史。

分配器把产品报告的每个额度窗口都视为必须同时满足的约束，优先使用资格合格的原生订阅池，并且只在所选优化目标允许时使用按量 API 容量。实时容量建议会把 Scheduler 上限降到 `maxParallel` 以下；套餐暂时繁忙时等待，不会静默消耗付费 API。临近重置且仍可用的额度会被优先利用。

可选的版本化 `remote-operators.json` 目录会把多个 DSH Product Server 的 Resident 容量投影到同一个物理算子接缝。每个投影身份都命名为 `remote.<server>.<operator>`，因此配额、并发、Trace 和已封存 ExecutionPlan 的归属都能精确关联到一个 Server。某个成员资格检查失败时只会把该成员标为不可用，不会阻塞健康的本地或远程 Provider。远程 turn 被持久接收后若出现短暂断线，系统会继续轮询同一个 Server，绝不会在其他位置重放该命令；如果准入回执丢失，则进入 `COMMAND_INDETERMINATE`，因为第二个 Server 无法证明第一个 Server 曾拒绝命令。

可选的版本化 `cluster.json` 会让一组固定 Product Server 成员共享唯一 TaskGraph 权威。每个成员分别持久化自身 term、vote、leader lease 和已复制的逻辑编排状态。只有持有未过期多数租约的节点才能修改 Scheduler 状态。任何已封存 Attempt 到达 Resident 或 model-worker Provider 之前，Leader 都必须续期该租约，并把足够数量的 Follower 推进到当前 `commitIndex`；完成后才允许开始外部产品调用。Follower 不会重放已接受命令，也会拒绝旧 term 的副本。Desktop 描述只暴露多 Server 入口选择所需的有界 Leader 投影；vote、heartbeat、export 和 install 始终是仅 admin 可用的 Remote Sync 操作。

所有成员必须使用相同的 `cluster.json` 成员表，并通过经过认证的回环隧道访问其他成员。首发复制会发送完整逻辑快照，验证每个内容寻址 Artifact digest，并在保留接收方本地选举身份的同时以事务安装。完整快照明确受 Remote Sync 请求上限约束；超大编排存储的增量状态传输后置。

对于 Resident RLM，已封存的 ExecutionPlan 同时包含高阶根模型分配和套餐优先的低阶默认 child 分配。根模型通过持久 `typescript_repl` namespace 检查可编程上下文、准入异步递归 child、接收显式 family message，并续接持久 Goal 或 Heartbeat。child 拓扑由模型在运行时决定；DSH 只机械执行 `maxDepth`、`maxChildren`、`maxTurns`、Graph 并行上限和 Provider 容量。每个 child 与 continuation 都有稳定 Receipt 和内容寻址结果 Artifact。该复合执行只占一个全局 Scheduler 槽，因此节点内递归不会成为另一套 TaskGraph，也不会与并发 DAG 工作共同超卖容量。

与 Prime 兼容的 Autonomous Mode 是围绕同一条已封存 RLM lane 的可选策略。每个 root 或 continuation turn 结算后，daemon 会持久统计非缓存输入、输出与 cache-write token，先执行宿主质量门禁，再检查限制；随后复用同一个原生 Session 做一次有界 continuation，或者以显式原因停止。配置了门禁时，只有门禁通过才是成功终态；continuation、turn、token、耗时或门禁重试耗尽都不能伪装成成功。工作区未变化的失败会继续消耗一次重试，但不会重复执行命令。门禁子进程使用仓库统一的凭据清理环境；超时或取消会终止整棵进程树，并在 Attempt 继续前达到完全停稳。该循环持久化在编排数据库中，并始终从属于唯一 TaskGraph Scheduler。

与 Prime 兼容的自动 refinement 只作用于根会话，并在真实 Turn 边界按 25 个 assistant turn 或已记录的 compact checkpoint 触发，冷却时间为 20 分钟。原生订阅模型先审查是否存在可复用的持久经验，确认后才规划可逐项应用的 Harness 编辑。失败或崩溃不确定的审查阶段不会自动重放，后台路径也不会静默回退到按量 API。可执行 TypeScript Skill 从受管 alias 解析到可信 `skillProviderModules`；模型提交的包路径永远不会被 import。

只有节点策略列出了返回的错误码且仍有 Attempt 预算时，自动重试才会创建新 Attempt。Resident 响应流断开会成为可重试的 `RUNTIME_UNAVAILABLE`；原生产品明确报告额度用尽时归类为 `QUOTA_EXHAUSTED`。允许额度重试时，下一个 Attempt 在重新密封前会排除已耗尽的 quota pool（没有 pool 身份时排除精确 offer）。格式错误的结果与不确定 command 绝不会自动重放。正常关闭 daemon 会在报告关闭完成前结束已接受的控制连接，因此被替换的 build 不会存活在拒绝连接的 socket 后面。

Attempt 运行时，daemon 会将有界 Resident 进度阶段复制到编排事件流。结算会把完整算子结果保留在 Evidence 产物中，并向终态事件添加有界的面向用户输出预览。协议版本 4 包含经 digest 校验的 `artifact.read`、schema-v3 持久 Autonomous 状态和 term-fenced 集群控制方法，因此经过认证的投影可以按需读取已保留的 Evidence 结果，而不把提示词、私有推理、终端屏幕或产品本地 transcript 复制进事件流。

## Model Experience

间接产生影响：由 `@deepseek-ai/dsh-tool-orchestration` 呈现。daemon 保存 Compiler 产物并返回有界投影，但自身不增加提示词段落。

#### KV Cache effect

每个 Attempt 接收一个已封存 Context Packet。后续 Graph、胶囊或能力 generation 会产生新数据包，不会修改已经缓存的请求。

## Known Limitations and Deferred Work

- 基础胶囊绑定支持指令和只读 resource/data 引用。Tool、MCP、secret 和可执行 Guard 绑定在提供方实现其强制机制前均会失败关闭。
- Claude Code 与 Codex 只支持派发前和下一轮次注入；即时轮次内 checkpoint 更新返回 `CAPABILITY_HOTSWAP_UNSUPPORTED`。
- RLM 只在一个已封存节点内进行有界递归；它是执行策略，不是另一个产品或全局 Scheduler；如果崩溃后无法证明复合执行的终态，就会进入 indeterminate，绝不自动重放。
- Autonomous Mode 需要显式选择，当前使用宿主 shell 质量门禁；未配置门禁时，它不会自行猜测任务专属的结束条件。
- 基础 Bundle 不内置生产 Skill 目录。部署必须显式安装可信 Skill Provider 插件；缺少 Provider 的受管条目仍可见，但状态为不可用。
- 远程成员目前只执行已在 Server 工作区中可用的只读/结果型节点。跨机器 Git worktree 同步仍是独立层，不能由远程 Provider 发现或 Scheduler 状态复制推断为已经具备。
- 首发集群成员表是固定配置。成员变化与增量副本需要未来显式升级协议；两成员集群失去任意一个成员后无法继续调度，因为它不再拥有多数派。
