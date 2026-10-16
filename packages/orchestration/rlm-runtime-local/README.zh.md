# @deepseek-ai/dsh-rlm-runtime-local

[English](README.md) | 中文

`ctx.rlmRuntime` 的 owner-local Provider，提供持久 TypeScript REPL namespace、节点内 Child Registry、家庭范围消息、Command Receipt、变量快照、Goal 和游标事件。

## Runtime 行为

一个逻辑 RLM Session 持有一个 lexical namespace。可编程 `context` 对象和可独立恢复的 binding 跨 Provider 重启保留；单个 binding 失败会保持具名 degraded 状态，不阻断其他 binding 恢复。Kernel 使用 TypeScript AST 发现顶层声明，包括解构和同一语句内的多个声明。可克隆的值从最新 V8 value snapshot 恢复；V8 无法克隆的静态 import、function、class 和直接函数表达式 binding 从声明源码恢复。带私有捕获状态的工厂闭包会明确降级：本 Runtime 不会假装 V8 可以序列化 closure。

快照上限与 Prime v0.8 默认值一致：单个 binding 16 MiB、包含 `context` 的可编程状态总量 256 MiB。超限或其他无法恢复的 binding 会被独立跳过，其余 namespace 继续恢复。

`rlm(task, { name })` 通过 Consumer 提供的 Host binding 准入 Child，并在 Child result settle 前返回 handle。`skills.list()` 投影父执行已经密封的 Skill catalog；`skills.call(name, args)` 只通过 Consumer 持有的 Host binding 转发该 catalog 中可用且由 Host 签发的 alias，因此 Runtime 代码既不能提交 import path，也不能在同一 Attempt 中观察到目录更新。Cell 串行执行，已准入的 Child execution 可以并发推进。显式消息和 Artifact reference 才是答案通道。Local Provider 还实现了版本化的 Agents View `attach → input → detach` 控制面：一个存活 caller 只能持有一个 lease，控制输入通过现有 message/continuation pump 排队，进程重启后可回收死进程遗留的 lease。

新 child 的 `context` 是其 parent 拥有的协议键加上设为该 child 自身完整 task 的 `task`；parent 的其余 `context` 不被复制。在此行为之前接纳的 child 保留其持久化时的 `context`：旧 child 的 `context` 不迁移也不改写。状态文件的其他内容仍照常写入。`rlm.childSummaries()` 与 `rlm.readChildResult()` 独立于 `listSubagents()`，后者去掉 `outputPreview` 并保留其他字段。`readChildResult` 在调用会话持久化的 children 中查找该 child，因此另一个会话的 child 的引用或 id 会以 `RLM_FAMILY_VIOLATION` 被拒绝；不是该 child 记录里那一个的 `resultRef` 同样被拒绝；已删除或已关闭的 child 为 `RLM_UNAVAILABLE`。它向 host 索取记录所指向的已存结果，把文本块用一个换行连接后渲染，最多返回一个片段，其 JSON 不超过该会话 `limits.maxOutputBytes` 的三分之一（cell 记录的输出同时计入返回值及其渲染文本）。超出末尾或落在代理对内部的 offset 为 `RLM_INVALID`。返回片段的读取会追加一条 `rlm.child.result.read` 事件，含 child、command、引用、offset、长度、标志位和两个哈希；`not_settled`、`indeterminate`、`not_found` 的结果和错误不追加事件。

持久 Root 同时记录 Child model rule。`parent-inherit` 下，省略 Child model 必定使用当前 Parent 的完整选择；意外携带的 allocator default 会被拒绝。`allocator-default` 下，省略 model 只能使用 Scheduler 已密封的 default child selection。每个 Child 都持久化其 `modelOrigin`，每一次 child dispatch 都携带 Parent 已密封的 tools、Skills、retry policy 和 capability context。Kernel 会拒绝 `name`、`model`、`thinking` 以外的全部 `rlm()` option；显式选择会原样交给 Consumer 的 catalog validation，而不是静默 fallback。

状态原子写入配置的 owner-local root。重启恢复会分别恢复可序列化变量，把未完成 Receipt 变为 `indeterminate`，并要求显式放弃，绝不重放无法证明的原生 effect。`compact.run()` 只记录 Receipt 绑定的 Host 调度决定；真实原生历史压缩必须由 Host 在 turn boundary 执行，TypeScript namespace 不会被重置。

Provider 在 `state.json` 中保存版本 6 状态，其中必须有 `messageBatchDispatches` 数组。构造时只读取版本 6，并在注册 runtime owner 之前，对其他任何版本、缺少该数组的版本 6 文件、以及与消息不一致的批次记录，抛出 `RLM_UNAVAILABLE` 拒绝；它不迁移、不修复、不改写，被拒绝的文件保持原有字节。只读到版本 5 的 Provider 同样会拒绝版本 6 文件。因此本构建不打开版本 5 及更早的状态：替换旧 Provider 需要另外的迁移决定，评测使用新的空 home。

