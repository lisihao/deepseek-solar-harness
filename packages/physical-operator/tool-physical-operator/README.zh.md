# @deepseek-ai/dsh-tool-physical-operator

[English](README.md) | 中文

本包是面向模型的 `ctx.physicalOperators` Consumer。它注册一个固定的 `physical_operator` 工具，包含发现实时算子和运行一个稳定算子 ID 两个动作。动态 system-prompt 区段会说明何时委派、何时使用 Resident 连续性，并列出当前实时 descriptor、tag 与 mode。Provider 传输不会出现在工具约定中。

同一个包还会通过 `dsh-physical-operator` 模型路由公布每个可用物理算子。因此 Codex 与 Claude Code 可以被直接选为第一等主模型，这条路径不需要 DeepSeek API key，也不会先发起 DeepSeek 请求。该路由还会为每个可用 Codex 或 Claude Code 实时目录中的每个模型列出一个 `operator:model` 条目，名称为 `<算子> · <模型>`，并带有该模型的原生推理强度。选中后会路由到该算子，并把该模型与强度作为 Resident profile，覆盖已保存的 `/operator-profile`。资格检查会启动原生产品 CLI，因此原生模型条目只在显式刷新模型后出现；普通目录读取只列出算子并复用最近一次刷新的目录，刷新会报告目录失败。可选 Provider 安装后，`chatgpt-web` 也是通过用户已登录的 ChatGPT 网页运行的第一等直接路径。确定性的宿主分类器不会把它设为主路径，但协调模型可以把可用目录条目选作有界顾问。Codex 与 Claude Code 会收到该 turn 精确组装的 DSH system prompt 与模型可见工具 schema。工具调用经属主本地桥回到原 Agent 的 `ctx.tools`，因此既有 scope、guard、approval、插件所有权与结果渲染继续生效。ChatGPT Web 刻意只以 ephemeral 浏览器订阅方式运行：它会收到任务以及匹配的 task-template 指令，但不会收到面向工具型 agent 的 system instruction 或运行时上下文，也不会获得伪造的 DSH 工具桥、DSH 侧模型／强度偏好，也不宣称 Resident 连续性；这些选择由网页账户自身持有。桥会记录可忽略的调用／结果事件，并保留 Receipt 的 `commandId`、稳定 `toolCallId` 及其所属物理执行 ID，供轨迹配对；在 DSH 重载后重建工具 Receipt：已结算调用返回已记录结果；请求变化返回冲突；只观察到调用而没有结果的命令会持久记录明确的 indeterminate 轨迹，不会显示为仍在运行，也绝不自动重放。若同一活动 binding 期间后来到达持久结果，bridge 会从权威日志刷新并缓存该结果，绝不再次执行工具。原始参数、结果、错误、prompt 和 Provider 文本只留在持久权威日志；Host 会在公开 history 或 mux 交付前移除它们，仅输出固定、无文本的轨迹 schema。

组合可选 `ctx.modelCatalogs` 时，本 Consumer 会从同一次重新资格检查的目录读取中注册 `native:codex` 和 `native:claude-code` 源。Codex 源在该目录的直接菜单中可见，Claude Code 保持隐藏；两者都会保留每个观察到的原生模型及其物理路由与原生推理元数据。资格检查返回不可用目录时，会将相应源标记为不可用，而不会把保留的目录当作当前观察发布；传输或发现错误保持为错误状态。路由器自己的缓存仍会保留最近一次成功的菜单行。

