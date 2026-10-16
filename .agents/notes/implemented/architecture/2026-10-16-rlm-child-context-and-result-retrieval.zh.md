# Agent Note：child 以自己的 context 启动，parent 分段读取并校验 child 的结果

Status: implemented

[English](2026-10-16-rlm-child-context-and-result-retrieval.md) | 中文

## 问题

child 的 REPL `context` 过去是其 parent `context` 的克隆，其中的 `task` 是 parent 的完整任务，可能包含全部输入和其他 child 的任务。捕获到的请求显示了三个不同的出现位置。

1. **child 的初始请求**（两条路径）只带有 child 自己的任务，没有受影响。
2. **child 之后的 API 请求。** model worker 把每个 cell 的结果作为同一循环下一次请求中的 tool 消息返回给模型。因此 child 的 cell `JSON.stringify(context)` 的结果回到了 **child** 自己第 1、2 轮的请求里：只出现在 root 任务中的标记和 root 的最后一行，出现在 child 的请求正文中。root 并没有收到这个结果。
3. **Resident child 的 REPL。** 同一个 cell 打印出了 root 的任务。这是 cell 结果，不是 daemon 发给 ResidentClient 的请求字段，所以 Resident 请求捕获里没有它；该 cell 结果单独记录。

初始 prompt 只含 child 的任务，并不能说明 child 之后的模型请求不受影响：它们受到了影响。这是 agent 之间的可见性泄漏。它造成的成本和回答质量影响，以及修复它的效果，均未测量。

parent 也没有读取 child 已存结果的有界方式。`listSubagents()` 去掉了 `outputPreview`，完整结果只存在于模型无法指名的 artifact 中，parent 只能看到 child 自己选择发回的消息。这里没有任何测量说明更大的结果出现过多少次，本 Note 记录的是约定，不是收益。

## 决策

**新 child 的 `context` 是其 parent 的协议键，加上设为 child 自身完整任务的 `task`。** 协议键为 `runId`、`nodeId`、`contextPacketRef`、`capabilityPlanRef`、`graphCertificateHash`、`defaultChildOperatorId`、`defaultChildModel`、`defaultChildTier`。其余一概不复制：不含 parent 的任务，也不含其 cell 存入的值。可信的 child 选择（model、policy）从持久化的会话快照读取，不读 `context`，所以没有决策依赖被去掉的字段；child 需要的材料写进 parent 为它写的任务里。任务从不被缩短。此前接纳的 child 保留其持久化时的 `context`；旧 child 的 `context` 不迁移也不改写。

**`rlm.childSummaries()`** 返回 id、名称、深度、lifecycle、`resultRef`、`error` 和 `preview`：即该 child 记录中 `outputPreview` 的前 200 个 UTF-16 code unit，这是 child 结束时记录的预览，不保证是完整结果文本的前缀。它不含任务和会话目录。`listSubagents()` 不变。

**`rlm.readChildResult(child, { offset, limit, resultRef })`** 读取直接 child 已存结果的一个片段。授权先行，依据是调用者的持久化记录：child 必须是调用会话的 child（否则 `RLM_FAMILY_VIOLATION`），给出的 `resultRef` 必须是该 child 记录里的那一个（同一错误），已删除或已关闭的 child 为 `RLM_UNAVAILABLE`。已接纳或运行中的 child 为 `not_settled`，`indeterminate` 的 child 为 `indeterminate`，没有结果或 host 不持有其结果的 child 为 `not_found`；这些都不会作为空成功返回。之后 daemon 的读取器只在条目是同一 run、节点、child 会话的 `prime-rlm-child-result` 时，才为记录的引用返回已存内容，并逐字段检查这样的条目：非空的 execution id、五种 stop reason 之一，以及 output block 的字段类型（text 或 reasoning block 的 `text` 为字符串；本构建不认识类型的 block 被保留，并按非文本计数）。artifact 存储检查的是内容与引用相符，不检查字段是否合法，所以属于该 child 且已损坏的条目会抛出 `RLM_UNAVAILABLE`，不会被渲染，也不会被报告为缺失或为空。

