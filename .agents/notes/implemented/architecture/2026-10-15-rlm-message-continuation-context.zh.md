# Agent Note：RLM message continuation 被告知了什么

Status: implemented

[English](2026-10-15-rlm-message-continuation-context.md) | 中文

## 问题

别的 agent 或控制端给 RLM 会话发消息时，message continuation 会唤醒该会话。在 DeepSeek API worker 上它是一次新的模型请求：`generateWithTools` 每次执行都只以一条用户消息开始，不带任何早先 turn。Resident continuation 则恢复同一 lane 的原生会话，其原生上下文可能包含早先的 turn；下面的诊断针对 API worker。此前这条消息只有排队文本、一句固定的“检查已保存状态”的指令和一行消息顺序说明。它没有重述会话自己的任务，所以当任务唯一的输出规则是最后一句（“只回复这个 JSON”）时，最后一个 continuation 写节点结果时模型面前并没有这条规则；模型可以通过 REPL 读 `context.task`，但没有任何东西让它去读。它也没有列出会话已保存的变量，所以一个 continuation 声明了首轮已声明的名字，就会得到 `Identifier '…' has already been declared`。在 2026-10-13 的 18 次试验中，5 个这类错误全部来自 continuation，而 continuation 占了六个双 child 试验 129 个 cell 中的 99 个。旧日志没有保存 cell 源码，所以它们只能证明先后顺序，不能证明缺少这些文字就是错误和格式失败的原因。

## 决策

**所有 continuation 来源共用一个提示构建函数。** `rlmContinuationPrompt` 在 `orchestration-local/src/rlm-continuation.ts` 中构建 goal、heartbeat、Autonomous 和 message continuation 的提示。不传额外文本时，它对每种来源返回与以前完全相同的提示；测试把 goal、heartbeat、Autonomous 的文本固定为从上一版本抄来的字面量。`dispatchRlmContinuation` 在 API 与 Resident 分支之前调用它，所以 Resident continuation 收到同样新增的文本；这段文本只重述事实，在两条路径上都不回放历史。

**message continuation 陈述主机已知的信息。** `rlmMessageContinuationFacts` 把 message continuation 的固定检查语句换成：来自 `inspect(sessionId).task` 的会话自己的完整任务（child 是它自己的 spawn 任务，绝不是 root 的）；`restorableVariables` 与 `degradedVariables` 中的名字，两张表分开，各自注明是上一个成功 cell 之后的状态，各最多 64 个名字，其余只给数量；该会话已能发消息的父、兄弟和直接子 agent 的名册及各自的 REPL 状态，文本说明这个状态不是进度；以及两条规则：复用已有顶层名字而不是重复声明，不要再读取已送达的消息。新增的事实不复制变量值、其他 agent 的任务和消息文本（提示本身带有当前消息）。名册完整列出，因为会话及其父会话已封存的 `maxChildren` 已经限定了它。消息由谁发出，取决于运行时依据自己的记录设置的类型化字段 `messageOrigin`（经已附加的控制 lease 接受的输入为 `controller`，其余为 `agent`）；消息正文从不参与判断，所以以 `Controller input:` 开头的 agent 消息仍是 agent 消息。对控制端输入，文本说明上面的任务是该 agent 最初被要求的，该输入可以改变任务或其输出格式，否则任务仍然适用；对 agent 消息，文本说明任务的输出格式仍然适用。更早 turn 的控制端输入不会被重述，所以之后由 agent 消息触发的 continuation 会再次显示原任务。

**结果仍是最后排空的 continuation 的输出。** `rlmContinuationResult` 不变。提示要求最后一条回复符合任务的输出格式；运行时不在多份输出里挑选，所以不会从早先的 turn 里挑一个有效答案，非成功的停止原因和部分输出也和以前一样保留。

**共用的工具描述说同样两件事。** `RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.description` 增加：顶层 `const` 和 `let` 名字在 cell 之间持续存在，不得重复声明（复用绑定、换新名字，或把临时量放进代码块或函数）；`agentMessage.read(afterCount, limit)` 跳过已收到的前 `afterCount` 条消息，返回的消息中 `text` 是字符串，不一定是 JSON。描述在每次构建 bridge 时读取；已封存的 `executionOptions.tools` 只比较工具名，所以此前创建的会话不会被拒绝，并会拿到新文本。

## 考虑过的替代方案

**把会话早先的 turn 回放进 continuation。** 否决：这会改变每个会话的 continuation 成本，并且需要运行时没有的有界对话存储。

**从所有 turn 的输出里选答案。** 否决：这会事后选出一个看起来有效的答案。节点保留最后排空的 continuation 的输出。

**截断长任务或限制名册。** 否决：任务是会话唯一的输出规则，并且已经完整进入 root 的首个请求；名册已受 `maxChildren` 限定。只有变量名两张表有固定上限，这是呈现上限，不是随部署变化的设置，所以不是 `Config` 字段。

**增加等待原语，或在 attempt 中止时取消正在运行的 cell。** 不属于本次改动。取消 cell 需要工具调用路径上有取消的归属（`tool.call` 到 `executeCell` 没有 scope；model worker 的客户端 signal 只结束客户端的等待）、一条处理“中止与 cell 完成竞态”的规则，以及对已保存状态和已发往主机的效果如何处理的决定。

## 后果

每个 message continuation 请求增加任务、两张名字表和每个可见 agent 一行，Resident continuation 得到同样的文本。Provider 缓存能复用其中多少，没有证据。这一改动由实验衡量，不由测试衡量：单元和快照测试证明模型被给了什么、节点保留哪份输出；模型随后是否以更少的 cell 遵守输出格式，这里没有证明。工具描述也会到达单 Agent REPL 以及 goal、heartbeat、Autonomous 会话的 continuation，它们的提示不变，但工具列表文本变了。

## 测试

`rlm-continuation.spec.ts` 覆盖构建函数（带末行格式规则的完整长任务、两张名字表、省略计数、名册状态、作为字面量固定的非 message 提示、最后一份输出的选择）。`daemon.spec.ts` 用真实 daemon、REPL bridge 和 model-worker 路径，两个 child、一次与任务格式冲突的控制端 steer、一条自称控制端输入的 agent 消息和一个 Resident root，读取 worker 实际收到的请求；每个请求的接收者来自其 model-tool bridge 中的会话和消息 command id，绝不来自被测的任务文本。`prime-rlm-terminal` 快照加入 `context-prompts` 场景，经生产 Loader 与 daemon，只替换 provider，记录 root 首个 continuation 和一个 child 的 continuation 在 DeepSeek 适配器发出时的提示；`prime-rlm` 记录工具描述。负对照每次从保存的字节出发只改一个源文件，并要求指名的测试失败。
