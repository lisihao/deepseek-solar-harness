# Agent Note: RLM 取消范围、永久删除与终态

Status: implemented

[English](2026-10-15-rlm-cancellation-and-terminal-state.md) | 中文

## Problem

一次 RLM run 是一个根加上 child、孙辈和后续回合，全部处在同一次 TaskGraph 尝试之下。停止、删除或失败的回合对这棵树的其余部分有什么影响，由三条规则决定，而最初的实现一条都没有。所有 API child 和 continuation 共用该次尝试唯一的 abort signal，所以中断或删除一个 child 会取消根和它的兄弟。删除 child 只中断当时活动的执行，所以排队的消息、到期的 heartbeat 或稍后才完成的 dispatch 都能重新启动已删除的会话，而根在它运行时还会报告自己已排空。带着部分输出失败的 continuation，或之后成功的 goal 或 Autonomous 回合，会把 run 变成 `completed`。

## Decision

**每个执行有自己的取消。** child 的首次执行跟随派生它的会话的执行；会话的后续回合只跟随整次尝试。取消 run 或根会中止 attempt signal，每个执行的 signal 都派生自它，因此每个执行都会收到中止请求。已经被中断过的执行，例如删除之后被拒绝的执行，可能收到第二次请求。请求不证明执行已经停止，中止事件的次数也没有保证。中断一个会话只作用于该会话及其派生者。continuation 不跟随上一轮被中断的回合，因为中断是对一个执行的停止请求，不能污染该会话的下一轮。

**删除是永久的，并与中断分开。** `deleteChild` 在第一个 await 之前关闭该 child 的子树并记录命令。会话在被停止，或某个祖先删除了通向它的链路时即为已关闭。该状态已持久化。每个准入点都在工作将要开始的地方检查它：消息泵、到期 heartbeat 的认领、spawn、cell 执行、heartbeat 创建、向该会话或从该会话发送消息，以及 `trackExecution`，后者会中断在删除之后才完成的 dispatch、拒绝它，并在它的结果落定前继续把它计入。`drain` 会统计已删除后代中仍在运行的执行和尚未结束的被拒绝执行，并忽略排给已关闭会话的消息。被拒绝的中断以第一个错误使删除命令失败并保持子树关闭；相同命令 id 返回该失败，新的删除命令会再次中断。`interrupt` 不关闭任何东西。

**不是 `completed` 的结果会结束这次执行。** continuation 保留自己的停止原因（`error`、`aborted`、`max-tokens`、`refusal`）和部分输出，没有 continuation 就停止的根也是如此。活动 goal 和 Autonomous Mode 在启动下一轮之前检查同一个谓词 `rlmResultSucceeded`，并原样返回该结果。goal 保持活动，也没有恢复策略；失败之后是否恢复是将来显式的决定，而不是循环里的分支。Autonomous Mode 对 `error` 和 `aborted` 仍然抛出，因此它的重试行为不变。

`RlmChildExecutionResult.stopReason` 是可选字段，取值为上述合法值；缺省时停止原因由 `status` 推导。运行时状态文件不保存它；运行时只在内存中保留最后一个 continuation 结果。orchestration daemon 在本决定之前就已经把停止原因写入 continuation artifact，以及 `rlm.<source>.continuation.<status>` 和 `rlm.execution.settled` run 事件，这一点没有变化，所以没有新增任何持久化字段。

## Alternatives considered

**每次尝试仍用一个 abort signal，再按会话过滤。** 被拒绝，因为共享的已中止 signal 无法为单个会话撤销中止，取消 A 仍会中止 B 正在进行的调用。

**让 continuation 继承其父会话被中断的回合。** 被拒绝，因为一次中断会取消该会话之后的每一轮。代价是 continuation 只跟随整次尝试，而删除的封闭使这一点是安全的。

**把删除当作更大的中断。** 被拒绝，因为对活动执行的一次扫描无法停止之后才准入的工作；封闭必须是每个准入点都会读取的状态。

**执行被中断后就不再追踪晚到的执行。** 被拒绝，因为中断请求并不证明执行已停止：执行仍在运行时根就会报告子任务已结束，之后也没有命令能再到达它。

**回滚中断失败的删除。** 被拒绝，因为已经送达的中断无法撤销。命令记录失败并保持子树关闭；仍在运行的部分通过 `drain` 保持可见。

**让 goal 或 Autonomous Mode 从失败的回合中恢复。** 暂时被拒绝：恢复策略需要对失败和恢复各有记录，不能藏在 continuation 循环里。

## Consequences

停止或删除恰好到达预期的执行，已删除的子树在重启后仍保持安静，run 也不再把部分失败变成成功。代价是：以 `max-tokens` 或 `refusal` 结束的根，即使 goal 本可以继续它，现在也会让 run 失败；删除也不会中断子树里已经在运行的 cell（它的 spawn、发送和 heartbeat 调用会被拒绝）。已删除子树的中断失败没有自动重试，运行时也不证明被中断的执行已经停止。已登记和被拒绝的执行都只存在于内存，重启后会丢失；跨 daemon 重启仍在运行的 Resident turn 的对账不在覆盖范围内。

## Testing

`rlm-runtime-local` 和 `orchestration-local` 的测试用 keyless fake 驱动真实的 daemon、REPL bridge 和 model-worker 路径，覆盖删除的各种情形（排队消息、到期 heartbeat、晚到的 dispatch、重启、中断失败、drain），以及失败回合之后的 goal 和 Autonomous Mode。keyless 的 `prime-rlm-delete` 快照通过生产环境的 app boot 和 YAML Loader 启动运行时。keyless 的 `prime-rlm-terminal` 快照通过同一个 Loader 并带 `autoStart` 启动，所以客户端会启动生产 daemon 和 Resident daemon；只有模型提供方被替换成 `DEEPSEEK_BASE_URL` 后面的本机回环服务。生产 DeepSeek worker 不会产出 `refusal`，所以这个快照使用 `max-tokens`；`refusal` 和 `error` 仍由 `daemon.spec` 的测试覆盖。动态覆盖缺口：中断 child 的后续回合、Resident 失败路径，以及失败的消息 continuation 之后的 Autonomous 轮次。
