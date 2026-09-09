# @deepseek-ai/dsh-task-template-rpc

[English](README.md) | 中文

`ctx.taskTemplates` 的经认证 Host RPC 管理 Consumer。`/task-templates` 通道向可信 cockpit/admin 客户端提供列表、新建、更新、启停、删除、个性化与预览操作。每次修改都会返回新的权威快照。

RPC 会先校验精确 payload 键和全部不可信任务属性，再调用类型化 Service。它使用 `trusted-host` 权威注册；匿名局域网来源与 pocket scope 无法读取个人模板。

## 模型体验

本包不贡献模型可见内容，也不会调用模型。

#### Token 与 KV Cache 影响

无。

## 已知限制与后续工作

- 快照以完整列表传输，尚未分页。
- 冲突控制依赖 Host Service 的串行写入；RPC 尚未暴露独立的修订前置条件。