默认情况下，模型菜单列出每个可用算子和每个已刷新的原生模型。三个可选 `Config` 字段可以收窄菜单。`entryOperatorIds` 列出作为独立入口的算子。`latestModelEntries` 让一个算子改为只提供其最新的原生模型：跳过指向其他提供方的转接 id（`openrouter/…`），按 id 解析出的代数从新到旧排序（`gpt-6` 先于 `gpt-5.6`），同一代内保持目录自身顺序，最新一代不足时由上一代补齐。第一个选中的模型显示在算子本身的入口上，该入口以菜单选择的强度或目录默认强度运行这个模型；其余的是 `operator:model` 入口，其他原生模型和算子都不出现在菜单中，但仍可用于委派。`stateRoot` 把刷新得到的目录保存在 `native-catalogs.json`，使这些入口在重启后仍然存在；刷新时某个目录不可用，会保留该算子上一次成功的模型，缺失或格式错误的文件视为没有缓存。Solar 的 resident-operators bundle 以这种方式提供 ChatGPT Web 和 Codex 最新的两款模型。已经在使用不再提供的模型的会话仍会路由到该模型，菜单此时显示 `Select model`。

智能协作分配。智能自动决定委派且挂载了 `ctx.modelAllocation` 时，路由器会提供可用 Codex 与 Claude Code 目录中接受 DSH 工具桥的每个原生模型，转接的 `openrouter/…` 模型除外。它在 `catalogMaxAgeMs`（默认十分钟）内复用上一次目录读取，超过后重新对原生产品做资格检查；显式菜单刷新也算一次读取。由于 Claude Code 不报告额度，未知额度会被放行。每个模型按默认推理强度报价；它的其他强度作为 `alternativeOffers` 一并交给分配器，只有分配器的成本感知选择可以选它们。每个报价按菜单的新款优先顺序排名，得分相同时较新的模型胜出。请求使用 `execution` 阶段、分类器判断的形态作为角色，以及 `quality` 目标。选中的模型及其目录默认强度成为 Resident profile，路由决策的 reason 写明报价、强度和分配器理由。同时挂载了 `ctx.schedulingEvidence` 时，它为这些报价提供的公开证据会随请求一起交给分配器（Codex 形态的工作用任务类型 `coding`，其余用 `analysis`），reason 末尾写明分配器的结论：证据倾向哪个报价，以及它是被采用（`apply`）还是仅被记录（`shadow`，分配器默认）。请求文字还会被 `classifyDifficulty` 判为 `easy`、`normal` 或 `hard`（困难：架构、重构、跨模块、并发、安全、要求增加功能、机制、模块或入口、带多个编号条目的消息、报错栈、多段代码或极长文本；简单：很短且关于改名、注释、格式化或解释，但不是设计讨论或问题报告；代码标识符和文件名里的关键词，例如 `formatPrice`、`retryRequest`，会被忽略）；重试消息沿用它所重复请求的难度，之前委派失败和重试各把难度升一档。`easy` 请求 `economy` 成本感知目标，`normal` 请求 `balanced`，`hard` 不请求，所以困难请求仍选最强的报价。reason 末尾写明分配器的成本感知结论。单独一句“重试”本身不可委派，仍留在当前模型。分配器缺失、目录无法读取或没有合格报价时，照旧运行分类器选出的算子，并在 reason 中说明原因。

Resident 原生进度页会在运行结束（或运行报告错误）后复制到当前 Session，成为可忽略的 `physical-operator/progress` 事件。投影有界、限定于当前 command，并在重连时按 sequence 去重；它携带阶段和终止元数据，但绝不携带 prompt 文本、推理、stderr 或原生 transcript。最终 assistant 输出仍使用普通的 `assistant/chunk`／`assistant/message` Trace；只有 Provider 提供权威 usage 时才附加（未知的可选 bucket 保持缺省），原生 stop/error 原因在 stream 与 turn 结束事件中保持明确。

