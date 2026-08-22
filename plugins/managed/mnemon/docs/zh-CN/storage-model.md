# 存储与三层记忆模型

**简体中文** | [English](../en/storage-model.md) | [文档中心](./README.md)

## 为什么是三层

一种存储形态无法同时满足“每轮都可见”“保留完整叙事”和“长期图增强召回”：

| 问题 | 对应层 | 原因 |
|---|---|---|
| 下一轮必须直接知道什么？ | Runtime Memory | 极小、直接进入 prompt |
| 哪份设计或流程需要快速完整阅读？ | active Documents | 保留 Markdown 结构，不必做深召回 |
| 哪些历史事实和关系应跨会话存在？ | Memory Spaces | 独立数据库、图关系、按需召回 |
| 长文已不常用但仍需追溯怎么办？ | archived Documents | Mnemon 留索引，冷层保留原文 |

推荐查询梯度：

```text
current request and repository facts
             |
             v
Runtime Memory already in prompt
             |
             v
search active Documents
             |
             v
recall active Memory Spaces
             |
             v
follow an exact cold reference when full text is required
```

## 统一根目录

```text
<storageRoot>/
+-- runtime/
|   +-- memories.json
|   +-- USER.md
|   +-- MEMORY.md
+-- documents/
|   +-- index.json
|   +-- active/
|   +-- archived/
+-- data/
|   +-- .dsh-memory-bodies.json
|   +-- <memory-space-id>/
|       +-- mnemon.db
+-- state/
    +-- memory-providers.json     # 第三方连接控制面，0600，不进入 Mnemon Pack
```

`storageScope` 决定整个根，而不只是 Mnemon 数据库。`workspace` 范围会为每个已登记 DSH 工作区解析独立的 `<workspace>/.mnemon`；Web 查看目标与当前会话执行目标彼此独立，只有后者会驱动 Agent、工具和生命周期。`state/memory-providers.json` 保存第三方 endpoint、目标 URI、身份和可选 API Key；文件权限为 `0600`，Host 返回 WebUI 时只暴露“是否已配置”，不回传密钥。

## Runtime Memory

### 语义

- `target=user`：身份、角色、长期偏好、习惯、沟通风格和明确协作要求。
- `target=memory`：项目、环境、决策、约定、工具特性和可复用经验。
- `importance=critical|normal|low`：用于整理时的保留优先级。

当前不实现 `daily` target。

### 事实源和投影

`runtime/memories.json` 是唯一事实源。每条记录包含：

```text
content
created_at
updated_at
target
importance
```

`USER.md` 和 `MEMORY.md` 是确定性派生文件。每个条目被归一成单行，条目之间使用单独一行的 `§` 分隔；`§` 是保留字符。启动和 prompt 组装时，控制层会从 JSON 修复缺失或被手工修改的投影。

### 操作

- `add` 写入独立新事实，完全相同的内容不会重复添加。
- `replace` 用 `old_text` 的唯一子串定位并替换整个条目。
- `remove` 用唯一子串移除整个条目。
- 零命中或多命中都拒绝，不执行模糊修改。

### 容量

| 目标 | 上限 | 维护方式 |
|---|---:|---|
| `USER.md` | 4 KiB | 本地、无工具 worker 保守合并，不进入 Memory Space |
| `MEMORY.md` | 10 KiB | worker 先归档已提交内容，再返回压缩候选 |

容量按投影正文的实际 UTF-8 字节计算。单条内容最大 8 KiB。自动容量维护只由溢出的 `add` 触发；导致溢出的 `replace` 会直接报错，调用方应先显式整理。

## Project Documents

### 用途

Documents 保存比单条记忆更完整、又希望快速阅读的项目知识，例如：

- 架构设计和理由；
- 有证据的调查结论；
- 操作流程、发布清单和故障复盘；
- 实现交接与长期维护说明。

用户画像、普通聊天、临时进度、原始大日志和秘密不应进入 Documents。

### 控制面

`documents/index.json` 是元数据事实源，管理 ID、标题、description、状态、文件名、来源路径、session、时间、revision、SHA-256、大小和 Memory Space 引用。Markdown 托管副本带有生成的 frontmatter。

`sourcePaths`：

- 只能指向当前会话工作区内部；
- 只作为来源引用，不会被插件修改；
- 当前实现不要求路径实际存在；
- 不允许指向受管 `documents/` 目录自身。

### 范围

Documents 的物理共享范围由 `storageScope` 决定：

- `workspace`：通常随项目隔离；
- `global` / `custom`：多个工作区可能共享同一个 `documents/index.json`。

因此“项目档案”表示内容类型，不保证天然按工作区物理隔离。当前会话工作区只约束新写入的 `sourcePaths`。

### 容量与冷热分层

| 项目 | 限制 |
|---|---:|
| 单份正文 | 最大 2 MiB |
| active 总量 | 最大 10 MiB，包含生成后的 frontmatter |
| archived 总量 | 不计 active 上限 |

