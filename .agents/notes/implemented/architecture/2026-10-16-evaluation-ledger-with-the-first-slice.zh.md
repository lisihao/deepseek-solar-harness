# Agent Note：评测账本与 child context、结果读取、合批 continuation 的接缝

Status: implemented

[English](2026-10-16-evaluation-ledger-with-the-first-slice.md) | 中文

## 问题

两项改动基于不同的基底。评测请求账本（[note](2026-10-15-evaluation-request-ledger.md)）在评测 scope 下准入并记账 API worker 的每个物理模型请求。第一片（[note](2026-10-16-rlm-child-context-and-result-retrieval.md)）让 child 使用自己的 context，让 parent 读取已存的 child 结果，并把排队的消息作为一次合批 continuation 投递。合并后有三个问题，每个都有观察到的答案。

1. **命令的用量。** DeepSeek worker 把报告了用量的回合相加，没有报告的回合直接跳过。第二个请求没有用量的命令，会被发布成只有第一个请求用量的命令，好像那就是它的成本。
2. **有请求未了结时的失败。** 账本把没有用量就结束的请求记为 `unknown`，因为它可能已被处理并计费。worker 报告失败请求有两种方式：抛出（例如某回合没有返回 tool call 后的 `MODEL_WORKER_INVALID`），或返回以 error 停止的结果。过去两者都与账本无关，所以重试策略列出该抛出代码的节点，可能重放一个先前请求结果未知的命令。
3. **请求从 daemon 发出的位置。** 合批 continuation、读取 child 结果，以及其后的回合，是否都在发出前被逐个请求准入。

## 决策

**只在一个位置，只在 scope 下。** `daemon.ts` 的 `executeModelWorker` 是 child、continuation、root 和普通节点派发到达 worker 的唯一函数。scope 之外它照旧调用 worker。scope 之内它统计 worker 为该命令发起的准入次数，命令结束时再从账本读回该命令的行（`attemptsOf`：逐行计数，通过标签 `<command>#plain` 或 `<command>#round<N>@<session>` 把一行关联到命令；标签从不决定有多少请求）。

**账目与结局分开。** `evaluation.command.metering` 事件在命令如何结束（带 stop reason 的返回，或带代码的失败）之外，另行记录：账目是否完整、准入次数、行数、已发出和被拒绝的数量、账本为已结算请求持有的用量、缺少用量的请求，以及每一行的 id、序号、回合、会话、状态和 body 哈希。当每次准入调用都有一行、没有 reserved 或 unknown 的行、且 worker 至少请求过一次准入时，账目才完整（`accountOf`）；只有请求被拒绝的命令，账目也是完整的，什么都没发出。该事件是命令结束那一刻的账本账目；之后对迟到收据的 `reconcile` 改变账本，不改变事件。

**账目不完整就扣下用量。** 不完整时，worker 结果里的用量被移除，因此没有消费方（`rlm.usage`、goal 与 autonomous 记账、节点证据）会把已知回合之和当作命令成本。已知部分在事件里。缺失的用量不用零补。`rlm.autonomous.usage` 对没有用量的命令写 `0`，那不是账单。

**有请求未了结的失败是未知结局。** 当一个调用者没有取消的命令抛出，或返回以 `error` 或 `aborted` 停止的结果，而账本把它的某个请求记为 reserved 或 unknown 时，它通过 `UnknownPhysicalOutcomeError` 以 `COMMAND_INDETERMINATE` 重新抛出。于是节点为 `indeterminate`，child 的生命周期为 `indeterminate`，continuation 的成员以 `indeterminate` 结束。这个身份必须穿过读取 continuation 状态的消费方，所以在账本能作证的地方也给出它：goal continuation 或 Autonomous 直接 continuation 以 `indeterminate` 结束，而账本把它的 command 的某个请求记为 reserved 或 unknown；以及 Autonomous 的 root 回合以 `error` 或 `aborted` 停止，而该会话有请求为 reserved 或 unknown（例如未知的消息 continuation 之后），都以同样方式重新抛出。此前它们分别变成 `NODE_INDETERMINATE` 和 `ORCHESTRATION_UNAVAILABLE`，重试策略可以列出这两个代码。来自其他原因的同样代码，以及没有 scope 的 home，都不变。执行被调用者取消的命令、goal continuation、Autonomous 直接 continuation 或 Autonomous root 回合保留它原有的错误，运行保持 `cancelled`；该请求在账本里仍为 `unknown`。准入被拒绝（没有发出任何请求）仍是普通的错误停止；所有请求都已结算的已知失败仍是普通失败，可以重试，重试在新的命令下运行，有自己的行。如果在报告未知结局时，store 拒绝了 `rlm.execution.failed` 通知或 metering 事件，该结局保留自己的身份，并把被拒绝的写入放进它的 cause。Autonomous root 回合的未知停止，在写 Autonomous 节点的状态和 `rlm.autonomous.usage` 事件之前就已判定，所以这两处被拒绝的写入也放进 cause，不会变成重试策略可以重放的普通存储错误。

