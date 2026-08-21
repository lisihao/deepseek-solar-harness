# @deepseek-ai/dsh-continual-harness-local

[English](README.md) | 中文

`ctx.continualHarness` 的所有者本地持久 Provider。它只在编排 daemon 根目录保存有界结果摘要、标签和 Evidence 引用，不保存原始 prompt、完整对话、凭据或模型私有状态。

快照按作用域过滤、版本化、内容寻址，并在封存到节点 Attempt 后保持不可变。
