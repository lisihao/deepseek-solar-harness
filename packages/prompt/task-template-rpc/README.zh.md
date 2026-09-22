# @deepseek-ai/dsh-task-template-rpc

[English](README.md) | 中文

`ctx.taskTemplates` 的经认证 Host RPC 管理 Consumer。`/task-templates` 通道向可信 cockpit/admin 客户端提供列表、新建、更新、启停、删除、个性化与预览操作。每次修改都会返回新的权威快照，使执行多个操作的编辑器可以保留之前每个已提交结果；预览会返回确定性的显式选择及其渲染内容层。

RPC 会先校验精确 payload 键和全部不可信任务属性，再调用类型化 Service。它使用 `trusted-host` 权威注册；匿名局域网来源与 pocket scope 无法读取个人模板。

## 模型体验

### 管理 RPC

#### 模型看到的内容

RPC payload 和响应不会进入模型请求。修改操作会改变私有模板数据；`@deepseek-ai/dsh-task-template-context` 可能在后续逻辑任务中注入这些数据。

#### Token 影响

列表、修改和预览请求不会直接增加 token，也不会调用模型。只有 `@deepseek-ai/dsh-task-template-context` 选中修改后的模板时，该修改才会影响后续 token。

#### KV Cache 影响

RPC 处理不会修改进行中请求的前缀。修改操作可能改变后续任务选中该模板时的注入前缀。

## 已知限制与后续工作

- 快照以完整列表传输，尚未分页。
- 冲突控制依赖 Host Service 的串行写入；RPC 尚未暴露独立的修订前置条件。
