# @deepseek-ai/dsh-host-remote-auth

[English](README.md) | 中文

DSH 远程 Frontend 的 Server 权威认证插件。该插件提供 `ctx.remoteAuth`，并且是一次性配对挑战、持久设备凭据、短期访问会话、固定 `cockpit`／`pocket`／`admin` 范围、撤销状态和无正文命令回执的唯一写者。持久状态位于 `$DSH_HOME/remote-auth/v1`；设备凭据仅在首次返回给调用方后以密码学摘要表示，访问令牌则只存在于进程内并自动过期。

该包刻意采用很小的产品词汇，而不是建设通用 RBAC 框架。connection 载体使用得到的 principal 对投影和命令流量进行认证；orchestration 使用同一个 principal 限制远程控制。远程命令以 `deviceId + commandId` 接受，只保存规范化请求哈希；重试时会返回已经结算的有界响应、报告冲突，或在已接受操作被中断后保持 indeterminate 隔离状态。

## 模型体验

无，因为这个 Server 认证权威不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；认证和命令回执始终位于模型上下文之外。

## 已知限制与暂缓事项

- 配对有意限定为本地一次性操作；远程管理配对和组织级身份提供方不属于 v1。
- 持久状态使用仅所有者可读写的 JSON 文档和一个 Server 写者；不支持多权威复制。
- 产品范围固定。新增远程界面必须显式修改协议和授权规则，不能通过用户自定义角色隐式扩展。