渲染是把文本块用一个换行连接；非文本块计入 `omittedBlocks` 而不渲染。单位是 UTF-16 code unit；片段不会结束在代理对中间，超出末尾或落在代理对内部的 offset 为 `RLM_INVALID`。结果带有 `segmentSha256`（该片段）、`fullSha256`（完整渲染）、`resultRef`（artifact 引用，是另一个哈希）、`totalUnits`、`complete`、`truncated`、`nextOffset`、`stopReason`、`commandId`、`isData: true` 与文本。因为 cell 记录的输出同时计入返回值与其渲染，对象保持在 `limits.maxOutputBytes` 的三分之一以内。返回片段的读取会追加 `rlm.child.result.read`；`not_settled`、`indeterminate`、`not_found` 的结果和错误不追加事件。`readResult` 是可选的 host 绑定；没有它时该 helper 以 `RLM_UNAVAILABLE` 失败。

**通用策略文案在单独的提交里改动**（策略 `1.5.1`；这一组是：`06d55d6ff6`（第一版文案）、`0e90ada770`（其测试）、`23f582a2d9` 与 `cdb78006ec`（快照哈希）、以及使该建议带条件的 `fd202d16e0`；回退文案需要全部这些提交和对应的 `strategy.spec.ts` 行）。不创建 child 的建议只在任务没有明确要求分工时才是默认选择；明确要求时，在已封存的 child、深度和 turn 限制及能力范围内照办，两种 fidelity 都是如此。它没有给计划增加字段，也没有 `delegation` 设置。

## 考虑过的替代方案

**保留 parent 的 `context` 并隐藏 `task`。** 否决：cell 存入的值仍会带过去，而按字段的拒绝列表对新键是放行的；允许列表则是拒绝。

**把 child 的任务截成尾部。** 否决：child 自己的最后几行带有输出规则，任务保持完整。

**只凭引用授权。** 否决：artifact 存储被所有 run 共用。调用会话的记录指名引用，daemon 再检查存储返回了什么。

**返回完整结果并带截断标志。** 否决：结果可能超过输出上限；带两个哈希的分段让 parent 能校验重组。

**把未知类型的 block 当作损坏。** 否决：block 联合类型是可合并扩展的，读取器本来就把所有非文本 block 计为省略。

## 后果

模型可见的变化有：`typescript_repl` 工具描述的字节（新增两句，说明新的 helper；出现在 API 的工具列表和 Resident 的 bridge 中）、root 请求中的策略指令文本（版本 1.5.1），以及对于此改动之后创建的 child，其之后的 API 请求在 `JSON.stringify(context)` 工具结果里带的是它自己的 context，而不是 root 的。对缓存命中、token、成本和回答的影响未测量。

状态文件格式没有变化：新 helper 读取持久化 children 里已有的 `resultRef`，状态仍是版本 6，旧 child 的 context 不迁移也不改写（状态文件的其他内容照常写入）。新增一种持久化记录：返回片段的读取会向 `state.json` 的 `events` 列表追加一条 `rlm.child.result.read` 事件（child、command、引用、offset、长度、标志位、两个哈希、状态；不含文本）。状态加载只检查 `events` 是数组，不检查事件类型，且 runtime 源码在基线提交中已有 33 个不同的 `rlm.*` 事件类型字符串，所以没有这项改动的构建能加载这样的文件；这是读代码得出的，没有在旧构建上试过。auto-refine 回合会把会话最近 128 条事件放进它的提示，因此这些小记录可能出现在那里。

被封存的 `rlm-runtime`、`rlm-runtime-local`、`rlm-strategy-local` 和 `orchestration-local` 会变化，包含这项改动的 Desktop 发布需要重新封存它们。

## 测试

