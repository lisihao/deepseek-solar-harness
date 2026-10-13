# Agent Note：在同一个 DSH 会话内切换模型和强度，并控制初始上下文体积

Status: proposed

[English](2026-10-13-same-session-model-switching-and-context-reuse.md) | 中文

## Problem

用户希望留在同一个 DSH 会话里，工作内容变了就换模型或推理强度，并且每个模型都知道别的模型活跃期间发生了什么，同时不要每次请求都重复付同样的提示词成本。对已安装的 3.41.0 做的审计，加上对 3.42.1 源码的设计核对，找到三个缺口。

- **原生 lane 锁死首个 profile。** Resident 的 Codex 或 Claude 会话被锁在首个被接受命令的模型和强度上。明确选择另一个配置会被 `EXECUTION_PROFILE_CONFLICT` 拒绝（`packages/physical-operator/resident-operator-local/src/store.ts:628-647`）。`session.reset` 能解除锁，但同时清掉原生线程关联，所以它不是切换。自动路由现在会沿用已锁定的 profile，不再失败（[profile 沿用](../../implemented/feature/2026-08-16-resident-execution-profiles.md)），但明确选择另一个原生模型仍会冲突。
- **切回原生线程时不补中间的对话。** 被恢复的原生线程只收到当前任务、运行时上下文和任务模板。operator context envelope 明确规定，此前的用户、助手和工具历史不进入它（`packages/core/system-prompt/src/envelope.ts:84-93`）。如果需求在 DeepSeek 轮次里变了，原生线程并不知道。
- **初始请求很大。** 被审计的会话里系统提示约 19.7 万字符，其中约 16.35 万是生成的工具 SDK；技能目录约 39.5 万字符。这些是字符数，不是 token 数。技能目录是 `source.kind = 'skill-catalog'` 的追加 `user/message`，目录变化时会再追加一条，旧的留在历史里直到压缩（`packages/skill/tool-skill/src/index.ts`）。

已经能用、必须保持不变的部分：

- 普通 API 模型或强度的切换在下一个 step 生效。选择不是会话事件，而是 Host 内存里的 `picked`（`packages/host/apiproxy/src/api-proxy.ts`，`selectionFor`），在每个 step 开始、`system-prompt/assemble` 之前读取一次（`packages/core/agent/src/model-selection.ts:85`）。已经开始的 step 不受影响，只有配置变化时才追加 `request/header`（`packages/core/agent-loop/src/agent.ts:464-470`）。
- 缓存复用是可观察的：被审计的 Flash 轮次从缓存读取了 94.35% 的输入。这不会减少请求里的文本，也不会减少它占用的上下文；切到 Pro 后第一次请求缓存零命中，但那次对比没有控制变量，原因没有确定。

保证范围：DSH 已经记录的内容（用户消息、适用指令、修正、任务状态、结果）。原生产品内部、DSH 从未收到的工具步骤不在保证内，每次交接都会声明这个缺口。不同 provider 之间不共享 KV cache，本设计也不假定它们共享。

## Proposal

### 1. 普通 API 模型：不加新状态

保持现状。用户的选择在下一个 step 生效，提交点就是现有的 `request/header`。只增加展示：模型菜单区分**已选择**和**当前生效**（下一个 step 开始前两者不同），每条回复显示实际服务它的配置。消息的 `source` 已经记录 provider 和 model；强度只存在于它之前的 `request/header`，所以 UI 从那里推导，日志不变。

此前提出的"持久化 requested、waiting、preparing、committed 状态"不用于这条路径。选择本来就推迟到 step 边界，再加一个持久化的待生效事件只会增加没有读者的日志词汇，也会重复 `llm-fallbacks` 插件撤掉切换事件时纠正过的错误。

### 2. 原生模型：每个配置一条 lane

Resident store 以 `(operator, workspace, lane)` 为键（`store.ts:352`），锁按行保存。lane id 是 `residentLaneId ?? parent.id`（`packages/physical-operator/physical-operator-resident/src/index.ts:206`），路由路径不传这个值。所以配置变化需要的是另一条 lane，而不是另一套锁规则。

