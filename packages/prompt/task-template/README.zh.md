# @deepseek-ai/dsh-task-template

[English](README.md) | 中文

任务级提示词模板的 Service Definition、确定性选择器与文件 Provider。用户可以定义可复用方法及匹配任务特征；Consumer 通过 `ctx.taskTemplates.select()` 选择最合适的启用模板，但模板不会授予工具、权限或执行权威。

## 存储与配置

默认文档为 `<DSH_HOME>/task-templates.json`；未配置主目录时使用 `~/.dsh/task-templates.json`。Provider 以 `0700` 创建父目录，并以 `0600` 原子写入文档。它绝不会读取仓库或工作目录中的模板文件。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | 解析后的 DSH 主目录 | 未提供 `path` 时使用的私有数据根。 |
| `path` | `<dshHome>/task-templates.json` | 显式 JSON 文档路径。 |

每次读取都会校验完整文档、格式版本、唯一 ID、完整修订历史、匹配字段与个人层。损坏或不受支持的文档会阻止启动，而不会被替换。

## 服务

`ctx.taskTemplates` 提供 `list`、`get`、`versions`、`personalization`、`create`、`update`、`setEnabled`、`delete`、`personalize` 和 `select`。修改方法层会归档上一份完整修订并递增版本；启停和个人层修改不会改变方法版本。写入按顺序执行，只有原子持久化成功后才对读取方可见。

选择器先过滤所有已启用且声明字段全部允许当前任务的模板，再依次按约束维度数量、显式权重、名称和 ID 排序。显式模板 ID 会覆盖自动排序，但未知或停用模板仍会报错。没有匹配项时返回 `skip`，系统不会注入通用兜底模板。

匹配字段包括任务类型、领域、目标关键词、输出格式、风险、必需工具、必需技能、算子、语言和优先级。这些字段只用于选择指导内容，不能授权工具、提升沙箱权限或改变已选算子。

方法可以使用 `{{objective}}`、`{{taskType}}`、`{{domain}}`、`{{outputFormat}}` 和 `{{language}}`。渲染只执行一遍，并拒绝格式错误、未知或无值变量。每次选择都会在可序列化回执中记录精确渲染层、内容摘要、候选顺序、任务属性与理由。

## 模型体验

本 Service Definition 自身不添加模型消息。模型可见注入分别由 [`dsh-task-template-context`](../task-template-context/README.zh.md)、TaskGraph、Debate 与物理算子分发 Consumer 负责。

#### Token 影响

Consumer 选择并注入模板前没有影响。

#### KV Cache 影响

本包不会直接改变缓存。传输允许时，Consumer 会把所选指导追加在可复用请求前缀之后。

## 已知限制与后续工作

- 任务属性推断归 Consumer 所有且采用确定性规则；本包不会再调用一个模型分类任务。
- 尚无模板导入／导出或跨设备合并操作。远程 Frontend 通过经认证的 RPC 管理所选 Server 的私有存储。
- 个人内容依赖本地文件权限保护，尚未提供应用层加密。