每个 Session 还拥有持久化的路由策略。未配置的 Session 会投影为“智能自动”；确定性的宿主路由把有界实现/调试工作识别为 Codex，把有界分析/研究工作识别为 Claude Code。挂载了 `ctx.modelAllocation` 时，这个形态只决定分配角色，由分配器按下文选择协作者、模型和强度。`chatgpt-web` 被刻意排除在该自动分类器之外。复杂且可并行的工作会留在主轮次，使 `@deepseek-ai/dsh-tool-orchestration` 可以构造持久 TaskGraph；只有要求并行执行工作的请求才算，粘贴文本中把并行当作话题提及不算。要求把内容写入记忆的请求同样留在主轮次，因为外部算子没有记忆工具，指令之后粘贴的材料不得决定路由。显式启用的 Debate 模式具有相同的高阶优先级：物理路由器会记录 TaskGraph 候选，并把用户轮次交给 Debate Consumer，而不是派发单个 Resident。Codex 或 Claude Code 偏好会作为各节点的 `preferredIds` 带入 TaskGraph 执行；有界的标准工作仍直接派发一个 Resident。`/operator codex`、`/operator claude-code`、`/operator chatgpt-web`、`/operator direct` 和 `/operator auto` 提供可见的人工覆盖。`/operator-profile <product> <model|auto> <effort|auto>` 只适用于 Codex 与 Claude Code；ChatGPT Web 刻意不提供 DSH 侧模型或强度控件。非重置的 model/effort 组合会在写入 profile 事件前按 Resident 实时目录校验；目录不可用时拒绝且不修改 Session，`auto/auto` 仍可用于清除过期偏好。由于目录可能变化，daemon 在执行时还会再次校验。当会话本地模型选择已安装并为某个 step 捕获时，所选 API 或物理模型会保持协调者角色。所选物理模型会被直接宿主路由；所选 API 保留在 API 路由上，并把已记录策略作为下游协作和 TaskGraph 指引；例外是智能协作可以把一个可识别的请求路由到物理算子，或要求 API 协调者启动 TaskGraph。当前消息中提到 Codex、Claude Code 或 ChatGPT Web，以及已保存的 `/operator` 策略，都不会取代它。所选的原生 Codex 或 Claude Code 主模型会保留真实 DSH 工具桥并可调用下游协作者，而偏好只命名协作者。直接模式下所选 ChatGPT Web 主模型保留其无伪造桥或 DSH profile 的 ephemeral 浏览器路径。智能协作只能把可用目录中的 ChatGPT Web 条目作为设计、高层规划或研究的有界顾问；该目录顾问路径没有 DSH 文件写入或测试执行能力，也不能建立验收。没有已安装模型选择时，旧宿主路由继续生效：在未显式启用高阶模式时，当前消息明确点名产品或可识别的原生模型系列会高于已保存偏好（`Sonnet`/`Opus`/`Haiku` 选择 Claude Code，`GPT-5.x` 选择 Codex，显式 `ChatGPT Web` 选择 `chatgpt-web`）。已接受的直接路由只在该模型 step 内替换为物理算子适配器，并把被替换的主模型配置记录在 dispatch 中。只有 Resident 路由会使用历史路由状态重新连接未交付的命令回执或继续先前任务；ephemeral 浏览器路由绝不会从历史续写或恢复记录中自动再次运行。路由决策、派发、策略和 profile 均持久化，并可被旧 reader 忽略。智能自动会在尚未准入的已选算子报告 `AUTH_MODE_MISMATCH`、`OPERATOR_UNAVAILABLE`、`PROVIDER_VERSION_MISMATCH` 或 `RUNTIME_UNAVAILABLE` 时重试；已启动的 Resident 运行若被产品报告所选模型“需要订阅之外的 usage credits”，该运行以 `MODEL_REQUIRES_CREDITS` 结束，请求改由回退算子执行，且分配器在本会话剩余时间不再提供该算子与模型；格式错误的资格输出、配额耗尽和产品命令失败仍是所选路由的错误。`/operator direct` 会保留在原路由，不会探测无关的 Claude，也不会回退到 DeepSeek API。

自动路由仍需要决策来源，但不要求 DeepSeek：可确定的情况由本地规则处理，复杂规划则可以由当前选中的 Codex 或 Claude Code 订阅主 Agent 完成。配置了 API key 的 DeepSeek 路由只是一个可选的同级候选，不再是启动前提。

