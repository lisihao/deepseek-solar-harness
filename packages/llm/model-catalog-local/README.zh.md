# @deepseek-ai/dsh-model-catalog-local

[English](README.md) | 中文

用于帐户观测模型菜单的本地 SQLite 目录服务。它拥有 `ctx.modelCatalogs`，保存发现结果，但不保存凭据、提示词，也不发送模型请求。

## 服务

- `register(source)` 添加一个活动 source（来源）并返回其 disposer（释放器）。每个 source 拥有一个既有 DSH dispatch provider（分发提供方），其返回的每个模型都必须使用该提供方。
- `list()` 只读取活动 source 的持久化快照，从不调用 source；source 被释放后会从该读取中移除，但其持久化行仍会保留。
- `refresh(sourceIds?)` 刷新所有活动 source 或指定子集。同一 source 的调用会合并，收到 abort signal（取消信号）和已配置的 deadline（截止时间），并分别返回每个 source 的 ready（就绪）、unavailable（不可用）或 error（错误）快照。

## 配置

- `databasePath` 为必填项。测试可使用 `:memory:` 进程内数据库，持久化目录可使用文件系统路径。
- `refreshTimeoutMs` 默认是 15,000 ms。即使 source 忽略取消，它也无法在刷新竞争结束或注册释放后写入。

## 持久化与刷新

成功的 source 结果在一个 SQLite 事务中写入。当前快照会在 `model_order` 中保留上游 `models` 顺序，未出现在该结果但保留的 id 排在其后。显式不可用结果会把其诊断记录在 `snapshot.error` 中，并将保留模型标为 unavailable（不可用）。抛出的结果会记录 source error（错误），将保留模型改为 `unknown`（未知），并保留原有 `lastSuccessAt`。只有带本包 SQLite 身份的 schema version 1 能打开。

## 模型体验

### 目录记录

#### 模型看到的内容

无。`ctx.modelCatalogs` 保存主机侧 selector（选择器）元数据，不添加提示词文本、工具、schema 或消息。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无。目录读取和刷新不会改变模型请求前缀。

## 已知限制与暂缓事项

- **没有刷新调度器** — 消费方决定何时调用 `refresh()`；本包不会自行轮询帐户。
- **没有 schema 迁移** — 较新或无效的目录介质会在打开时拒绝，不会原地修改。
