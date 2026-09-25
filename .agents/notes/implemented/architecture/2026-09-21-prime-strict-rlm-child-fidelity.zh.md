# Agent Note: Prime-strict RLM child fidelity

Status: implemented

[English](2026-09-21-prime-strict-rlm-child-fidelity.md) | 中文

## Problem

显式选择的 RLM 运行要求其 Child 使用 Parent 已选定的 operator、model、reasoning preference、工具权威、受管 Skill、retry rule 和 context reference。通用 Child 分配、实时 Skill 查询或环境中的 Resident 工具面，都会在 Root 已准入后改变该执行。已验收的 TaskGraph template/context receipt 与 first-class DSH tool authority 仍属于普通执行，不能因只适用于 RLM 的规则而被削弱。

## Decision

`prime-strict` 密封 `parent-inherit`：省略 Child model 时，Child 使用 Root 的完整选择并记录 `parent-inherited`。`dsh-optimized` 显式密封 `allocator-default` 并记录该 origin。显式 Child model 或 thinking preference 会在原生 Child 派发前根据当前 physical-operator catalog 校验。

RLM Root 以 TypeScript REPL bridge、Host 签发的受管 Skill binding、已解析 retry policy 和 capability-context reference 密封 `RlmChildExecutionOptionsV1`。Local Kernel 对 `rlm()` 只接受 `name`、`model` 和 `thinking`。它向模型暴露精简的 Skill descriptor，将 binding 保留在模型可见结果之外，并把同一个 binding 交回 Host 执行 `skills.call`。

RLM Resident turn 使用带有唯一 `typescript_repl` 的 `native_tool_policy: disabled`。Resident daemon 会拒绝该模式下的其他 bridge 扩展。普通 Resident turn 保留已验收的 `dsh-tools-authoritative` 路由和 task-context receipt 处理。

本决定实现了[完整 Prime Runtime 提案](../../proposed/architecture/2026-08-24-prime-agent-compatible-typescript-runtime.md)中的 strict-child 行，不宣称该提案尚未实现的行。

## Durable upgrade and rollback

`@deepseek-ai/dsh-rlm-runtime-local` 写入 version 5 store。加载版本 1 至 4 时会转换 legacy Child origin，把没有可证明 result 的 settled receipt 保留为 `indeterminate`，且不再派发该 receipt。Constructor 观察到迁移后，会在注册 live runtime owner 之前持久化 version 5。

旧 Provider 不读取 version 5。要回滚拥有 legacy state file 的机器，必须在启动旧 binary 前恢复其私有 pre-upgrade backup；升级后的 state 不是降级格式。

## Verification

聚焦 Runtime 测试覆盖版本 1 至 4、strict inheritance、sealed Skill binding 以及不重放的 indeterminate recovery。Keyless TaskGraph E2E 覆盖 strict Child inheritance、原生派发前拒绝显式不兼容 thinking、optimized allocator 路由和保留的 RLM bridge。Keyless runnable-example snapshot 记录由 Loader 挂载的 strict-child 输出。

## Alternatives considered

**为每个省略 model 的 Child 使用 allocator 选择。** 不采纳，因为显式 Prime RLM 会静默使用不同的原生 profile。

**每次调用都从实时 Harness catalog 解析受管 Skill。** 不采纳，因为后续更新会改变已准入 Root 的可执行权威。

**在 disabled RLM turn 中允许完整 DSH bridge。** 不采纳，因为 `disabled` 无法再把 RLM 原生权威限制到其 TypeScript REPL。

**把 disabled policy 应用于每个 Resident turn。** 不采纳，因为普通 E13 路由保留已验收的工具权威和 task-context 行为。

## Consequences

Trace 区分 Child inheritance 与有意的 economy selection。显式 RLM 获得有界的 Prime-compatible execution subset，Standard 与 first-class DSH tool 路由保留已验收的行为。持久化迁移有意单向，因此部署会保留私有 state backup 以供 rollback。完整 Prime compatibility matrix 仍由其提案记录管理。
