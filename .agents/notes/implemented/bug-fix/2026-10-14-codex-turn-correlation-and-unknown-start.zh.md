# Agent Note: Codex 轮次关联与结果未知的启动

Status: implemented

[English](2026-10-14-codex-turn-correlation-and-unknown-start.md) | 中文

## Problem

一次 resident Codex 回合在启动几秒后失败，报 `INVALID_RESULT: subagent-codex: app-server referenced conflicting turns`。[wire](../../../../packages/subagent/subagent-codex/README.md) 把 `turn/start` 响应之前最先到达的通知所带的轮次 id 当作本次运行的轮次，之后出现另一个 id、或响应指明了不同的 id，就让运行失败。Resident 驱动连接的是常驻的 Codex app-server，所以通知可能属于同一线程的其他轮次：早先连接遗留的未完成轮次，或服务器自己开启的轮次。

失败之后情况更糟：命令被结算为失败，Session 被释放，但原生回合其实已经启动，又运行了一分半钟，同一件工作可能在第一次运行还在执行时被重新派发。`reasoning` 进度阶段也是在 `turn/start` 之前就上报的，所以"执行中"的状态并不能说明什么。

## Decision

`turn/start` 的响应指明本次运行的轮次。响应之前到达的通知先保存（最多 512 条），只有带着该轮次 id 的才会被读取；其他轮次的通知被忽略。响应之前到达的工具调用或审批会等待响应，只有点名了响应所指轮次时才会被回答；点名其他轮次的请求被拒绝但不会让运行失败，点名其他线程的请求仍然让它失败。

`turn/start` 已发出却没有有效响应（流关闭、响应格式错误、被中断）时，以 `CodexTurnStartUncertainError` 拒绝，其中带有线程、`captureBaseline` 记录的基线轮次 id（`turn/start` 之前最新的轮次，取自 `thread/turns/list`），以及按接收顺序的最近 64 帧：类型、方法、线程 id、轮次 id。不保存任务文本、工具参数或输出。JSON-RPC 错误应答表示服务器拒绝了请求，按普通失败重新抛出。

[Resident 驱动](../../../../packages/physical-operator/resident-operator-local/README.md)对结果未知的启动做核对，而不是失败：它重新打开一条到同一线程的连接，等待基线之后出现的最新回合运行结束（如果 Resident 回合被中断，会对它中断一次；最长 20 分钟），然后抛出 `COMMAND_INDETERMINATE`。守护进程已经把它记录为不会重放的 receipt，整个等待期间 Session 保持被占用。`reasoning` 阶段在原生回合有了名字之后才上报。

## Alternatives considered

**保留第一条通知的轮次 id，忽略之后的。** 这只是改变了哪一个是错的：过期轮次的通知仍可能最先到达。

**把结果未知的启动当作没有启动，让调用方重试。** 失败运行的日志显示，DSH 报告失败之后原生回合仍在运行，所以重试可能把工作执行两次。

**采用原生回合的输出。** 基线之后找到的那个回合大概率是本次的，但"大概率"不足以把输出归到某条命令上。核对只报告原生回合发生了什么，由阅读该 indeterminate receipt 的人决定。

**把 `thread/turns/list` 设为必需。** 旧版 Codex 会因此不再通过资格检查。它是可选的：没有它就没有基线，核对此时只等待正在运行的回合。

## Consequences

一次运行不再因为线程的其他轮次在响应之前上报而失败。响应丢失的启动会以 indeterminate receipt 结束，写明原生回合及其最终状态，命令不会被意外再次派发；该原生回合的输出没有被采集，需要到 Codex 里查看。这段等待最长会占用一个 Session 20 分钟。

最初的冲突没有在真实 Codex 上复现：失败的那次运行没有保留冲突帧，所以哪条通知先到仍未确认。wire 现在会记录这些帧，下次出现时就能看到它们。诊断里没有 RPC 请求 id，因为共用的 JSON-RPC 传输层没有暴露它。