**不改变的部分。** 拒绝不映射为 `RLM_DISPATCH_NOT_ADMITTED`、忙错误或队列：首个物理请求是在逻辑派发被接纳之后才被拒绝的，所以 runtime 里“只有在原生执行之前的拒绝才让消息留在队列”的规则不变。账本的 `unknown` 与 runtime 的 `held` 仍是两份独立记录，没有任何东西对账。scope 下仍拒绝 Resident 和远程算子、其他 worker、没有准入的调用，以及 `proven-token-count`。`request-bytes-audited` 仍只是事后核对的估计。scope 之外的模型、effort、容量、队列、取消和请求字段不变。

## 考虑过的替代方案

**修改 worker 让它报告不完整的用量。** 否决：worker 与适配器属于 WP1，不在本次改动范围内；账本已经有所需信息。

**把命令、回合和会话作为 attempt 的字段。** 否决：这会改变持久化的账本格式，其读取器不接受未知字段；标签已携带它们，事件会连同行 id 列出。

**把被拒绝的首个请求当作从未接纳的派发。** 否决：没有证据表明逻辑命令从未被接纳，且这种情况与已结算回合之后的拒绝没有区分。

## 后果

在 scope 下，命令的用量可能缺失，而此前是不完整的部分值。`evaluation.command.metering` 是新的 orchestration 事件类型，只在有 scope 的 home 中写入；store 把事件类型当文本保存，没有读取器校验它们；没有这项改动的构建未在这样的 home 上运行过。账本无法证明的结局现在是 indeterminate，此前是 failed：即有请求未了结的抛出失败和 error 停止。在场景 `unknown-continuation` 中，continuation 的成员是 `indeterminate`，而节点是 `failed`（`OPERATOR_STOPPED`）：这来自既有规则（未完成的已结算结果会使节点失败），未作改动。拒绝可见于账本行的原因和 metering 事件的行（`input-exhausted`、`attempts-exhausted`）。worker 把任何不是 stop、长度限制或 abort 的 finish 变成 `stopReason: 'error'`，并丢掉失败的代码（WP1 自己的 `worker-evaluation.spec.ts` 断言的就是这个 error 停止），所以 `ADMISSION_REFUSED` 不出现在任何 orchestration 事件里；在 `refuse-first`、`refuse-later` 和 `refuse-round` 中，被拒绝的请求结束了 root 的最后一个命令，节点的 blocker 是 `OPERATOR_STOPPED`。这不是本次改动引入的，这里也没有对它做映射。

## 测试