排给同一个会话的消息在可以时一起投递：先取投递顺序中的第一条（steer 先于 follow_up，然后按到达顺序），再取紧跟其后的消息，只要每一条都是同一投递模式的 agent 消息，且渲染后的 instruction 不超过 16384 个 UTF-16 code unit。判断只读取 runtime 记录的 `source` 和 `controlLeaseId`，从不读文本；controller 的输入总是单独投递，遇到第一条不符合条件的消息就停止，不会跳过它。第一条消息自己渲染后的 instruction 已超过这个值时，仍像以前一样单独、完整地投递；这个阈值只决定哪些消息共用一次 continuation，不是提示的长度上限。一个批次就是一次 `dispatchContinuation` 调用和一个 worker command：单条消息的 command 是 `<messageId>:deliver`，更大的批次是 `<第一条 messageId>:batch-<条数>-<有序 id 的摘要>:deliver`。请求带有有序的 `messageIds`。每个成员各有自己的 `rlm.message.delivered` 和终态 `rlm.message.continuation.<status>` 事件；它们共享 `commandId`、结果引用，以及 execution 报告的状态和 stop reason，所以 `indeterminate` 的结果仍是 `indeterminate`。已 delivered 但没有终态事件，表示没有观察到结果（例如重启之后）；这与显式的 `indeterminate` 事件不同，两者都不会再次发送。批次的 usage 是它那一个逻辑 command 的 usage，可能跨越多轮工具调用和多个请求；按 command 汇总 usage，不按消息，也不按结果引用。

批次在调用 host 之前先写入 `messageBatchDispatches`。只有错误码为 `RLM_DISPATCH_NOT_ADMITTED` 的 host 错误（在任何 execution 存在之前做出的拒绝）会删除该记录并让成员保持 queued，同时写 `deliveryError`。其他任何失败、重启时发现记录仍为 `intended`、host 应答之后写入失败、host 应答期间会话被删除，以及无法注册也无法中断的已接纳 execution，都会让该批次保持 held：记录保持 `held`，成员不会再被选中，该会话不再发送其他消息，`drain` 把这些成员计为未空闲，并由 `rlm.message.dispatch_unknown` 事件写明 command 与成员。这里没有自动对账，所以 held 的会话要手工处理状态文件后才会解除。因为会话已有 execution 而无法注册的已接纳 execution 会被中断，并由 `drain` 计入，直到它自己的结果结算；中断返回并不表示它已结束。

`interrupt(sessionId)` 请求该会话及其下方每个会话当前活动的执行停止，包括已删除 child 中仍在停止的执行和尚未结束的被拒绝执行，并在这些请求结算时返回，不是在执行停止时返回。它不关闭任何东西：之后的消息或到期的 heartbeat 仍会准入新的执行。`deleteChild` 是永久的。它在第一个 await 之前就关闭该 child 的子树并记录命令。已关闭的会话不再准入消息投递、到期 heartbeat、spawn、cell、heartbeat 创建，也不再收发消息；`trackExecution` 会中断随后才完成的 dispatch、拒绝它，并在它结束前继续把它计入。关闭状态（child 上的 `deleted` 标记、其下已停止的会话，以及删除命令的回执）已持久化，重启后子树仍然关闭。执行句柄无论是已登记的还是被拒绝的，都只存在于内存，重启后会丢失。随后 `deleteChild` 中断该 child 下方每个活动的执行。如果某个中断被拒绝，命令以第一个拒绝失败：子树保持关闭，回执为 `failed`，相同命令 id 返回该失败，新的删除命令会再次中断。已完成的部分中断不会回滚，运行时也不证明被中断的执行已经停止。`drain` 会统计已删除后代中仍在运行的执行，以及尚未结束的被拒绝执行，因此根不会在它们停止前被报告为已排空；排给已删除会话的消息不计入，也永远不会投递。直接被删除的 child 在删除之后到达的结果会被忽略（`rlm.child.late_result_ignored`）。在已关闭的祖先之下被接纳的后代不会被忽略：它仍可以结算自己的记录，所以被删除 child 的子树里，后代在删除之后可能显示为 `settled`。`drain` 返回最后一个 continuation 结果，带有它自己的 `status`、`stopReason` 和部分 `output`，不会把失败或不确定的 continuation 改写成成功。

## Model Experience

Indirectly, through a Consumer that exposes the Provider as the `typescript_repl` model tool. The tool description names `rlm.childSummaries()` and `rlm.readChildResult()`, and a child's REPL `context` holds its own task and the protocol keys instead of a copy of its parent's `context`.

#### KV Cache effect

Provider 不直接组装模型上下文。Tool schema 和有界 Cell result 由 Consumer 持有，不改变已经可复用的 Prompt prefix。 `typescript_repl` 工具描述的字节发生了变化（新增两句，说明新增的 helper）；对缓存命中和 token 用量的影响未测量。对于此改动之后创建的 child，打印或返回 `context` 的 cell 看到的是该 child 自己的 task 和协议键，该工具结果也不再把 parent 的 task 带入 child 之后的请求。

## Known Limitations and Deferred Work

- **不是操作系统安全沙箱** — TypeScript namespace 具有 owner daemon 的操作系统权限；TaskGraph scope/effect 准入必须在派发前完成。
- **源码恢复边界** — 声明源码恢复可保留直接 function/class/import 以及它们对其他已恢复顶层 binding 的引用；它重新创建声明代码，不会保留工厂 closure 捕获或已变更 class 静态字段等可变运行时状态。
- **已删除会话中正在运行的 cell** — 删除不会中断子树里已经在运行的 cell；它的 spawn、发送和 heartbeat 调用会被拒绝，cell 在 `maxCellMs` 内结束。
- **重启期间的 Resident turn** — 执行句柄在内存中，所以跨 daemon 重启仍在运行的 Resident turn 不会被对账，`drain` 也看不到它。被接受的中断不证明原生进程已经停止。
- **Held 的消息批次** — 可能已被接纳的批次会一直 held，连同其后到达的消息，直到手工处理其状态文件；没有代码对其对账。
- **兼容子集** — 原生 Provider tool 与 Continuous Harness 持有剩余 Prime 端到端兼容项。
