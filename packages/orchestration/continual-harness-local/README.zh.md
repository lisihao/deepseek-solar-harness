# @deepseek-ai/dsh-continual-harness-local

[English](README.md) | 中文

`ctx.continualHarness` 的所有者本地持久 Provider。它只在编排 daemon 根目录保存有界结果摘要、标签和 Evidence 引用，不保存原始 prompt、完整对话、凭据或模型私有状态。

快照按作用域过滤、版本化、内容寻址，并在封存到节点 Attempt 后保持不可变。

## 模型体验

本 Provider 通过为当前节点选出的有界条目间接影响模型。

#### KV 缓存影响

改变选中条目会改变已封存节点的请求前缀；原始历史 Turn 不会进入该前缀。

## 已知限制与后续工作

- 首发是由 `dsh-orchestratord` 使用的所有者本地单写存储。
- 分布式复制和生产级胶囊目录后置。
