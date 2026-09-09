# @deepseek-ai/dsh-client-ui-task-template

[English](README.md) | 中文

任务提示词模板库的设置页 Consumer。它通过经认证的 `/task-templates` RPC 通道展示 Server 权威模板目录、方法编辑器、匹配属性、启停状态、修订数量，以及独立的个人偏好／记忆字段。

编辑器不会把私有内容写入浏览器存储或源码配置。Remote Frontend 切换连接目标后，修改会作用于所选 Server 的 DSH 私有主目录。

## 模型体验

本 UI 不调用模型。只有后续逻辑任务的执行 Consumer 选择模板后，保存内容才会对模型可见。

#### Token 与 KV Cache 影响

浏览或编辑时没有影响。

## 已知限制与后续工作

- 匹配值目前使用逗号分隔文本框，而不是带目录的标签选择器。
- 页面会显示修订数量，但尚不能比较或恢复历史修订。
