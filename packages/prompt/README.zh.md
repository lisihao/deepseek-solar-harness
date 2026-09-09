# prompt/ — 用户管理的提示词指导

[English](README.md) | 中文

这一组产品插件负责保存、选择、注入和管理任务级提示词模板，不修改 agent loop（智能体循环）。

| 包 | 职责 | ctx key |
|---|---|---|
| [`task-template/`](task-template/README.zh.md) | 模板 Service Definition、确定性选择器与私有文件 Provider | `ctx.taskTemplates` |
| [`task-template-context/`](task-template-context/README.zh.md) | 直接 Agent 请求 Consumer | — |
| [`task-template-rpc/`](task-template-rpc/README.zh.md) | 经认证的 Host 管理 RPC | — |

可复用方法层与可选的个人偏好／记忆层共同保存在 DSH 私有数据根目录下，但分别进行版本管理。Consumer 会记录精确的选择回执，使模型可见指导可以重建，而无需把私有数据复制到源码仓库。