## 工具约定

| 动作 | 参数 | 结果 |
|---|---|---|
| `list` | 无额外字段 | 稳定 ID、执行模式、描述、标签、可用性与容量。 |
| `run` | `operator_id`、`description`、`prompt` 与可选 `mode` | 执行 ID 与成功的 Provider 输出；Resident 完成时还返回连续性信息。 |

`list` 会拒绝仅供运行使用的字段，不会静默忽略工作。`run` 要求真实的调用 agent，转发其取消信号，在前台等待，并始终释放已经接受的 Provider 运行。未成功完成的停止原因会作为工具错误报告，同时保留已有的部分文本。独立发生的结果错误和释放错误都会保留。

prompt 必须包含本轮所需的完整工作。Ephemeral Provider 会在全新的产品上下文中接收它；Resident Provider 只会继续规范化 workspace 内由调用方拥有的 lane。大型 Resident 结果可以返回内容寻址的产物引用，而不内联原始字节。

每次 `run` 都会从当前运行时快照和为委派提示词自身选出的模板构建密封算子上下文信封，绝不会复用附着在更早父任务上的模板。Session 会把精确的信封和委派模板回执与 Provider 回执一并记录，以便回放时重建子任务输入。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`physical_operator` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator)。`list` 暴露能力身份、支持的执行生命周期与实时容量；`run` 接受已列出的 ID、简短标签、完整任务和可选 `mode`。省略该字段会保留 ephemeral 执行。schema 不会泄露后端 Provider 传输或产品命令。

#### 对 token 的影响

工具作用域内的每次请求会增加一个固定 schema。列表结果和最终执行输出会保留在父级历史中，直至压缩；子级工作上下文不会进入父级。

#### 对 KV Cache 的影响

只要工具 schema 不变，请求前缀就保持稳定。在稳定 ID 背后更换算子映射或 Provider 不会改变 schema；结果行追加在可复用前缀之后。

### 执行结果

#### 模型看到的内容

成功时，模型看到算子选择的输出块；结构化值还携带规范 ID。Resident 成功结果会额外包含不透明的会话 ID 与状态 revision。取消、拒绝、token 耗尽或失败会成为错误工具结果，并在存在时保留部分文本。

#### 对 token 的影响

只有选定的最终或部分结果会进入父级上下文。Provider 推理、中间活动、stderr 和产品本地 ID 均不会进入。

#### 对 KV Cache 的影响

只在现有请求前缀之后追加。

## 已知限制与后续工作

- **仅前台执行**：模型不会获得后台句柄、进度流、管理状态、reset 或 interrupt 操作；可信 CLI 和插件负责 Resident 管理。
- **模型桥跟随 DSH attach 生命周期**：稳定 socket 与已记录 Receipt 允许重载后的 DSH 客户端重新附着同一命令，但在没有 DSH Host 持有桥的间隔内，DSH 所有的工具不可用；原生产品工作与产品内置工具仍由 daemon 持有。
- **保守的确定性分类器**：明确点名和已选择产品策略由宿主硬路由。智能自动用可审计的任务形态规则决定是否委派以及属于哪个领域，无法匹配或琐碎工作仍留给当前模型。分配器会考虑额度、容量、档位和领域，但尚未考虑任务复杂度、重试或推理强度规则；每次委派都使用所选模型在目录中的默认强度。
- **直接调用没有队列或亲和调度器**：一次直接 turn 仍在前台运行。多算子 DAG 调度属于 `ctx.orchestrations`；workspace/provider 亲和性优化仍属后置。
- **没有类型化物理 payload**：首版接受文本任务，返回普通内容块或 Provider 持有的产物引用。
- **没有通用输出大小策略**：Resident 本地执行提供有界产物策略，其他 Provider 仍需对完整结果大小负责。
