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

对于 Resident RLM，已封存的 ExecutionPlan 同时包含高阶根模型分配和套餐优先的低阶默认 child 分配。根模型通过持久 `typescript_repl` namespace 检查可编程上下文、准入异步递归 child、接收显式 family message，并续接持久 Goal 或 Heartbeat。child 拓扑由模型在运行时决定；DSH 只机械执行 `maxDepth`、`maxChildren`、`maxTurns`、Graph 并行上限和 Provider 容量。每个 child 与 continuation 都有稳定 Receipt 和内容寻址结果 Artifact。该复合执行只占一个全局 Scheduler 槽，因此节点内递归不会成为另一套 TaskGraph，也不会与并发 DAG 工作共同超卖容量。一次尝试里每个 API（model-worker）child 或 continuation 都在自己的取消控制之下运行。child 的首次执行跟随派生它的会话的执行；会话的后续回合（continuation）只跟随整次尝试，因此被中断的上一轮不会取消它。中断一个会话只会停止该会话及其派生者当前活动的执行，不会停止根或兄弟。删除一个 child 还会永久关闭它的子树（见 [rlm-runtime-local](../rlm-runtime-local/README.md)），而取消整个 run 或根仍会让每个执行至少被取消一次；删除之后被拒绝的执行已经被中断过一次，并通过它启动时收到的 attempt signal 再次被取消，Resident turn 的这条路径还没有动态测试。运行时最后排空的 continuation 保留自己的停止原因（`error`、`aborted`、`max-tokens`、`refusal`）和已有的部分输出：失败或不确定的 continuation 会让节点和 run 失败，而不会被报告为 `completed`，无论它有没有返回输出。没有运行 continuation 时，根自己的结果就是最后排空的结果，因此以 `max-tokens` 或 `refusal` 结束的根会让节点和 run 失败。不是 `completed` 的结果会结束这次执行：活动 goal 不会在它之后启动下一轮，Autonomous Mode 不会在以 `max-tokens` 或 `refusal` 停止的根之后启动新一轮；`error` 和 `aborted` 仍通过抛出让节点失败。goal 保持活动，也没有恢复策略，因此是否恢复由显式决定。仅仅失败的 child 在根的 continuation 没有失败时不会让整个图失败。中断 child 的后续回合还没有动态测试。

RLM 会话的 message continuation 在同一处派发，所以 `rlm-continuation.ts` 构建的提示由 API（model-worker）与 Resident 两条路径共用。API continuation 是新的请求，其 messages 不含该会话早先的 turn；Resident continuation 恢复同一 lane 的原生会话，其原生上下文可能包含早先的 turn。两条路径中，提示都重述主机已知的信息，但不回放历史：排队的消息；该会话自己的完整任务（创建会话时给它的任务文本，不一定是它收到的第一条提示）；上一个成功 cell 保存的变量名和该 cell 中保存降级的变量名，分为两张表，每张最多 64 个名字，其余只给出数量；该会话已能发消息的父、兄弟和直接子 agent，各附其 REPL 状态（`running`、`idle` 或 `inactive`），该状态不表示对方已完成任务或已汇报；以及复用已有顶层名字而不是重新声明、不要再读取已送达消息的规则。新增的事实不复制变量值、其他 agent 的任务或消息文本（提示本身带有当前消息）。节点结果仍是运行时最后排空的 continuation 的输出。对其他 agent 的消息，文本说最后一条回复应符合任务的输出格式；对运行时记录为控制端的输入（`messageOrigin`，绝不读取消息正文），文本说该输入可以改变任务或其输出格式，否则任务仍然适用。更早 turn 的控制端输入不会被重述。文本不决定采用哪份输出。Goal、heartbeat 和 Autonomous continuation 的提示不变。运行时在一次 continuation 中投递多条消息时，请求用 `messageIds` 列出它们；instruction 依次陈述每一条，结尾句使用复数，运行的 `rlm.<source>.continuation.<status>` 事件和 continuation 工件带有同样的 `messageIds`。这次 continuation 只有一个 command id 和一条 `rlm.usage` 记录，覆盖整个 execution。在启动原生 execution 之前的失败（缺少 `messageIds`、未封存的工具、桥接或 inspect 失败）会作为 `RLM_DISPATCH_NOT_ADMITTED` 报告给运行时，运行时因此可以让消息保持 queued；之后的失败不会这样报告，运行时会 hold 该批次。