- 现有会话的第一条 lane 保持 `laneId = parent.id`，已存储的会话不迁移、不重置。不同 profile 使用 `<parent.id>~<profileKey>`，其中 `profileKey` 是模型和强度规范化后的短键。显式工具路径保持 `explicit-tool:<id>` 并加同样的后缀。
- `physical-operator/dispatch`（`packages/physical-operator/tool-physical-operator/src/index.ts:105-118`）增加可选的 `laneId`。它是持久化的 Host 决定，所以 lane 在命令发送前就确定，恢复时沿用它。`residentLaneProfile`（`:1569`）改成一张从 lane 到其最近被接受 profile 的表，从这些事件读取。
- 选择规则：明确点名的原生模型使用 profile 相同的 lane，没有就新建一条。没有明确选择时使用最近一条 lane，这保持了已发布的 profile 沿用行为。
- `commandId` 是 `resident-` 加 agent id 与 message id 的哈希（`:1644`），不依赖 lane，而 daemon 把 lane 计入它的请求哈希。所以重试一次未被接受的 dispatch 必须沿用记录下来的 lane，不能在同一个 command id 下换另一条 lane。
- 互斥：一个 DSH 会话至多有一条 lane 存在未完成的 dispatch（`recoverableDispatch`，`:1796`）。daemon 的忙碌检查只在单条 lane 内，所以这个跨 lane 守卫是新增的。结果未知就保持未知：沿用现有 indeterminate 规则，不在另一条 lane 上重放。

Resident store 不变：state schema 6 与 protocol 14 保持，因此没有单向迁移，也没有回滚边界。旧 lane 留着，用于核对和切回。

线程内切换（在同一个原生线程里改模型或强度）不在第一阶段。wire 的 `turn/start` 接受 `model` 和 `effort`（`packages/subagent/subagent-codex/src/wire.ts`），但没有人验证过 Codex 或 Claude 在恢复的线程上是否真的采用，也没有对应的能力描述。它保留为之后的选项，前提是通过一次真实的资格测试。

### 3. 交接内容是现有信封里的派生 context

交接复用 `OperatorContextEnvelopeV1`：精确的 `systemText`、`task`、具名 `contexts`、带持久来源的 `source`、`digest`，以及 accepted 或 rejected 回执（`envelope.ts:84-130`）。完整信封已经作为 `physical-operator/context-envelope` 追加进会话（`index.ts:868`、`:1030`）。交接就是 `contexts` 里多出来的一个具名 context。它是带来源引用的派生视图，不是原始历史，所以"信封不含此前历史"的规则依然成立；信封版本保持 1，因为新增一个 context 名称不是结构变化。

- **只计算一次。** 交接在创建 dispatch 时构造，并和它的 `context-envelope` 事件一起存储。恢复或重放读取存储的版本。重放时重新计算会改变 digest。
- **已确认位置，不加新存储。** 某条 lane 的已确认位置从日志推导：该 lane 最近一次结果已送达会话的 dispatch（`recoverableDispatch` 里的送达判断）。`dispatch-terminal` 是失败标记，不是成功标记，不能当成功用。交接携带的是这个位置之后发生的内容。
- **内容，按优先级。** 最近的 checkpoint（有压缩摘要时）。已确认位置之后用户自己的话和修正，原文保留。其他模型完成的结果，以证据引用形式给出。未决命令。近期消息。权限、用户的硬约束和未解决的动作不会为了预算被丢掉：必需内容放不下时，切换停止并说明缺什么。
- **保持信任级别。** 工具和文件内容是被引用的资料，不会被提升为指令。当前权限始终来自运行时的实时配置，不从摘要恢复。
- **第一次使用的 lane** 得到 checkpoint、近期窗口和必需约束。
- **确认**来自适配器的信封回执，不接受模型自己说"已读取"。确认不明时，先对账再发送。

构造器是 `tool-physical-operator` 的私有模块，它本来就拥有路由和信封。出现第二个独立使用者之前不抽成共享服务。

### 4. 初始上下文体积：先测量

代码对可做的事有这些限制：

- `tools:sdk` 在每次 assemble 时按所有可见工具重新生成（`packages/core/tools/src/index.ts`，段 `tools:sdk`）。可见性按 scope 设置，不按 step 设置。
- system 文本或工具集不同，就会产生新的 `request/header`（`agent.ts:466-469`），前缀被打断。每个 step 都改工具集，是拿 token 换缓存未命中。
- surface replace 需要带来源的连续范围（`packages/core/session/src/surface.ts`）。技能目录消息不连续，所以不能直接套用 replace。
- 只有每 token 约四个字符的估算（`packages/llm/token-meter/src/estimate.ts`）和压缩阈值（窗口的 0.8 与 0.16），没有精确的 tokenizer，也没有请求硬预算。

