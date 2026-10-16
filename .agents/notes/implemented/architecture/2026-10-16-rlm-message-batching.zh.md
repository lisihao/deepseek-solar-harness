# Agent Note：一起排队的消息作为一次 RLM continuation 投递

Status: implemented

[English](2026-10-16-rlm-message-batching.md) | 中文

## 问题

排给某个 RLM 会话的每条消息过去都会各自启动一次 continuation，一次接一次。在已冻结的评测运行 `run-e5976e34`（源码 `b980e8b69c`，C 臂）中，六个节点的根都派发了两个 child，每个 child 发回一条结果消息；根每条消息被 continue 一次，共十二次 continuation。六个节点里，两条消息在第一个 `rlm.message.delivered` 事件之前都已在 runtime 的记录中，第二次 continuation 的最终文本与第一次逐字节相同。选择第一条消息时第二条是否已在队列里，没有被记录。第二次 continuation 在其 `delivered` 与 `continuation.settled` 事件之间合计约 108 s，对应的 usage 记录合计 uncached input 68843、output 19625、cache-read 152960。这些是属于这些 command 的数量，不是节省：合并后的一次执行可能更贵也可能更便宜，这个区间不是请求耗时，最终文本相同也不能说明第二次执行什么都没有增加。这些运行的物理请求数和 provider 的账单未知。

## 决策

**一起排队给同一会话的消息共用一次 continuation。** `pumpSessionMessage` 取投递顺序中的第一条消息，以及紧跟其后的消息，只要每一条都是与第一条投递模式相同的 agent 消息，且渲染后的 instruction 不超过 16384 个 UTF-16 code unit。遇到第一条不符合条件的消息就停止，绝不跳过它。controller 的输入（记录的 `source: control`，或带有 `controlLeaseId`）总是单独投递，因为它可以改变任务；没有任何地方读取消息文本。比阈值更长的第一条消息像以前一样单独、完整地投递，所以阈值只决定谁共用一次 continuation，不是提示的上限。成员列表在调用 host 之前确定；之后到达的消息等下一个批次。

**一个批次就是一个 worker command。** 单条消息沿用 `<messageId>:deliver`；更大的批次是 `<第一条 messageId>:batch-<条数>-<有序 id 的摘要>:deliver`，所以成员集合不同的重试不会复用更早一次尝试的 command，而按 `:deliver` 后缀匹配 command 的代码仍然有效。`dispatchContinuation` 收到有序的 `messageIds`（`RlmMessageV1['messageId']`）；该字段只对 goal、heartbeat、autonomous 和较旧的调用方是可选的，没有它的 message continuation 会在任何 execution 存在之前被 daemon 拒绝。每个成员保留自己的 `rlm.message.delivered` 与终态 `rlm.message.continuation.<status>` 事件，带有共享的 `commandId`、`batchIndex`、`batchSize`、结果引用，以及与 execution 报告完全一致的 `stopReason` 和状态。usage 是这个 command 的 usage：一次逻辑执行可能经历多轮工具调用和多个请求，所以按 command 汇总，绝不按消息，也不按结果引用（两次不同的执行可能产生同样的工件，各自都要计入）。

**批次在调用 host 之前先记录。** 状态文件新增 `messageBatchDispatches`（`{commandId, sessionId, messageIds, state, createdAt}`，state 为 `intended`、`accepted`、`held`），版本升为 6。记录在 `dispatchContinuation` 之前写入。错误码为 `RLM_DISPATCH_NOT_ADMITTED` 的 host 错误（由 daemon 对任何原生 execution 之前的失败抛出）是唯一会删除记录并让成员保持 queued 的情形。可能已被接纳之后的其他一切都会 hold 该批次：其他任何错误、重启时发现 `intended`、host 应答之后写入失败（文件可能仍写着 `intended`，也可能已写着 `accepted`；下次启动读取它，不去猜测）、host 应答期间会话被删除，以及既无法注册也无法中断的已接纳 execution。held 的批次不会再被选中，该会话也不再收到其他消息；`drain` 不会把它报告为空闲；`rlm.message.dispatch_unknown` 事件写明 command 和成员。成员变为 delivered 与记录变为 `accepted` 在同一次写入中完成，记录随终态事件一起离开。因为会话已有 execution 而无法注册的已接纳 execution 会被中断，并由 `drain` 计入，直到它自己的结果结算，因为中断返回不等于已停止；它的成员保持 delivered。这与以前不同：以前 host 应答之后的失败可能把已 delivered 的消息放回队列并再次发送。