`child-context.spec.ts` 覆盖允许的键、含最后一行的完整任务、不含 parent 的任务或其存入的值、孙 child 以及持久化会话。`child-result.spec.ts` 覆盖对含代理对和多字节字符的文本做带两个哈希的重组、输出上限、每一种拒绝（另一个会话、猜出的引用、已删除的 child、没有读取器的 host）、未结束、`indeterminate`、失败和没有结果的 child 的状态、范围、混合块的渲染、摘要、事件、读取器发现结果损坏时的错误，以及重启后相同的授权。重启测试在同一个状态文件上创建新的 runtime 并重新绑定 host；它不检验 daemon 或 Resident 自身的恢复。在此改动之前创建的 child，其 `context` 里仍然带有 parent 的任务，有测试断言这一点。`rlm-continuation.spec.ts` 覆盖属于其他 run、节点、child 会话或其他种类的已存条目，以及对属于该 child 的条目：缺失、为空或非字符串的 execution id，缺失或未知的 stop reason，不是列表的 output，以及为 null、没有 type 或字段类型错误的 block。`rlm-strategy-local/tests/strategy.spec.ts` 覆盖两种 fidelity，包括明确要求两个 child 的小任务。

**请求捕获。** fake provider 保存每个请求的原始字节、sha256、到达序号，以及它所回答的 tool call id。Loader 捕获经过生产 Loader、daemon、model worker 和 adapter 到 loopback fake；只替换 provider。它通过 tool-call id 和 runtime 保存的 cell receipt，把每个请求对应到 runtime 记录的会话和 worker command，并用它们核对 tool 结果；请求文本只作为必须一致的核对，无法唯一对应到一次派发的请求会使场景失败，而不是默认算作 child。快照使用的投影只把已知位置上每次运行都不同的值替换为每个不同值一个的带序号 token，任务文本、工具 schema 和策略文本保持原样，并且只有在把值放回后得到原始请求时才通过。Resident 捕获保存 daemon 发给 ResidentClient 的请求中每个可序列化的字段，点名被排除的字段（`signal`）及原因，加入 root 的消息 continuation，并把每个请求对应到 daemon 和 runtime 记录的事件。**它的限度：** 只覆盖 daemon 到 ResidentClient 的调用，不覆盖原生驱动自己的模型请求和工具回合。原始文件、对应关系、投影和逐字段比较保存在评测报告目录中。

**改前与改后。** 改前捕获是提交 `a71f5858` 加一个只含捕获的补丁（新的捕获文件，以及对 driver 和 Resident 测试的改动；补丁还让 continuation 运行一个无关紧要的 cell，因为不发出 tool call 的循环无法对应到生产记录）。与本改动的比较列出了每一处差异，全部符合预期：每个请求里工具描述的字节、root 请求中的策略版本和指令、child 第 1、2 轮的 tool 消息（它自己的 context 而不是 root 的）、continuation 的第二轮（读取结果而不是无关紧要的 cell），以及 Resident child 的 REPL `task`。

**变异。** 最终集合有 72 个变异编号；两轮共运行 80 个定义，各自破坏一条规则（N27、N29、N31 的旧定义在校验和策略文案改写后不再适用：N27 已重新定义，N29 和 N31 已由针对当前文案的对照取代并退役），覆盖 runtime、已存结果的校验、策略、捕获库、Resident 端到端接缝和 API 接缝（生产 Loader 快照，源码模式）。首次运行未检出的，以及各自的结局：渲染块的换行连接和 prime-strict 策略文案（均由测试关闭）；捕获库对“结果指向更晚的请求”和“用可还原的 token 替换工具 schema”的检查（均由测试关闭）；Resident 接缝上克隆 parent 的变异（已替换：因为 child 的 task 随后被赋值，在该接缝上等价；由 runtime 对照覆盖）；Resident 接缝上的 `complete` 变异（已替换；由 runtime 对照覆盖）；Resident 接缝上的片段哈希变异（存活一次，后由检查每个片段的哈希和 offset 关闭）；以及去掉 `childResultFromArtifact` 的 child 会话条件的变异（在 daemon 端到端测试中存活）。对最后一项，后来改成“daemon 传入错误的 child 会话 id”是另一个对照：它最初以 5000 ms 超时让端到端测试失败，现在以断言失败（应为 `settled` 却得到 `not_found`）；它说明 daemon 传入了正确的会话 id，并不说明另一个 child 会话的条目会通过 daemon 被拒绝。该拒绝由 `childResultFromArtifact` 的单元测试覆盖；**没有任何测试让 daemon 端到端地读取另一个 child 会话的条目。** 被替换的定义及其日志保存在评测报告目录中。