`prime-rlm-evaluation` fixture 的每个场景都在各自的 home 和进程里启动生产 Loader 和 daemon，只替换模型 provider；每个收到的请求按其 body 摘要与一个已准入的行一一对应，并且在到达时必须已在账本文件中处于 reserved 状态。共十八个场景：原有的 tree；`integration`（一个 root、两个 child，以及一个包含两条消息、在第一回合读取 child 结果的合批 continuation：八个请求，一个 continuation 命令两个回合）；`refuse-first`、`refuse-later`（continuation 的首个请求）和 `refuse-round`（同一命令的后续回合），均在拒绝之后不再发出请求、不回队列，任何事件里都没有 `RLM_DISPATCH_NOT_ADMITTED` 或忙错误；`cancelled`（带着在途请求取消运行：运行为 `cancelled`，节点 `failed`，该请求 `unknown`，没有重放）；`missing-usage`；`unknown-no-replay`（抛出）、`unknown-error-finish`（HTTP 500）、`unknown-child` 和 `unknown-continuation`；其中 `unknown-no-replay` 和 `unknown-error-finish` 带着列出该代码、`maxAttempts` 为 2、尝试数、输出和并发都有余量的重试策略运行，均未重放；`unknown-child` 和 `unknown-continuation` 不带重试策略，只展示 child 和成员的生命周期；`unknown-goal`、`unknown-autonomous` 和 `unknown-message-autonomous`（未知结局的 goal continuation、Autonomous 直接 continuation，以及 Autonomous 模式下的消息 continuation）带着 `maxAttempts` 为 2、并列出 `NODE_INDETERMINATE`、`ORCHESTRATION_UNAVAILABLE` 及这些消费方可能以之结束的其他代码的策略运行：没有 `node.retry_scheduled`，尝试序号不增加，不再发出第二个 root 或 child 请求，未知的请求保留；`known-retry` 和 `known-goal-retry`（第二次尝试单独计量）；`zero-child`；以及 `ordinary`（同一个 root，没有 scope：没有账本，模型、`max_tokens` 和 effort 是该 home 一直发送的，与 scope 的不同）。`evaluation-ledger.spec.ts` 覆盖标签、行计数、会话中未了结请求的计数和两个决定函数。`daemon.spec.ts` 用具有 API worker id、经 scope 的准入保留请求但不发送 HTTP 的 worker，运行真实的 daemon、账本、消费方和重试策略。对 goal continuation、Autonomous 直接 continuation 和 Autonomous 模式下的消息 continuation，各在 continuation 的请求未结束时取消运行，让 worker 在取消之后抛出，并检查运行为 `cancelled`、请求为 `unknown`、root 没有被再次发送；它还在 Autonomous 模式下的消息 continuation 以未知停止结束时，让 store 拒绝 Autonomous 节点的状态写入或其用量事件，并检查节点为 `indeterminate`、虽然策略列出了该代码也不重试、写入错误在 cause 里。它还在有未知请求的命令失败时，让 store 拒绝失败通知或 metering 事件，并检查节点为 `indeterminate`、不重试、尝试处理收到的错误保持其身份并带着被拒绝的写入；它重试命令以已知方式失败的节点；以及取消运行的工作使 worker 在取消之后抛出，并检查该错误被保留、请求仍为 unknown。全部场景在源码模式和 built-lib 模式下都运行过。

对照（一次破坏一条规则，字节恢复并哈希）：针对取消身份和 Autonomous 写入顺序，X00（修复前的源码）使五个新测试全部变红，X01 至 X05 各自恰好使它们自己的测试变红（goal、直接、消息三个消费方的取消检查各一个测试；让被拒绝的写入替换停止结果、或不把它放进 cause，对应两个写入测试）；账本函数上 12 个（L01–L11 和 P08，会话计数），全部变红；daemon 规则上 17 个（W01–W10 和 P01–P07），其中 16 个在其目标字段上变红（例如去掉重新分类后，`unknown-no-replay` 会重试并发出三个请求；去掉用量保留后，`missing-usage` 会为 root 发布 `rlm.usage`；去掉为 goal、Autonomous 直接和消息转 Autonomous 消费方保留的身份后，对应的三个场景都会重试）。有一个存活，未被这些场景覆盖（W06）：runtime 为被跟踪的 root 执行保存的状态只存在于内存（由 `drain` 返回），不出现在任何事件或记录里，所以使其为 indeterminate 的映射在 fixture 的输出中无法观察；节点自身的状态随抛出的错误而定。有两个对照首次运行存活后被改定目标，两次首轮日志都保留：W10（取消例外的抛出分支），因为在 fixture 里被取消的运行以 error 停止结束，现在经 `daemon.spec.ts` 中让 worker 在取消之后抛出的测试变红；以及 P07（只有存在未了结请求的命令才被重新分类），因为 goal 消费方向账本取自己的证据，现在经对已知失败的 daemon 级测试变红。P08 经单元测试变红。在第一增量的表中，读取标签所属命令的对照（L10，未结算尝试的用量）是经对 undefined 值的 `TypeError` 变红，并非经它所针对的断言。scope 下的 Resident child 由既有的 `daemon.spec.ts` 覆盖，没有对应的场景；“只有账本里有请求存疑的命令才被重新分类”这条规则，正向由各场景检查，反向由对已知失败的 daemon 级测试和 `known-goal-retry`（没有未知请求而失败的 continuation 保留 `ORCHESTRATION_UNAVAILABLE` 并被重试）检查。
