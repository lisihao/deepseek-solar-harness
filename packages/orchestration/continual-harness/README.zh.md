# @deepseek-ai/dsh-continual-harness

[English](README.md) | 中文

与 Provider 无关的 Continuous Harness seam。它为 TaskGraph 节点生成有界快照，并管理版本化 prompt 补充、记忆、TypeScript Skill 和子代理定义；它不是另一套 Scheduler、模型 Provider 或对话存储。

受管条目通过乐观并发控制作用于会话本地、工作区或用户全局作用域。未显式指定作用域的读取会按 `session` → 规范化 `workspace` → 用户全局的顺序叠加；较窄作用域中相同 entry id 会遮蔽较宽作用域，而显式作用域仍然只读取该作用域。未显式指定作用域的写入继续落在会话本地。全局作用域在所有者的 DSH home 下拥有唯一稳定身份，因此同一条目可以跨仓库可见，不必复制进任一工作区。Refinement 规划不修改生效中的 Harness；应用只在声明的 Turn 边界发生，逐项独立报告编辑结果，并仅记录成功项以供显式回滚。不可变 base prompt 不能被修改。

Scheduler 只消费不可变快照，并在结算后记录有界 Evidence 引用。

可执行 TypeScript Skill 使用同一能力包中的第二个插件注册表。可信 Provider 注册带版本的模块和明确的 callable；受管 Harness 条目只向 RLM 暴露安全 alias 与参数契约。模型不能提交包路径，Provider 不可用时会明确失败，不会把条目文本冒充成可执行能力。

## 模型体验

无直接影响，因为本 seam 不直接贡献模型可见内容。

#### KV 缓存影响

只有封存到节点的有界 Continuous Harness 条目会改变该节点的请求前缀。

## 已知限制与后续工作

- 快照在一个已封存节点 Attempt 内固定；后续 Harness generation 只影响后续 Attempt。
- Turn 中修改及跨机器同步后置。
- 基础 Bundle 只提供注册表和调用边界，不内置生产 Skill 目录；Skill Provider 仍作为可独立安装插件交付。
