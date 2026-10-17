# Agent Note: 可信独立 RLM 的执行所有权

Status: proposed

[English](2026-10-17-trusted-standalone-rlm-ownership.md) | 中文

## 问题

独立 RLM 入口必须保留原始分析输入并遵守既有执行限额，不能另建 Scheduler，或对同一工作向包装层重复计量。Agent 注册表中的存活记录不能单独证明嵌入 Host 已授权该 Agent；逻辑节点完成也不能证明所有物理请求已经结算。

## 提案

既有编排 daemon、持久存储、共享 RLM 执行核心和 WP1 计量继续作为唯一执行所有者。Provider 只有在物理算子注册成功后，才发布绑定到该实例的 Host 注册能力。Host 注册自己 create/resume 实际返回且仍存活的精确 root，并提供带版本的明确驱动与执行策略。首个组合在每个 Cordis context 中只拥有一个包装绑定，仅接纳 ephemeral、只读文本分析和一个已认证的叶节点。

将准备好的工具调用绑定到 Agent 实例、执行 id、不可变完整输入、取消信号、策略版本及撤销状态；就绪后及发送前立即复核。默认发现不授予资格。Host 或 Provider 释放时撤销授权，并要求 daemon 在根选择、子委托、继承计划和恢复中持续使用明确的包装算子排除清单。

在异步编译前持久化接纳状态，每条命令仅关联一个业务 run。原始嵌套 JSON 序列化与完整输入的规范化指纹分别保留，避免持久化往返改变既有上下文 envelope 摘要。完全相同的重复命令只观察原效果；冲突输入拒绝。重启封锁未解决的命令，不重建或重放。

投影任何观察结果或请求取消前，核对预期完整命令指纹。daemon 明确证明未接纳的拒绝与传输结果未知分别保留。在 Scheduler、Host 重新绑定、重新连接和物理派发入口封锁恢复后的独立 run；普通 TaskGraph 的恢复保持不变。

为每个实际 API 请求或精确 Resident turn 跟踪终态证据。注册表在调用 Provider 前拒绝时，将命令结束为已知未派发。业务重试分类前，将未知物理效果标为 indeterminate。物理结算得到确认前，同一命令、结果、释放及外层容量保持未决；daemon 关闭仅脱离本地持有者。包装层返回完整结果并省略重复 usage；缺失 usage 仍为未知。上下文 envelope 以原始 JSON 文本存入带版本的 artifact，避免 CAS 规范化序列化使其既有摘要失效。

## 考虑过的替代方案

**独立的 standalone 调度器与 usage 台账。** 这会形成相互竞争的执行和结算所有者，并允许限额偏离 TaskGraph 执行。

**从注册表发现推断调用资格。** 这会在缺少所属 Host 明确授权时，授权无关 root 和子 Agent。Loader 并发挂载条目，因此 YAML 顺序也不能证明 Provider 就绪。

**使用规范化 JSON 持久化 envelope。** 规范化排序适合比较完整输入，但重排嵌套 envelope 会使其既有摘要失效。应保留收到的表示，并在读取时重新校验。

## 验收标准

真实 Loader 的源码及构建库组合必须经过 Host、physical_operator 工具、daemon、存储、Scheduler 和生产 DeepSeek worker，仅将外部传输替换为假实现。测试必须拒绝未授权或子 Agent、被修改的输入、已撤销授权、显式包装自选、重复效果、重启未决及未知请求重试。Provider 延迟注册时不得提前创建 root；卸载后旧授权必须失效。通过必需源码检查及独立审查后，才能接受本切片。

## 风险

owner-local IPC 共享信任域，不能独立证明跨进程 Agent 存活。外部结算未知时可能持续占用容量，不会静默释放或重试。ACP、通用 CLI 和 Desktop Host 接入仍是后续工作；keyless 集成不能证明代表性任务性能、付费 Provider 行为、远程 CI 或已安装可用性。
