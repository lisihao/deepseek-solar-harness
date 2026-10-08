# Local Orchestration

[English](README.md) | 中文

本包通过独立 `dsh-orchestratord` 提供 `ctx.orchestrations`。可释放的 DSH 插件是 Unix socket 客户端；daemon 是唯一 SQLite 写者，并在 DSH 或 Desktop 重启期间继续运行已 accepted 的 TaskGraph。

打包后的 Desktop 使用 `desktop-<SemVer>` 作为本地 daemon build identity。严格握手会拒绝来自其他应用版本的 daemon，要求旧进程关闭，保留其 SQLite 状态与 Artifact，再启动当前已安装版本。源码开发在未显式提供 `DSH_BUILD_COMMIT` 时继续使用 `development` identity。

daemon 承载确定性的 direct Intent 提供方、basic Context 提供方、所有者本地内容寻址 Capsule Registry、配额感知模型分配器、持久 Continuous Harness Provider、Graph 校验器、冲突感知 Scheduler、不可变 ExecutionPlan Compiler，以及派发 Resident Claude Code 或 Codex turn 的私有物理算子 composition。状态位于 `<DSH_HOME>/orchestrations`；socket 仅所有者可用，数据库使用 WAL。

Scheduler 会在 Graph 的 `maxParallel` 上限内启动彼此独立的节点，不设置阶段级 barrier。依赖、重叠的写入/effect scope 和 worker 上限只会串行化受影响节点；每个等待原因都会随 Run 持久化。每次 Attempt 都会获得内置 `context.clean-task` 指令 Capsule 和新的 Resident lane，因此复用的 Codex 或 Claude Code 宿主不会继承旧原生 thread，也不会 fork 父对话历史。

分配器把产品报告的每个额度窗口都视为必须同时满足的约束，优先使用资格合格的原生订阅池，并且只在所选优化目标允许时使用按量 API 容量。实时容量建议会把 Scheduler 上限降到 `maxParallel` 以下；套餐暂时繁忙时等待，不会静默消耗付费 API。临近重置且仍可用的额度会被优先利用。节点声明的 fallback 算子只会在首选算子未通过可用性、认证、模型或配额资格检查后，从同一实时目录中解析；已封存的分配产物和事件会保留请求的算子／模型与原因码。

可选的版本化 `cluster.json` 同时持有固定 Product Server 成员表与远程 Resident 容量。启用了 `remoteExecution` 的成员会以 `remote.<member>.<operator>` 投影到同一个物理算子能力 seam；它的仓库允许列表把不含凭据的 `host/path` 身份映射到 Server 本地 checkout 路径或 Git URL。某个成员资格检查失败时只会把该成员标为不可用，不会阻塞健康的本地或远程 Provider。只有当集群中没有成员定义 `remoteExecution` 时才继续读取旧 `remote-operators.json`；同时定义两个目录会被拒绝，避免容量目录与选举成员表漂移。

每次普通远程 Attempt 都会从发送端的干净 Git 工作区派生仓库身份、精确 HEAD 与可选子目录。接收 Server 在 `<DSH_HOME>/orchestrations/remote-workspaces/cache` 保存不可变 Git 对象，并在 `executions` 下为每个 execution id 建立独立、带租约的可写 checkout；因此同 commit 的并行 Attempt 无法看到彼此的 tracked 或 untracked 修改。终态检查会删除 settled checkout，running 或 indeterminate receipt 会续租，过期租约会被回收。Server 绝不解释发送端的绝对路径。超大 Resident 结果按远端 `sha256:` 引用在明确的字节／时间上限内取回，针对精确 JSON 字节验证 digest，校验为完整的提供方无关结果，再写入并读回调度 Leader 的本地 Orchestration CAS。内联与传输结果均保留原 execution id、持久 command Receipt、Server 亲和性和 generation fencing。