Daemon 为每个 RLM 节点绑定 `readResult`：它读取 runtime 指名的 artifact，仅当其为同一 run、同一节点、同一 child 会话的 `prime-rlm-child-result`，然后逐字段检查：非空的 execution id、五种 stop reason 之一（`completed`、`aborted`、`error`、`max-tokens`、`refusal`），以及 output 列表中各 block 的字段类型（text 或 reasoning block 的 `text` 为字符串；tool-call、tool-result、image block 有各自的字段；未知类型的 block 保留）。不是该 child 的结果的条目按没有结果处理；是该 child 的结果但已损坏的，读取以 `RLM_UNAVAILABLE` 失败。没有已存文件的引用为“未持有”，无效引用或损坏文件则是错误。Runtime 已先检查调用者是该 child 的 parent，且引用就是该 child 记录里的那一个。

与 Prime 兼容的 Autonomous Mode 是围绕同一条已封存 RLM lane 的可选策略。每个 root 或 continuation turn 结算后，daemon 会持久统计非缓存输入、输出与 cache-write token，先执行宿主质量门禁，再检查限制；随后复用同一个原生 Session 做一次有界 continuation，或者以显式原因停止。配置了门禁时，只有门禁通过才是成功终态；continuation、turn、token、耗时或门禁重试耗尽都不能伪装成成功。工作区未变化的失败会继续消耗一次重试，但不会重复执行命令。门禁子进程使用仓库统一的凭据清理环境；超时或取消会终止整棵进程树，并在 Attempt 继续前达到完全停稳。该循环持久化在编排数据库中，并始终从属于唯一 TaskGraph Scheduler。

与 Prime 兼容的自动 refinement 只作用于根会话，并在真实 Turn 边界按 25 个 assistant turn 或已记录的 compact checkpoint 触发，冷却时间为 20 分钟。原生订阅模型先审查是否存在可复用的持久经验，确认后才规划可逐项应用的 Harness 编辑。失败或崩溃不确定的审查阶段不会自动重放，后台路径也不会静默回退到按量 API。可执行 TypeScript Skill 从受管 alias 解析到可信 `skillProviderModules`；模型提交的包路径永远不会被 import。

只有节点策略列出了返回的错误码且仍有 Attempt 预算时，自动重试才会创建新 Attempt。Resident 响应流断开会成为可重试的 `RUNTIME_UNAVAILABLE`；原生产品明确报告额度用尽时归类为 `QUOTA_EXHAUSTED`。允许额度重试时，下一个 Attempt 在重新密封前会排除已耗尽的 quota pool（没有 pool 身份时排除精确 offer）。格式错误的结果与不确定 command 绝不会自动重放。正常关闭 daemon 会先禁止新 Scheduler tick，并等待当前 tick 完成后再释放状态；脱离调用方的 tick 若失败，会记录日志并持久化为有界 `scheduler-fatal.json` 诊断。随后 daemon 会在报告关闭完成前结束已接受的控制连接，因此被替换的 build 不会存活在拒绝连接的 socket 后面。

Attempt 运行时，daemon 会将有界 Resident 进度阶段复制到编排事件流。结算会把完整算子结果保留在 Evidence 产物中，并向终态事件添加有界的面向用户输出预览；预览不含算子的推理块，推理块只保留在 Evidence 产物中。协议版本 7 包含经 digest 校验的 `artifact.read`、持久 Autonomous 状态和 term-fenced 集群控制方法，因此经过认证的投影可以按需读取已保留的 Evidence 结果，而不把提示词、私有推理、终端屏幕或产品本地 transcript 复制进事件流。

