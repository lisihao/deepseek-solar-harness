# @deepseek-ai/dsh-continual-harness-local

[English](README.md) | 中文

`ctx.continualHarness` 的所有者本地持久 Provider。它在编排 daemon 根目录保存显式受管 Harness 条目、有界结果摘要、标签和 Evidence 引用；它不采集原始用户 prompt、完整对话、凭据或模型私有状态。

快照经过版本化、内容寻址，并在封存到节点 Attempt 后保持不可变。未显式指定作用域的读取会按规范化的 session、workspace 和所有者本地 `global` 顺序叠加；较窄作用域中相同 entry id 会遮蔽较宽作用域，而显式作用域读取仍然精确。会话与工作区身份继续彼此隔离，而所有使用同一 DSH home 的仓库共享所有者本地 `global` 身份。Refinement 逐项独立应用有效编辑，为被拒绝编辑保留结构化失败，并且只为成功编辑持久化 before-image。回滚创建后续 generation，并可跨 Provider 重启执行。

## 模型体验

本 Provider 通过为当前节点选出的有界条目间接影响模型。

#### KV 缓存影响

改变选中条目会改变已封存节点的请求前缀；原始历史 Turn 不会进入该前缀。

## 已知限制与后续工作

- 本 Provider 是由 `dsh-orchestratord` 使用的所有者本地单写存储。
- 分布式复制和跨机器 Harness 同步后置。
