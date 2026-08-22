# 生命周期与核心流程

**简体中文** | [English](../en/workflows.md) | [文档中心](./README.md)

## 每轮上下文

插件会注册稳定的路由指导和动态 runtime-context 贡献：

- `mnemon:routing`：system prompt section；当 `routingGuidance=true` 时提供简短的分层查询边界；
- `mnemon:runtime-memory`：DSH runtime-context snapshot；每次组装模型输入时读取最新 `USER.md` 和 `MEMORY.md`，并附带保存准入规则。内容变化时会追加到消息尾部，不再重写稳定的 system-prompt 前缀。

生命周期 hook 不会在每轮开始无条件读取记忆体目录或执行 recall：

```text
agent/session-start
  -> mark primePending

agent/pre-step(step=1)
  -> cancel pending/running background review for a new turn
  -> mark Prime once
  -> optionally append one short recall/writeback cue
  -> main Agent decides whether to call a memory tool
```

Prime 只初始化路由状态，不执行异步 CLI 状态查询。

## 主 Agent 召回

```text
Root Agent calls mnemon_recall(query)
          |
          v
MnemonSubagentCoordinator
          |
          | spawn + recall persona
          | allow: memory_bodies, recall, related
          v
Recall worker lists the catalog
          |
          v
select active Memory Space(s) by name + description
          |
          v
call mnemon_recall from the worker
          |
          v
MnemonService searches selected Store(s)
          |
          v
normalize and attach memoryBodyId / memoryBodyName
          |
          v
一次性结果工具，Host 校验 schema 并将结果限制为 12 条
          |
          v
Root Agent receives evidence, not the raw routing trace
```

如果用户已经提供当前事实，或仓库可以直接回答，Agent 不应为了“展示记忆”而召回。需要关系解释时，先使用 recall 返回的完整 `memoryBodyId + id`，再执行 related。

## Web 检索和 Agent 查询

Web “检索”页与模型工具路径不同：

```text
Direct search
  -> RPC read channel
  -> MnemonService.search directly
  -> raw evidence

Agent search
  -> the same deterministic direct search
  -> spawn a worker with no Mnemon tools
  -> answer only from supplied evidence
  -> Host filters citations to actual memoryBodyId/id pairs
```

“实体”和“内容”页也直接读取确定性服务，不启动 recall worker。“内容”使用图谱快照，不增加 Mnemon recall 访问计数。

## 显式长期写入

根 Agent 或 `/mnemon remember` 的长期写入流程：

```text
durable candidate
       |
       v
spawn write worker
       |
       +-- list Memory Spaces
       +-- choose the narrowest suitable scope
       +-- recall when duplicate/conflict checking is useful
       +-- create a new scope only for a recurring distinct domain
       +-- remember / link / forget / merge as requested
       v
structured receipt
```

空存储根首次创建 Memory Space 时使用 Mnemon 原生 `default` ID，后续 ID 由 Host 生成。向 inactive 目标写入成功后会激活它。这里的激活只影响 DSH 路由；来源数据库的合并是非破坏性的。

运行时 `add` / `replace` / `remove` 和 Document `create` / `update` 不需要模型做存储 I/O；它们通过 coordinator 进入确定性控制层。容量维护和归档才启动专用 worker。

## Runtime add：正常路径

```text
request
  -> normalize content
  -> acquire in-process queue and file lock
  -> reload memories.json
  -> validate unique match / duplicate / capacity
  -> write temporary JSON and Markdown projections
  -> rename projections
  -> rename memories.json as the commit marker
  -> return compact receipt
```

`replace` 和 `remove` 必须通过 `old_text` 唯一命中一条。容量维护只在 `add` 溢出时自动触发。

## USER.md 容量整理

```text
USER add exceeds 4 KiB
          |
          v
snapshot revision + committed entries
          |
          v
spawn no-tool local compactor
          |
          v
return compacted entries + sourceIndexes
          |
          v
Host validates:
  - every source index appears exactly once
  - no duplicate or out-of-range index
  - importance is not lowered
  - candidate fits the Host byte budget
  - revision is still current
          |
          +-- invalid/conflict -> preserve original data
          |
          v
deterministic UTF-8 packing
          |
          v
retry pending add
```

用户画像不会被发送到 Memory Spaces。worker 没有任何工具权限。

## MEMORY.md 归档与压缩

```text
MEMORY add exceeds 10 KiB
          |
          v
snapshot revision + committed entries
          |
          v
spawn archive worker
  allow: memory_bodies, recall, remember, body_create
          |
          v
route semantic clusters and archive or duplicate-check them
          |
          v
return action + target spaces + compacted candidates
          |
          v
Host validates structure, action, revision and byte budget
          |
          +-- failure/conflict -> preserve hot memory
          |
          v
pack candidates by importance
          |
          v
retry pending add
```

worker persona 要求每条已提交 entry 都被长期表示或验证为重复；这是 LLM 监督策略。Host 的硬保证是结构、revision 和容量验证，不应把语义覆盖描述成数据库级证明。

如果长期写入成功后发生 revision 冲突，热记忆会保留，长期层可能同时已有副本。插件优先避免丢失，不尝试跨数据库和文件系统回滚已完成的 Mnemon 写入。

## Documents 创建、更新和归档

```text
create/update request
          |
          v
capacityPlan using rendered UTF-8 bytes
          |
     +----+----+
     |         |
    fits     overflow
     |         |
     v         v
 commit    select least-recently-used active Document
               |
               v
          snapshot document + revision
               |
               v
          spawn archive worker
               |
               v
       write/verify concise Mnemon cold reference
       with title, summary, planned path, SHA-256
               |
          +----+----+
          |         |
        failed    receipt ok
          |         |
          v         v
   keep active   revision check
                    |
               +----+----+
               |         |
             conflict   current
               |         |
               v         v
          keep active  move file to archived
                             |
                             v
                    retry original mutation
```

人工归档使用同一条“先索引、后迁移”路径。Mnemon 索引已经成功但 revision 冲突时不会回滚索引，因此可能出现安全的重复引用，而不会丢失 active 原文。

## 确定性活动评分和后台审查

完成的 turn 累计四种信号：

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  unique tools < 3  -> 0
  unique tools = 3  -> 1
  unique tools >= 4 -> 2

eligible when score >= 5
```

达到门槛并不代表一定写入：

```text
completed turn
      |
      v
score >= 5 ? -- no --> retain activity for later turns
      |
     yes
      |
      v
wait idleReviewMs (default 30 s)
      |
      +-- new turn --> cancel timer/worker, retain activity
      |
      v
confirm Agent is idle and turn/end exists
      |
      v
fork completed parent checkpoint
      |
      v
conservative maintenance decision
  - at most one hot-memory mutation by persona
  - at most one Document create/update by persona
  - no direct long-term remember/forget tools
      |
      +-- completed, including skip -> clear activity
      |
      +-- failed/aborted ------------> retain activity
```

“最多一次”当前由 worker persona 约束，不是 Host mutation counter。后台水位尚未持久化，Host 重启会丢失未处理的累计信号。

## 配置开关的关系

- `recallMode=off`：不再注入 recall cue，显式 `mnemon_recall` 仍可用。
- `writebackMode=off`：关闭写回 cue 和评分后台审查，显式写入仍由 `writeEnabled` 决定。
- `lifecycleEnabled=false`：关闭生命周期提醒和审查，不移除显式工具或 Web 入口。
- `routingGuidance=false`：只移除额外路由 section；Runtime Memory context 仍注册。
- `writeEnabled=false`：移除语义写工具和写 RPC，拒绝写命令；它不是文件系统只读挂载保证。