Schema 5 新增 `gouzi_hosts` 与 `gouzi_members`，只通过 `OrchestrationStore.gouzi`（`GouziRegistry`）写入。host 记录保存它接受的权威纪元和凭据条目名称；凭据本身从不存入 SQLite。成员记录保存其进程监听的端点，因为同一宿主上的多个成员监听不同端口；进程每次启动都会用 `setEndpoint` 替换它，没有端点的成员不会被注册为算子。成员从 `provisioning` 开始，经过 `enabled` 与 `retiring`，只有 `archive` 才会离开十只的计数，而 `archive` 需要凭据已撤销、在途工作已结算和进程树已停止。`connection` 与 `activity` 和 `membership` 并列保存，各自独立变化。创建是一个立即事务，会统计所有未归档成员，所以第十一次创建以 `GOUZI_LIMIT_REACHED` 失败。这两张表不属于集群副本；被提升的 follower 需要重新配对宿主。成员记录还保存可选的 `model`，即原生产品模型 id，由 `gouzi.edit` 设置，传 `null` 则清除。Schema 7 新增可选的 `profile`（用户为成员写的备忘，1 到 2000 个字符且不含控制字符；`gouzi.edit` 设置它，或用 `null` 清除）。Schema 5、6、7 都是单向迁移：旧程序会拒绝打开该数据库。首次迁移到 schema 7 之前，存储会把 `state.sqlite` 复制为 `state.sqlite.before-schema-7`（权限 `0600`），并且不再覆盖这份副本，所以手动回滚可以恢复迁移前的文件。这份副本是 `VACUUM INTO` 写出的同一个 SQLite 快照，所以即使另一个连接持有更早的读，它也包含仍在预写日志里的所有已提交内容；写完后会检查（完整性和 schema 版本）再改名就位，因此最终名字下永远不会是不完整的副本。无法生成或检查副本时，启动会在迁移任何东西之前停止。

`gouziOperatorServer` 把已注册且已启用的成员投影为远端 Server，其算子地址为 `gouzi.<gouziId>.<operatorId>`。对每一次 attempt，它读取成员、其宿主以及该 attempt 封存的节点执行计划，并签发 `GouziExecutionGrant`：run、node、attempt、执行 ID、generation、权威纪元、来自计划的读、写与 effect 范围、截止时间，以及等于随后所发请求的 `gouziRequestHash` 的 `planHash`。它拒绝未 `enabled` 的成员，也拒绝不是顶层 TaskGraph attempt 的执行 ID，所以成员不会运行 RLM 子任务或 Auto-Refine 阶段。当 Run 的准入指定了 `gouziRecipient` 或 `gouziRecipients` 时，它还会拒绝没有任何接收者指定的成员，以及 generation 或执行入口与其接收者不一致的成员；接收者集合对每个成员分别约束。第一版不支持在主实例不可达时运行，所以 `offlineUntil` 等于 `deadline`；截止时间是成员自己的 `grantDeadlineMs`（60 秒到 24 小时，创建时设定）。每次远端刷新时，daemon 会注册每个 `enabled` 成员，并按宿主的 `credentialRef` 从 `ctx.credentials` 读取宿主凭据（回环或隧道端点不需要凭据），把 `connection` 记为 `online` 或 `unreachable`，并在该成员有 attempt 处于 accepted 或 running 时把 `activity` 记为 `working`。

daemon 在每次远程算子刷新时向每个已注册且已启用成员的 Server 询问其身份（`gouzi.hello`，成员内存中的回答），连续两次未应答（每次 2 秒超时）就把该成员记为 `unreachable`，下一次应答后记回 `online`；它的算子保持注册并自行报告可用性。没有这个探测时，工作进程已停止的成员仍是 `online`，面板因此从不提供“唤醒”。