所以第二阶段从在固定任务集上冻结基线开始：按段实测 token（基础说明、工具 SDK、技能目录、记忆、对话、工具结果）。候选方案，等测量后再选：会话内稳定的桥接加发现工具，代替每个 step 变化的工具集；紧凑的技能索引，正文按需加载（skill 工具已经按需加载正文）；把目录移出持久历史。稳定内容放前面，动态内容放后面；时间已经是每个 step 末尾追加的 `user/message`（`packages/context/time-context`）。预算成为部署配置，估算值和实测值分开标注。

首个目标是：在固定任务集上，基础说明加目录加 SDK 的 token 中位数至少下降 50%，所需能力仍然可以被发现。这是目标，不是已达成的结果。

### 5. 用量与证据

展示每条消息的输入、缓存读取、输出，以及计量是否完整。DeepSeek 不上报缓存写入（`packages/llm/llm-deepseek/src/translate.ts`），所以显示为"未获得"，不显示为零。摘要、工具发现、失败的切换和重试都计入成本。关于速度、成本或质量的结论只来自同一任务的配对运行：固定模型一组、分阶段切换一组，冷缓存与热缓存分开记录。十对只是试运行，只支持样本内结论。没有稳定改善时，结果写成"效率提升未证明"，默认策略保持不变。

## Alternatives considered

**持久化 requested 与 committed 的选择事件。** 选择本来就在 step 边界生效，并由 `request/header` 记录。新增事件类型要加目录条目并做兼容性决定，却没有需要它的读者。

**放开 Resident 的 profile 锁，在线程内切换。** 它需要改锁、做 store 迁移，并依赖没有验证过的原生行为，而且没有办法回到前一个 profile 的线程。

**为执行权加一个 generation 计数器。** lane id 和 dispatch 事件的顺序已经说明哪条 lane 在执行，daemon 的租约和回执也已经让单条 lane 串行化。再加一个计数器就多了一个真相来源。

**把整段对话重放进原生线程。** 它重复了线程可能已有的历史，也无视压缩。从 lane 的已确认位置起的增量更小，含义相同。

**重置 lane 重新开始。** 会丢掉原生线程关联，仍然需要交接。

**为交接做共享的记忆服务。** 目前只有一个使用者。

## Acceptance criteria

第一阶段，切换：

- 一个会话先用 Codex Sol 低强度，再用 DeepSeek，再用 Codex Astra 中强度，不出现 `EXECUTION_PROFILE_CONFLICT`。第二个 Codex 配置在自己的 lane 上运行，第一条 lane 保留。
- Codex A，然后 DeepSeek 把要求改成 B，再回到 Codex "继续"：原生轮次从交接里得到 B，已经完成的动作不重复。
- 切回某条 lane 时使用该 lane 的已确认位置，只发送之后的内容。
- 结果未知的 dispatch 用原 command id 和记录的 lane 对账。不发第二个业务命令，也不用别的 lane。
- 同一会话的两条 lane 不会同时运行。
- 放不下的交接会指出缺少的内容并停止。包含指令的工具结果在摘要之后仍然是被引用的资料。
- 先用一个测试证明信封 digest 在恢复时是否稳定。如果不稳定，请求哈希在重放时会冲突，设计要在写任何代码之前调整。
- 用真实 Loader 组合加 keyless snapshot 覆盖以上路径，另加一次小规模真实 provider 的原生参数资格测试。

第二阶段，上下文体积：基线已测量并冻结；选定的方法保持稳定前缀；工具发现覆盖测试通过；超过硬预算的请求被拒绝，并指出超出的那一段。

第三阶段，证据：每条消息的用量展示，缺失值有标注；配对比较同时报告成功率、总用量、耗时和遗漏。

文档：每个阶段都附带 README、JSDoc 和一份 implemented Agent Note。新增的可选 `laneId` 和新的 context 名称是加性的，需要做[日志版本机制](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)要求的会话日志兼容检查。

## Risks

- 信封 digest 或请求哈希在恢复时可能变化，导致重放冲突。第一个测试回答这个问题。
- 每个配置都要付出一个冷启动的原生线程的成本，所以来回切换不是免费的。成本会展示出来，而且用户的明确选择不会为了省成本被降级。
- 每个配置一条 lane，可能留下许多空闲的原生线程。有了用量数据之后需要一条保留规则。
- 交接文本仍可能漏掉原生线程需要的东西。coverage 字段声明省略了什么，上面的验收用例是检验手段。
- 第二阶段可能发现最大的成本不在本笔记假设的地方。基线出来之前，方法保持开放。
