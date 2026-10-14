# Agent Note: Codex 轮次关联与结果未知的启动

Status: implemented

[English](2026-10-14-codex-turn-correlation-and-unknown-start.md) | 中文

## Problem

一次 resident Codex 回合在启动几秒后失败，报 `INVALID_RESULT: subagent-codex: app-server referenced conflicting turns`。[wire](../../../../packages/subagent/subagent-codex/README.md) 把 `turn/start` 响应之前最先到达的通知所带的轮次 id 当作本次运行的轮次，之后出现另一个 id、或响应指明了不同的 id，就让运行失败。Resident 驱动连接的是常驻的 Codex app-server，所以通知可能属于同一线程的其他轮次：早先连接遗留的未完成轮次，或服务器自己开启的轮次。

失败之后情况更糟：命令被结算为失败，Session 被释放，但原生回合其实已经启动，又运行了一分半钟，同一件工作可能在第一次运行还在执行时被重新派发。`reasoning` 进度阶段也是在 `turn/start` 之前就上报的，所以"执行中"的状态并不能说明什么。

## Decision

`turn/start` 的响应指明本次运行的轮次。响应之前到达的通知先保存（最多 512 条），只有带着该轮次 id 的才会被读取；其他轮次的通知被忽略。响应之前到达的工具调用或审批会等待响应，只有点名了响应所指轮次时才会被回答；点名其他轮次的请求被拒绝但不会让运行失败，点名其他线程的请求仍然让它失败。

`turn/start` 已发出却没有有效响应（流关闭、响应格式错误、被中断）时，以 `CodexTurnStartUncertainError` 拒绝，其中带有线程、`captureBaseline` 记录的基线轮次 id（`turn/start` 之前最新的轮次，取自 `thread/turns/list`），以及按接收顺序的最近 64 帧：类型、方法、线程 id、轮次 id。不保存任务文本、工具参数或输出。JSON-RPC 错误应答表示服务器拒绝了请求，按普通失败重新抛出。

[Resident 驱动](../../../../packages/physical-operator/resident-operator-local/README.md)对没有让运行拿到回合的启动做核对，而不是失败：它重新打开一条到同一线程的连接（恢复线程时不带任何覆盖，所以线程的配置不会改变），并以 `COMMAND_INDETERMINATE` 结束，守护进程把它记录为不会重放的 receipt。先做什么取决于已知的信息：

- **响应指明了回合**（读取其之前保存的通知失败了）：服务器已确认这个回合，所以按 id 等待它，如果 Resident 回合被中断就对它中断一次，最长 20 分钟。看到它结束，就知道原生执行已经停止，Session 被释放。
- **没有响应指明回合：** 把基线之后的第一个新回合固定下来，只做观察。绝不中断它，出现第二个不同的新回合就说明身份有歧义，推断出的回合结束了也只报告为未证实，绝不当作这条命令的。

其余结果（推断的回合、线程无法读取、等待结束时回合仍在运行）都带 `nativeOutcomeUnconfirmed`。守护进程随后让 Session 保持关闭：健康原因是 `native_outcome_unconfirmed`，准入会拒绝任何新命令（无论命令 id 是什么），直到显式解决该 indeterminate 命令或重置 Session。这个阻断属于未解决的命令 Receipt（解决或重置 Session 之前，其 `resolution` 为 `unconfirmed`），Session 的健康原因只是它的镜像，所以重启后依然有效，其他路径也无法解除：已处置的命令不能再次处置，处置另一条命令、完成压缩或压缩失败都会在该 Receipt 未解决期间让 Session 保持关闭，已关闭的 Session 也不准入压缩。daemon 崩溃时已开始运行的 Codex Receipt 同样按此恢复，因为原生 turn 可能仍在 daemon 遗留的 app-server 中运行。只有 `completed`、`interrupted`、`failed` 能证明原生 turn 已结束；线程列表会拒绝其他状态，对账读到的非这三者之一的状态让 Session 保持关闭。守护进程还会保留驱动给出的 `COMMAND_INDETERMINATE` 结论，即使它的诊断引用了传输失败；早先的版本会把它改写成普通的 `RUNTIME_UNAVAILABLE` 失败并释放 Session。`reasoning` 阶段在原生回合有了名字之后才上报。

## Alternatives considered

**保留第一条通知的轮次 id，忽略之后的。** 这只是改变了哪一个是错的：过期轮次的通知仍可能最先到达。

**把结果未知的启动当作没有启动，让调用方重试。** 失败运行的日志显示，DSH 报告失败之后原生回合仍在运行，所以重试可能把工作执行两次。

**采用原生回合的输出。** 基线之后找到的那个回合大概率是本次的，但"大概率"不足以把输出归到某条命令上。核对只报告原生回合发生了什么，由阅读该 indeterminate receipt 的人决定。

**推断的回合一结束就当作本次的。** 这会在无法区分是本次启动的回合还是线程上另一个回合的证据上释放 Session；对第一个版本的审计还显示，它每次读取都会跟着当时最新的回合走，并可能中断一个无关的回合。

**把 `thread/turns/list` 设为必需。** 旧版 Codex 会因此不再通过资格检查。它是可选的：没有它就没有基线，核对此时只等待正在运行的回合。

## Consequences

一次运行不再因为线程的其他轮次在响应之前上报而失败。没有让运行拿到回合的启动会以 indeterminate receipt 结束，写明看到了什么，命令不会被意外再次派发，无论用原来的 id 还是新 id。原生结果未确认的 Session 会拒绝新命令，直到有人解决该命令或重置 Session；不会自动释放，因为没有任何观察能证明那是谁的回合。该原生回合的输出没有被采集，需要到 Codex 里查看。这段等待最长会占用一个 Session 20 分钟。

最初的冲突没有在真实 Codex 上复现：失败的那次运行没有保留冲突帧，所以哪条通知先到仍未确认。wire 现在会记录这些帧，下次出现时就能看到它们。诊断里没有 RPC 请求 id，因为共用的 JSON-RPC 传输层没有暴露它。