`GouziControl.executionOperators()` 使用协议 7 的只读查询 `gouzi.execution_operators`。只有成员身份、generation、宿主、属主与端点仍匹配时，它才将已启用的注册表成员关联到实际远程注册，再读取最新 Resident catalog 中的完整算子 id、可用状态、原因、模型，以及 catalog 标记的默认模型。查询还从匹配的最新 Resident catalog 的 `gouziWorkspace` 返回 `projectScopes`：只有经 `registeredDirectory` 解析和核验的持久化默认项目才提供成员本地真实路径。非本地成员的只读共享项目图使用这一经过认证的接收宿主目录路径；编译不要求同一路径能在调度 Mac 上通过 `realpath` 解析。旧端点缺少字段时返回 `[]`；普通算子、generation 不匹配或不可达的注册不提供目录访问依据。缺少注册或注册已过期时，算子列表为空；仅有 `connection: online` 不能证明执行入口可用。查询不会启动成员，也不改变 membership、授权或调度状态。[狗窝房间](../ui-gouzi/README.md)使用这些数据展示状态并接纳点名的标准 TaskGraph。编译和启动会对照当前目录校验 `admission.gouziRecipient`：每个节点只能使用已接纳的算子 id，不能使用 fallback、RLM 或 Autonomous Mode。对象不可用或 generation 改变时会失败，不会改选其他路由。

`./remote-host` 入口只挂载远端执行宿主服务，所以狗子成员无需 TaskGraph daemon、调度器或集群选举，也能在已注册目录执行。持久化的 `remoteExecution.projects` 将不透明项目 ID 映射到确切选中的 Server 本地目录，`defaultProjectId` 选择初始项目。`gouzi-project` 工作区身份发送项目 ID，不发送源宿主路径，也不伪造 commit；可选 origin 信息不授予目录访问权。执行要求挂载成员 service，并提供与成员身份、generation 和请求 hash 匹配的授权。直接目录执行保留未跟踪文件、尚无提交的仓库和没有 origin 的仓库。共享目录锁和执行回执位于选中项目之外；结算只释放执行元数据，不删除项目文件。冲突或未解决的命令会阻止复用，未知结果不会自动重试。见[目录领养决策](../../../.agents/notes/implemented/feature/2026-10-06-gouzi-directory-adoption.md)。

配置了项目的狗子成员使用持久化的默认项目及确切选中的真实目录。仅配置 repositories 的成员使用干净精确提交的 Git 物化；两种模式都检查授权和成员 generation。目录资格检查核对配置与目录可用性，不把目录当前忙碌当成资格失败。持久化租约检查只读；已知原生回执允许恢复原 turn，存在租约但没有原生回执则保持 indeterminate。目录锁仅在结算得到证明，或关联的命令拒绝后成功查询确认没有回执时释放；未解决结果保留锁，不重放。

## Directory snapshot delivery

`workspaceIsolation: directory-snapshot` 将普通、尚无提交或含未提交修改的目录捕获到任务自有 Git 检查点，排除 `.git` 并保留原 index 和 HEAD。狗子修改任务的准入要求注册为 `hostId: local` 且端点为回环地址；此路由不授权远端完整快照传输。接收执行器必须重新证明支持生成限制、受治理文件策略和工作区修改返回。审批后，工作在隔离 checkout 中执行；独立验证接收当前修改的 bundle，而不是只有原始基线。

新建私有检查点仓库与接收 bundle 的仓库在初始化后持久化 `core.autocrlf=false`，并向 `.git/info/attributes` 写入 `* -text -eol -filter -ident -working-tree-encoding`，使捕获、checkout 及关联执行者 worktree 保留文件字节，不应用换行、filter、ident 或编码转换。快照修改 diff 使用 `--no-textconv`。这些设置属于任务自有 Git 元数据，不修改源目录的 `.git`、index、HEAD 或用户 `.gitattributes`。已有回执保留原快照，未解决的快照或接收工作区身份不会自动重建。