**终态是 execution 自己的终态。** `settled`、`failed`、`indeterminate` 以及 `stopReason` 按报告原样写给每个成员；`indeterminate` 不会被改成 `failed`。已 delivered 但没有终态事件，表示没有观察到结果（重启会丢失 execution）；它与显式的 `indeterminate` 区分开，两者都不会再次发送。

**读取状态版本 6，不读取更早的版本。** 构造时只读取版本 6，并在注册 runtime owner 之前，拒绝其他任何版本、缺少该数组的版本 6 文件，以及与消息不一致的批次记录（重复或未知的成员、属于另一个会话、command 与成员不符、成员不按投递顺序、状态与成员的投递情况不一致），并且什么都不写：被拒绝的文件保持原有字节。版本 1 至 4 的迁移和版本 5 的形状连同其测试一起删除，因为迁移后的版本 5 文件必须声称没有派发在途，而中途停止的 runtime 留下的正是这条记录要封住的窗口。只读到版本 5 的 Provider 会由其版本检查拒绝版本 6 文件；没有在旧构建上做实验。

## 考虑过的替代方案

**第二次 continuation 的结果看似已被覆盖时跳过它。** 否决：这需要对语义做判断，六个任务上相同的输出并不是其他任务的证据。

**取走所有排队的兼容消息。** 否决：投递顺序是契约的一部分，跳过中间不兼容的消息会让消息乱序，或越过 controller 的输入。

**通过添加空数组来迁移版本 5。** 因上述原因否决。

**按结果引用对 usage 去重。** 否决：不同的执行可能产生同样的工件。

**持久化冻结的成员集合，而不是从成员派生 command。** 持久化记录本来就承载成员。派生的 command 让变化的成员集合不会复用更早的 command，并让单条消息的 command 保持不变。

**新增一套 host 错误分类。** 没有做：一个错误码就足以说出 runtime 需要的那一个事实，即没有 execution 存在。

## 后果

对于与测量过的类似的任务，continuation 的次数可以降到每批一次，这是一个结构性变化，取决于消息的到达情况。它对耗时和 token 的影响并未确立：基线的请求数和账单未知，一次对比也无法证明显著性。模型原本单独看到的一条消息，现在会与其他消息按顺序一起看到。有 held 批次的会话不再收到消息，直到手工处理其状态文件；没有任何东西对其对账。因为状态版本变了，这个构建不能打开更早构建写下的状态。包含这项改动的 Desktop 发布，需要为已安装用户的版本 5 状态单独做经过审查的迁移决定；评测使用新的空 home。被封存的 `rlm-runtime`、`rlm-runtime-local` 和 `orchestration-local` 会变化。

## 测试

`message-batch.spec.ts` 覆盖：批处理与单条消息的字节、controller 隔离和不跳过 controller 输入的规则、steer 先于 follow_up 的顺序与并列、批次交接期间到达的消息、准入之前的拒绝以及以另一组成员重试、held 批次（该会话不再收到消息，重启之后也一样）、发现处于 `intended` 的批次、host 应答之后写入失败、无法注册的已接纳 execution（计入直到结果结算，无法中断时 held）、host 应答期间会话被删除、三种状态各自的终态与 stop reason、被拒绝的结果、两次执行产生同样的结果工件、调用 host 时磁盘上已有的批次，以及恰好 16384 和 16385 个 code unit 的阈值、代理对和 artifact 引用。`runtime.spec.ts` 覆盖按名称拒绝版本 1 至 5 和 7、缺少数组的版本 6 文件，以及每一种不一致的批次记录，且文件字节都保持不变。`rlm-continuation.spec.ts` 覆盖拒绝的标注和复数措辞。`prime-rlm-terminal` 快照新增 `batched-messages` 场景，经过生产 Loader 和 daemon，只替换模型 provider：两个 child 在根的 turn 结束前报告，转录包含那一次 continuation 请求、批次 command、两个成员的事件和那一条 usage 记录。`prime-rlm-e2e.spec.ts` 现在把 continuation 事件与 runtime 自己对两条消息的记录比对。二十个各自破坏一条规则的对照已运行，每次之后文件字节都已恢复，其日志在评测报告目录中。
