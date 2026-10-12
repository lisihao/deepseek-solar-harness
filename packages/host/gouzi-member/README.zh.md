# @deepseek-ai/dsh-host-gouzi-member

[English](README.md) | 中文

为一只狗子执行成员提供 `ctx.gouziMember` 的 Provider。Service Definition 是 `@deepseek-ai/dsh-client-connection` 中的 `GouziMemberService`，由 Remote Sync 的 `gouzi` 范围消费。本包保存成员身份，批准或拒绝每一份执行授权，并维护持久的幂等账本。它是 `<stateRoot>/gouzi/identity.json` 与 `<stateRoot>/gouzi/ledger.json` 的唯一写者，两者都仅限属主访问。

主实例用 `provisionGouziIdentity` 一次性写入身份：`gouziId`、`ownerId`、`hostId`、`generation`，以及配对时生成的 `authorityEpoch`。没有身份的成员启动时直接失败，不会接受见到的第一个连接。已有身份不会被替换，所以重新配对是之后的显式操作，而不是覆盖。

`admit` 在物化工作区或启动 Resident 轮次之前运行。它依次拒绝：另一只成员、另一个 generation、另一个权威纪元，以及 `gouziRequestHash` 与授权 `planHash` 不一致的请求。随后按执行 ID 查询账本。相同 ID 与相同哈希返回已存的 accepted 回执；如果更早的尝试已被批准但从未记录回执，则返回 `new`；相同 ID 但哈希不同为 `GOUZI_EXECUTION_CONFLICT`。只有新的执行才检查授权 `deadline`，因此重连的主实例在截止时间之后仍可对账已接受的执行。`recordAccepted` 保存主实例收到的回执。每次启动会让 `incarnation` 计数加一，由 `gouzi.hello` 返回。

配置：`stateRoot`，成员的绝对状态根目录。

## 模型体验

无，因为这个执行成员闸门不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；身份检查和账本始终位于模型上下文之外。

## 已知限制与暂缓事项

- 授权中的 `scopes` 与 `credentialRefs` 已解析并携带，但尚未对文件或效应访问强制执行；第一版依赖干净提交的工作区和 Resident 算子自身的工具策略。
- 重新配对（生成新的权威纪元）与退役成员尚未实现，都属于后续阶段。
- 账本是每次变更都整份写入的单个 JSON 文档，按第一版每只成员同时一个活跃任务来设计，不适合高频写入。