验证节点的 `model-verdict` 要求严格 JSON，包含 `accepted`、非空 `reason` 以及非空字符串 `evidence` 条目。否定或缺失的结论、字段格式错误及无证据都会阻止原目录应用。通用文件测试检查权限与修改机制，不能证明验证者的语义判断质量。最终应用在修改文件前对照检查点核验受影响的源路径及其父目录。交付在原目录修改前持久化 `applying`，并在这一关键阶段拒绝暂停／取消；此前已接受的取消会阻止应用。未知交付转为 indeterminate，要求核对原 effect。

## Evaluation scope

daemon 根目录（在其 DSH home 之内，绝不在全局配置里）中的 `evaluation-scope.json` 把该 home 封存给一次评测。它在 daemon 启动时读取并校验，任何字段都没有默认值，无法使用的文件会让 daemon 停止启动。它给出 scope id、唯一允许的模型、`inputBound` 模式、各项限额（累计输入 token 含缓存读取、累计计费输出 token 含 reasoning、物理 HTTP 尝试数、并发请求数、单个请求的 `max_tokens` 上限），以及 `thinking: enabled` 和推理 effort。一个 home 就是一个 scope，所以 root、所有后代、所有 continuation、所有工具轮次和所有 node 重试都使用同一份账本 `evaluation-ledger.json`；重试不会得到新的预算，在不同 scope 文件下写出的账本会被拒绝。

在 scope 之下，daemon 对每个 API worker 请求都发送 scope 指定的模型、上限和 effort，每个物理请求在其请求体序列化之后、发送之前由账本准入。准入是一个同步步骤：检查余额，把预留写到磁盘（写入、fsync、rename），然后才放行请求。它预留请求体的字节数作为输入、请求体的 `max_tokens` 作为输出、一个尝试名额和一个并发名额；线上 `max_tokens`、thinking 模式、effort 或模型与 scope 不一致、含非文本内容、或放不下的请求都会被拒绝。provider 的 usage 到达时结算（缓存读取计入输入；`completion_tokens` 已包含 reasoning），它替换预留，结算幂等，冲突的第二次结算会停止所有准入。没有 usage 就结束的请求（中止、错误、`[DONE]` 之前断流、消费者停止读取、崩溃、重启）保持 `unknown`：其预留和并发名额继续占用，绝不释放也不重新发送，只有已核对的回执才能结束它。超出预留的 usage 按报告值计入，不截断，并停止之后的所有准入。graph 尝试、worker 的工具轮次、以及已准入和被拒绝的 HTTP 尝试是分开的计数：账本为每个 HTTP 尝试记录其命令和轮次标签。

账本只有一个所有者。打开它时先取得一把一次发布完整的所有者锁，所以锁文件不会在没有记录所有者的状态下存在；已被持有或读不出的锁绝不接管。所有者已退出的锁在一个以同样方式发布的排他接管 guard 之下替换：接管者在 guard 之下重新读取该锁，只有它仍是读到的那把过期锁才删除，若有新的所有者抢到新锁，接管者就退出。接管中途死掉的进程留下的 guard 不会被接管，接管会失败关闭，直到手工删除该文件。`close()` 之后账本对象不再写入：旧的票据、旧的 admission 和迟到的回执都不能改动已被另一个进程拥有的文件，仍在途请求的 usage 会丢失，其预留保留，由下一个所有者标为 unknown。账本只会在 daemon 锁已持有之后创建、恢复或写入。账本文件在任何改写之前先校验（版本、键、状态、计数、跟随序号的唯一 id、与 usage 一致的状态），并且在把在途请求标为 unknown 之前先累计总数；校验失败的账本逐字节原样保留且不发送任何请求，合计超过最大精确整数时拒绝。

scope 只计量 API worker 的请求。在它之下，daemon 拒绝任何其他 worker 以及所有 Resident 或远程算子的派发，所以 API worker 的模型请求都不能绕过账本离开 daemon。加载进 daemon 的任何其他插件（Skill 或 Browser Provider 模块）通过 daemon 上下文发起的模型调用，如果没有携带 admission，会被 `llm/stream` 上的监听器拒绝。scope 指定的模型会发送到线上，不论分配选了哪个层级；运行的 `model.allocated` 事件仍显示分配结果。

