# Agent Note：child 以自己的 context 启动，parent 分段读取并校验 child 的结果

Status: implemented

[English](2026-10-16-rlm-child-context-and-result-retrieval.md) | 中文

## 问题

child 的 REPL `context` 过去是其 parent `context` 的克隆。其中的 parent `task` 是 parent 的完整任务，可能包含全部输入和其他 child 的任务。捕获到的请求显示了后果：只出现在 root 任务里的标记，会出现在 root 收到的 child cell `JSON.stringify(context)` 的结果里（API 路径 child 第 1、2 轮），Resident child 的 REPL 也打印出 root 的任务。child 自己的 prompt 本来只含 child 的任务，所以模型请求没有受影响，受影响的是 REPL 视图。这是 agent 之间的可见性泄漏，不是测量到的成本。

parent 也没有读取 child 已存结果的有界方式。`listSubagents()` 去掉了 `outputPreview`，完整结果只存在于模型无法指名的 artifact 中，parent 只能看到 child 自己选择发回的消息。这里没有任何测量说明更大的结果出现过多少次，本 Note 记录的是约定，不是收益。

## 决策

**新 child 的 `context` 是其 parent 的协议键，加上设为 child 自身完整任务的 `task`。** 协议键为 `runId`、`nodeId`、`contextPacketRef`、`capabilityPlanRef`、`graphCertificateHash`、`defaultChildOperatorId`、`defaultChildModel`、`defaultChildTier`。其余一概不复制：不含 parent 的任务，也不含其 cell 存入的值。可信的 child 选择（model、policy）从持久化的会话快照读取，不读 `context`，所以没有决策依赖被去掉的字段；child 需要的材料写进 parent 为它写的任务里。任务从不被缩短。此前接纳的 child 保留其持久化时的 `context`。

**`rlm.childSummaries()`** 返回 id、名称、深度、lifecycle、`resultRef`、`error` 和前 200 个 UTF-16 code unit 的预览，不含任务和会话目录。`listSubagents()` 不变。

**`rlm.readChildResult(child, { offset, limit, resultRef })`** 读取直接 child 已存结果的一个片段。授权先行，依据是调用者的持久化记录：child 必须是调用会话的 child（否则 `RLM_FAMILY_VIOLATION`），给出的 `resultRef` 必须是该 child 记录里的那一个（同一错误），已删除或已关闭的 child 为 `RLM_UNAVAILABLE`。已接纳或运行中的 child 为 `not_settled`，`indeterminate` 的 child 为 `indeterminate`，没有结果或 host 不持有其结果的 child 为 `not_found`；这些都不会作为空成功返回。之后 host 只在条目是同一 run、节点、child 会话的 `prime-rlm-child-result` 时，才为记录的引用返回已存内容。渲染是把文本块用一个换行连接；非文本块计入 `omittedBlocks` 而不渲染。单位是 UTF-16 code unit；片段不会结束在代理对中间，超出末尾或落在代理对内部的 offset 为 `RLM_INVALID`。结果带有 `segmentSha256`（该片段）、`fullSha256`（完整渲染）、`resultRef`（artifact 引用，是另一个哈希）、`totalUnits`、`complete`、`truncated`、`nextOffset`、`stopReason`、`commandId`、`isData: true` 与文本。因为 cell 记录的输出同时计入返回值与其渲染，对象保持在 `limits.maxOutputBytes` 的三分之一以内。每次读取追加 `rlm.child.result.read`。`readResult` 是可选的 host 绑定；没有它时该 helper 以 `RLM_UNAVAILABLE` 失败。

**通用策略文案在单独的提交里改动**（策略 `1.5.0`）：只为值得其成本的独立部分创建 child，小任务或严格串行的任务直接解决。它没有给计划增加字段，也没有 `delegation` 设置。

## 考虑过的替代方案

**保留 parent 的 `context` 并隐藏 `task`。** 否决：cell 存入的值仍会带过去，而按字段的拒绝列表对新键是放行的；允许列表则是拒绝。

**把 child 的任务截成尾部。** 否决：child 自己的最后几行带有输出规则，任务保持完整。

**只凭引用授权。** 否决：artifact 存储被所有 run 共用。调用会话的记录指名引用，daemon 再检查存储返回了什么。

**返回完整结果并带截断标志。** 否决：结果可能超过输出上限；带两个哈希的分段让 parent 能校验重组。

## 后果

模型可见的 `typescript_repl` 描述增加两句，所以包含旧文本的 Prompt prefix 对它不再可复用；对缓存命中和 token 的影响未测量。在 child 里打印 `context` 的 cell 会看到更少的键。没有任何测量说明 child 是否更便宜或回答是否更好。状态文件格式没有变化：新 helper 读取持久化 children 里已有的 `resultRef`，状态仍是版本 6，旧会话既不改写也不迁移。新增一种持久化记录：每次读取向 `state.json` 的 `events` 列表追加一条 `rlm.child.result.read` 事件（child、command、引用、offset、长度、标志位、两个哈希、状态；不含文本）。状态加载只检查 `events` 是数组，不检查事件类型，且其中已有 35 种事件类型，所以没有这项改动的构建能加载这样的文件；这是读代码得出的，没有在旧构建上试过。auto-refine 回合会把会话最近 128 条事件放进它的提示，因此这些小记录可能出现在那里。被封存的 `rlm-runtime`、`rlm-runtime-local`、`rlm-strategy-local` 和 `orchestration-local` 会变化，包含这项改动的 Desktop 发布需要重新封存它们。

## 测试

`child-context.spec.ts` 覆盖允许的键、含最后一行的完整任务、不含 parent 的任务或其存入的值、孙 child 以及持久化会话。`child-result.spec.ts` 覆盖对含代理对和多字节字符的文本做带两个哈希的重组、输出上限、每一种拒绝（另一个会话、猜出的引用、已删除的 child、没有读取器的 host）、未结束、`indeterminate`、失败和没有结果的 child 的状态、范围、混合块的渲染、摘要、事件，以及重启后相同的授权。`rlm-continuation.spec.ts` 覆盖属于其他 run、节点、child 会话或其他种类的已存条目。`prime-rlm-e2e.spec.ts` 捕获 Resident 的 root 与 child 请求，通过真实 daemon 读取已存结果，并让不创建 child 的 root 完成。`prime-rlm-terminal` 快照新增 `captured` 场景，经过生产 Loader 和 daemon，只替换模型 provider；其改前与改后的捕获保存在评测报告目录中。共运行 40 个变异定义（36 个编号），各自破坏一条规则，覆盖 runtime、daemon 读取器、策略、Resident 端到端接缝和 API 接缝（生产 Loader 快照，源码模式）。首次运行未检出的有：渲染块的换行连接与 prime-strict 策略文案（各由本改动新增的测试关闭）；Resident 接缝上克隆 parent 的变异、`complete` 变异和去掉 child 会话条件的变异（已被替换，因为前两者在该接缝上等价或该接缝只走已授权路径，并由 runtime 与 continuation 单元对照覆盖）；以及一个只存活一次、后由端到端测试检查每个片段的哈希和 offset 而关闭的片段哈希变异。被替换的定义及其日志保存在评测报告目录中。