TaskGraph 节点提示词将上下文路径标为 `Sender workspace`，并指示原生执行器以当前工作目录解析文件操作和相对范围。这不改变列出的权限或任务验收。接收端 Host 通过 [Remote Sync 执行上下文](../../client/connection/README.md#remote-sync-and-stable-session-handoff)提供精确的 checkout 身份；[Agent Note](../../../.agents/notes/implemented/bug-fix/2026-10-04-remote-native-workspace-context.md)记录保留发送方文本的原因。

远程 HTTP 5xx 响应的传输诊断最多保留响应体的 500 个字符；无法读取时使用明确的响应体不可用说明。它们仍属于 `TransportError`，并产生 `COMMAND_INDETERMINATE`：响应不能确定是否已经准入或执行原生操作。任何显式重试前都必须核对现有命令状态；响应正文或状态码本身不会被归类为原生拒绝。

同一份 `cluster.json` 让这些成员共享唯一 TaskGraph 权威。每个成员分别持久化自身 term、vote、leader lease 和已复制的逻辑编排状态。Campaign 与续租分别只允许一个 in-flight 操作，并使用 election epoch 栅栏，因此更高 term 的 heartbeat 不会被迟到 vote 或 replica 响应覆盖。只有持有未过期多数租约的节点才能修改 Scheduler 状态。任何已封存 Attempt 到达 Resident 或 model-worker Provider 之前，Leader 都必须续期该租约，并把足够数量的 Follower 推进到当前 `commitIndex`；完成后才允许开始外部产品调用。Follower 不会重放已接受命令，也会拒绝旧 term 的副本。Desktop 描述只暴露多 Server 入口选择所需的有界 Leader 投影；vote、heartbeat、export 和 install 始终是仅 admin 可用的 Remote Sync 操作。

所有成员必须使用相同的 `cluster.json` 成员表，并通过经过认证的回环隧道访问其他成员。首发复制会发送完整逻辑快照，验证每个内容寻址 Artifact digest，并在保留接收方本地选举身份的同时以事务安装。完整快照明确受 Remote Sync 请求上限约束；超大编排存储的增量状态传输后置。

对于 Resident RLM，已封存的 ExecutionPlan 同时包含高阶根模型分配和套餐优先的低阶默认 child 分配。根模型通过持久 `typescript_repl` namespace 检查可编程上下文、准入异步递归 child、接收显式 family message，并续接持久 Goal 或 Heartbeat。child 拓扑由模型在运行时决定；DSH 只机械执行 `maxDepth`、`maxChildren`、`maxTurns`、Graph 并行上限和 Provider 容量。每个 child 与 continuation 都有稳定 Receipt 和内容寻址结果 Artifact。该复合执行只占一个全局 Scheduler 槽，因此节点内递归不会成为另一套 TaskGraph，也不会与并发 DAG 工作共同超卖容量。

与 Prime 兼容的 Autonomous Mode 是围绕同一条已封存 RLM lane 的可选策略。每个 root 或 continuation turn 结算后，daemon 会持久统计非缓存输入、输出与 cache-write token，先执行宿主质量门禁，再检查限制；随后复用同一个原生 Session 做一次有界 continuation，或者以显式原因停止。配置了门禁时，只有门禁通过才是成功终态；continuation、turn、token、耗时或门禁重试耗尽都不能伪装成成功。工作区未变化的失败会继续消耗一次重试，但不会重复执行命令。门禁子进程使用仓库统一的凭据清理环境；超时或取消会终止整棵进程树，并在 Attempt 继续前达到完全停稳。该循环持久化在编排数据库中，并始终从属于唯一 TaskGraph Scheduler。

与 Prime 兼容的自动 refinement 只作用于根会话，并在真实 Turn 边界按 25 个 assistant turn 或已记录的 compact checkpoint 触发，冷却时间为 20 分钟。原生订阅模型先审查是否存在可复用的持久经验，确认后才规划可逐项应用的 Harness 编辑。失败或崩溃不确定的审查阶段不会自动重放，后台路径也不会静默回退到按量 API。可执行 TypeScript Skill 从受管 alias 解析到可信 `skillProviderModules`；模型提交的包路径永远不会被 import。

只有节点策略列出了返回的错误码且仍有 Attempt 预算时，自动重试才会创建新 Attempt。Resident 响应流断开会成为可重试的 `RUNTIME_UNAVAILABLE`；原生产品明确报告额度用尽时归类为 `QUOTA_EXHAUSTED`。允许额度重试时，下一个 Attempt 在重新密封前会排除已耗尽的 quota pool（没有 pool 身份时排除精确 offer）。格式错误的结果与不确定 command 绝不会自动重放。正常关闭 daemon 会先禁止新 Scheduler tick，并等待当前 tick 完成后再释放状态；脱离调用方的 tick 若失败，会记录日志并持久化为有界 `scheduler-fatal.json` 诊断。随后 daemon 会在报告关闭完成前结束已接受的控制连接，因此被替换的 build 不会存活在拒绝连接的 socket 后面。

Attempt 运行时，daemon 会将有界 Resident 进度阶段复制到编排事件流。结算会把完整算子结果保留在 Evidence 产物中，并向终态事件添加有界的面向用户输出预览。协议版本 7 包含经 digest 校验的 `artifact.read`、持久 Autonomous 状态和 term-fenced 集群控制方法，因此经过认证的投影可以按需读取已保留的 Evidence 结果，而不把提示词、私有推理、终端屏幕或产品本地 transcript 复制进事件流。

Schema 5 新增 `gouzi_hosts` 与 `gouzi_members`，只通过 `OrchestrationStore.gouzi`（`GouziRegistry`）写入。host 记录保存它接受的权威纪元和凭据条目名称；凭据本身从不存入 SQLite。成员记录保存其进程监听的端点，因为同一宿主上的多个成员监听不同端口；进程每次启动都会用 `setEndpoint` 替换它，没有端点的成员不会被注册为算子。成员从 `provisioning` 开始，经过 `enabled` 与 `retiring`，只有 `archive` 才会离开十只的计数，而 `archive` 需要凭据已撤销、在途工作已结算和进程树已停止。`connection` 与 `activity` 和 `membership` 并列保存，各自独立变化。创建是一个立即事务，会统计所有未归档成员，所以第十一次创建以 `GOUZI_LIMIT_REACHED` 失败。这两张表不属于集群副本；被提升的 follower 需要重新配对宿主。Schema 5 是单向迁移：旧程序会拒绝打开该数据库。

`gouziOperatorServer` 把已注册且已启用的成员投影为远端 Server，其算子地址为 `gouzi.<gouziId>.<operatorId>`。对每一次 attempt，它读取成员、其宿主以及该 attempt 封存的节点执行计划，并签发 `GouziExecutionGrant`：run、node、attempt、执行 ID、generation、权威纪元、来自计划的读、写与 effect 范围、截止时间，以及等于随后所发请求的 `gouziRequestHash` 的 `planHash`。它拒绝未 `enabled` 的成员，也拒绝不是顶层 TaskGraph attempt 的执行 ID，所以成员不会运行 RLM 子任务或 Auto-Refine 阶段。当 Run 的准入指定了 `gouziRecipient` 或 `gouziRecipients` 时，它还会拒绝没有任何接收者指定的成员，以及 generation 或执行入口与其接收者不一致的成员；接收者集合对每个成员分别约束。第一版不支持在主实例不可达时运行，所以 `offlineUntil` 等于 `deadline`；截止时间是成员自己的 `grantDeadlineMs`（60 秒到 24 小时，创建时设定）。每次远端刷新时，daemon 会注册每个 `enabled` 成员，并按宿主的 `credentialRef` 从 `ctx.credentials` 读取宿主凭据（回环或隧道端点不需要凭据），把 `connection` 记为 `online` 或 `unreachable`，并在该成员有 attempt 处于 accepted 或 running 时把 `activity` 记为 `working`。

`GouziControl.executionOperators()` 使用协议 7 的只读查询 `gouzi.execution_operators`。只有成员身份、generation、宿主、属主与端点仍匹配时，它才将已启用的注册表成员关联到实际远程注册，再读取最新 Resident catalog 中的完整算子 id、可用状态、原因和模型。查询还从匹配的最新 Resident catalog 的 `gouziWorkspace` 返回 `projectScopes`：只有经 `registeredDirectory` 解析和核验的持久化默认项目才提供成员本地真实路径。非本地成员的只读共享项目图使用这一经过认证的接收宿主目录路径；编译不要求同一路径能在调度 Mac 上通过 `realpath` 解析。旧端点缺少字段时返回 `[]`；普通算子、generation 不匹配或不可达的注册不提供目录访问依据。缺少注册或注册已过期时，算子列表为空；仅有 `connection: online` 不能证明执行入口可用。查询不会启动成员，也不改变 membership、授权或调度状态。[狗窝房间](../ui-gouzi/README.md)使用这些数据展示状态并接纳点名的标准 TaskGraph。编译和启动会对照当前目录校验 `admission.gouziRecipient`：每个节点只能使用已接纳的算子 id，不能使用 fallback、RLM 或 Autonomous Mode。对象不可用或 generation 改变时会失败，不会改选其他路由。

`./remote-host` 入口只挂载远端执行宿主服务，所以狗子成员无需 TaskGraph daemon、调度器或集群选举，也能在已注册目录执行。持久化的 `remoteExecution.projects` 将不透明项目 ID 映射到确切选中的 Server 本地目录，`defaultProjectId` 选择初始项目。`gouzi-project` 工作区身份发送项目 ID，不发送源宿主路径，也不伪造 commit；可选 origin 信息不授予目录访问权。执行要求挂载成员 service，并提供与成员身份、generation 和请求 hash 匹配的授权。直接目录执行保留未跟踪文件、尚无提交的仓库和没有 origin 的仓库。共享目录锁和执行回执位于选中项目之外；结算只释放执行元数据，不删除项目文件。冲突或未解决的命令会阻止复用，未知结果不会自动重试。见[目录领养决策](../../../.agents/notes/implemented/feature/2026-10-06-gouzi-directory-adoption.md)。

配置了项目的狗子成员使用持久化的默认项目及确切选中的真实目录。仅配置 repositories 的成员使用干净精确提交的 Git 物化；两种模式都检查授权和成员 generation。目录资格检查核对配置与目录可用性，不把目录当前忙碌当成资格失败。持久化租约检查只读；已知原生回执允许恢复原 turn，存在租约但没有原生回执则保持 indeterminate。目录锁仅在结算得到证明，或关联的命令拒绝后成功查询确认没有回执时释放；未解决结果保留锁，不重放。

## Directory snapshot delivery

`workspaceIsolation: directory-snapshot` 将普通、尚无提交或含未提交修改的目录捕获到任务自有 Git 检查点，排除 `.git` 并保留原 index 和 HEAD。狗子修改任务的准入要求注册为 `hostId: local` 且端点为回环地址；此路由不授权远端完整快照传输。接收执行器必须重新证明支持生成限制、受治理文件策略和工作区修改返回。审批后，工作在隔离 checkout 中执行；独立验证接收当前修改的 bundle，而不是只有原始基线。

新建私有检查点仓库与接收 bundle 的仓库在初始化后持久化 `core.autocrlf=false`，并向 `.git/info/attributes` 写入 `* -text -eol -filter -ident -working-tree-encoding`，使捕获、checkout 及关联执行者 worktree 保留文件字节，不应用换行、filter、ident 或编码转换。快照修改 diff 使用 `--no-textconv`。这些设置属于任务自有 Git 元数据，不修改源目录的 `.git`、index、HEAD 或用户 `.gitattributes`。已有回执保留原快照，未解决的快照或接收工作区身份不会自动重建。

验证节点的 `model-verdict` 要求严格 JSON，包含 `accepted`、非空 `reason` 以及非空字符串 `evidence` 条目。否定或缺失的结论、字段格式错误及无证据都会阻止原目录应用。通用文件测试检查权限与修改机制，不能证明验证者的语义判断质量。最终应用在修改文件前对照检查点核验受影响的源路径及其父目录。交付在原目录修改前持久化 `applying`，并在这一关键阶段拒绝暂停／取消；此前已接受的取消会阻止应用。未知交付转为 indeterminate，要求核对原 effect。

## Model Experience

通过消费上述密封 TaskGraph 节点提示词的 `@deepseek-ai/dsh-tool-orchestration` 与物理算子间接影响模型。

#### KV Cache effect

每个 Attempt 接收一个已封存 Context Packet。后续 Graph、胶囊或能力 generation 会产生新数据包，不会修改已经缓存的请求。

## Known Limitations and Deferred Work

- TaskGraph 准入会在写入编译产物前拒绝 `rlm=disabled` 与 `autonomous=enabled` 的组合。旧的持久化偏好仍可读取，只会在用于新的准入时失败。

- 基础胶囊绑定支持指令和只读 resource/data 引用。Tool、MCP、secret 和可执行 Guard 绑定在提供方实现其强制机制前均会失败关闭。
- Claude Code 与 Codex 只支持派发前和下一轮次注入；即时轮次内 checkpoint 更新返回 `CAPABILITY_HOTSWAP_UNSUPPORTED`。
- RLM 只在一个已封存节点内进行有界递归；它是执行策略，不是另一个产品或全局 Scheduler；如果崩溃后无法证明复合执行的终态，就会进入 indeterminate，绝不自动重放。
- Autonomous Mode 需要显式选择，当前使用宿主 shell 质量门禁；未配置门禁时，它不会自行猜测任务专属的结束条件。
- 基础 Bundle 不内置生产 Skill 目录。部署必须显式安装可信 Skill Provider 插件；缺少 Provider 的受管条目仍可见，但状态为不可用。
- 普通远程 Git 物化要求干净且已经提交的 Git 工作区、已配置的 origin，以及每台执行 Server 上包含锁定 commit 的允许 source。未提交的发送端修改、凭据传输、任意绝对路径映射和可变共享 worktree 都明确不支持。
- 首发集群成员表是固定配置。成员变化与增量副本需要未来显式升级协议；两成员集群失去任意一个成员后无法继续调度，因为它不再拥有多数派。