创建或更新前会计算真实投影大小。空间不足时按 `lastAccessedAt`、再按 `updatedAt` 选择最久未访问的 active 文档；先写入/验证 Mnemon 冷引用，再在 revision 未变化时迁移原文。

默认搜索只覆盖 active。搜索会更新命中文档的 `lastAccessedAt`，因此它对正文只读，但会写索引元数据。

## Memory Spaces

记忆体是第三层统一语义与路由单位，具体数据面由 Provider 决定：

```text
id            Host 生成或沿用已发现的 Mnemon Store 名
name          人类可读名称
description   路由边界：什么属于这里、何时召回
active        是否参与 DSH 读取与路由
provider      mnemon-native 或已登记的三方引擎
location      本地 Store/CLI 作用域，或远程 endpoint + Provider 作用域
```

### 读写边界

- Mnemon 原生层在初始化后至少保留一个 Store，并通过 `<storageRoot>/active` 选择一个默认 Store；普通 Mnemon Agent 仍按这套单 Store 语义工作。
- dsh-mnemon 的激活状态是独立控制面：任意 0..N 个记忆体可以激活，全部未激活也不会改变 Mnemon 默认 Store 或远程数据。
- 召回与浏览只使用已激活记忆体；图谱、实体、关联、链接和删除由 Provider 能力决定。
- 指定未激活记忆体进行读取会被拒绝。
- 写入可以选择任何支持 `remember` 的已登记记忆体；回执会反映 Provider 的精确写入或异步提炼语义。
- 对未激活目标写入成功后，插件自动激活它。
- 没有显式目标且激活数量不是 1 时，确定性服务要求调用方先选择目标。

### 创建、发现和合并

- 未初始化的空根可以保持零 Store；第一次显式创建记忆体时使用 Mnemon 原生 `default` ID，名称与路由说明仍由用户决定，后续创建使用 Host 生成的 UUID。
- 初始化后不能删除最后一个原生 Store，但可以将最后一个记忆体设为未激活。删除 Mnemon 默认 Store 时，插件会先切换到另一个现存 Store。
- 既有 `<storageRoot>/data/<store>/mnemon.db` 会被发现并登记，不移动数据库。
- 合并通过 Mnemon import 把来源内容导入目标；来源数据库保留，默认只将来源设为未激活。
- Pack 替换不能把已初始化的 Store 集合清空；替换后若原默认 Store 已不存在，插件会选择一个现存 Store 修复原生默认指针。
- `forget` 是按精确 ID 的软删除，不等于删除数据库文件。
- 用户可在既有“创建记忆体”弹窗选择 Mnemon Native 或任意已登记三方引擎，也可在智能模式中显式加入已配置候选；断开只删除本地连接登记，不删除 Provider 数据。
- 智能 placement 的允许列表、数据边界与必需能力是 Host 强制规则；软偏好与 Prompt 只用于多个合格候选之间的语义选择，不能绕过硬规则。决策回执与记忆体元数据一起保存。
- 合并仍只适用于 Mnemon Native。图谱、关系、浏览、精确/异步写入以及硬/软/不支持删除都以各 Provider 声明能力为准；UI 与 Agent 不会假装补齐缺失行为。见 [Provider 能力矩阵](./memory-providers.md)。

### 跨 Agent 可见性

`mnemon.db` 是 Mnemon 原生数据面，不是 dsh-mnemon 私有格式。其他 Mnemon-enabled Agent 在使用同一个 `storageRoot` 和 Store 时，可以访问同一份长期记忆。dsh-mnemon 也会发现磁盘上兼容的 Store；其 DSH 专有名称、说明和激活状态仍由 `.dsh-memory-bodies.json` 管理。

三方可见性由各自 Provider 作用域决定，例如服务与 URI、workspace/peers、bank、project/user、知识目录或 container。任何 Provider 的共享都不延伸到 `runtime/` 或 `documents/`；不能把“共享第三层记忆”表述为自动共享完整 DSH 上下文。

## 四类关系

Mnemon Native 保留 `temporal`、`semantic`、`causal` 和 `entity` 关系；Hindsight 投影 Provider 图谱，Holographic 生成本地实体/语义关系。没有图谱边的 Provider 只贡献有界无边节点，适配器不会伪造关系。记忆体页会按能力隐藏不适用的关联、链接、浏览与遗忘动作。

## 数据权威表

| 数据 | 权威源 | 派生/缓存 |
|---|---|---|
| 热记忆 | `runtime/memories.json` | `USER.md`、`MEMORY.md` |
| Documents | `documents/index.json` + 托管 Markdown | excerpt、搜索排序、状态聚合 |
| Mnemon Native 目录 | `data/.dsh-memory-bodies.json` + 磁盘 Store | Web 状态聚合 |
| 第三方 Provider 连接 | `state/memory-providers.json` | 脱敏的 Provider 能力与状态 |
| 长期记忆 | Mnemon `mnemon.db` 或远程 Provider | 图谱投影、跨 Provider 排名融合 |
| 审查水位 | Host 进程内存 | 状态页快照；尚未持久化 |