`inputBound` 说明发送前如何约束输入 token。`request-bytes-audited` 预留请求体字节数，并在之后用 provider 报告的 usage 核对。它不是证明：只有分词器是字节级的、且聊天模板增加的内容不超过 JSON 结构时，字节数才是 token 数的上界；超出预留的请求只能在发送之后才被发现。`proven-token-count` 要求发送前就被证明的上界，本构建没有，所以要求它的 scope 不准入任何请求。该拒绝作为安全拒绝被测试；它并不意味着可以运行正式评测。官方 Chat Completions 页面把 `max_tokens` 定义为生成 token 的最大数，并把 reasoning token 列在 completion 明细之内，但没有说明上限包含它，也没有找到对整个请求的发送前计数。

## Model Experience

通过消费上述密封 TaskGraph 节点提示词的 `@deepseek-ai/dsh-tool-orchestration` 与物理算子间接影响模型。

#### KV Cache effect

每个 Attempt 接收一个已封存 Context Packet。后续 Graph、胶囊或能力 generation 会产生新数据包，不会修改已经缓存的请求。message continuation 是独立的请求。它的提示在排队消息之外增加该会话的完整任务、最多 64 个已保存和 64 个降级的变量名，以及每个可见 agent 一行，所以输入随任务长度增长。Provider 缓存能复用其中多少，以及增加的输入能否被减少的 cell 抵消，由实验衡量，不由单元测试和快照证明。

## Known Limitations and Deferred Work

- 在评测 scope 之下，线上的模型是 scope 指定的，但运行的 `model.allocated` 事件和 usage 事件（`rlm.usage`）仍显示分配所选的模型。成本应从账本计算，而不是从这些事件。
- 目前没有生产代码核对 `unknown` 请求，所以没有 usage 就结束的请求会一直保留其预留和并发名额，直到 home 被替换；`concurrentRequests = 1` 时这会阻塞之后的所有请求。
- 评测 scope 约束 API worker 的请求。它不隔离网络或凭据，所以不能阻止 REPL 中的代码自行访问网络；它没有墙钟限制；它的输入预留是请求体字节数并在事后核对，不是发送前证明的上界。

- message continuation 提示中的变量名和 agent 状态是主机快照：不含失败 cell 声明的名字和设置在 `globalThis` 上的属性，agent 的 REPL 状态也不说明其进度。该提示不保证模型遵守输出格式；测试证明的是模型被给了什么、节点保留哪份输出。
- TaskGraph 准入会在写入编译产物前拒绝 `rlm=disabled` 与 `autonomous=enabled` 的组合。旧的持久化偏好仍可读取，只会在用于新的准入时失败。

- 基础胶囊绑定支持指令和只读 resource/data 引用。Tool、MCP、secret 和可执行 Guard 绑定在提供方实现其强制机制前均会失败关闭。
- Claude Code 与 Codex 只支持派发前和下一轮次注入；即时轮次内 checkpoint 更新返回 `CAPABILITY_HOTSWAP_UNSUPPORTED`。
- RLM 只在一个已封存节点内进行有界递归；它是执行策略，不是另一个产品或全局 Scheduler；如果崩溃后无法证明复合执行的终态，就会进入 indeterminate，绝不自动重放。
- Autonomous Mode 需要显式选择，当前使用宿主 shell 质量门禁；未配置门禁时，它不会自行猜测任务专属的结束条件。
- 基础 Bundle 不内置生产 Skill 目录。部署必须显式安装可信 Skill Provider 插件；缺少 Provider 的受管条目仍可见，但状态为不可用。
- 普通远程 Git 物化要求干净且已经提交的 Git 工作区、已配置的 origin，以及每台执行 Server 上包含锁定 commit 的允许 source。未提交的发送端修改、凭据传输、任意绝对路径映射和可变共享 worktree 都明确不支持。
- 首发集群成员表是固定配置。成员变化与增量副本需要未来显式升级协议；两成员集群失去任意一个成员后无法继续调度，因为它不再拥有多数派。
