# Agent Note：DSH 原生 Jev 决策与工程协作

状态：提案

[English](2026-10-01-jev-engineering-native-decisions.md) | 中文

## 问题

Codex Jev Engineering（私有的 Codex 插件源码，读取时版本为 0.2.1）给协调模型提供有界的语义判断：在多个候选文件中选一个、筛选大段日志、选择工具，并请只读 architect 做审查。它能工作，只因为 Codex 会去调用它。DSH 没有对应能力；如果在 DSH 旁边安装该插件的 MCP 服务器，就要靠模型自己记得去调用，会产生第二套任务状态，还会让一个按 Codex 形态设计的网关去管理 DSH 的动作。

更早的提案（[可配置的决策驱动 Harness](https://github.com/lisihao/deepseek-solar-harness/blob/d663978325/.agents/notes/proposed/architecture/2026-09-24-configurable-decision-driven-harness.md)，提交 `d663978325`，位于 `codex/jev-engineering-design`，从未合入 `solar`）描述了完整目标。它早于现已进入 `solar` 的调度证据工作，并把若干运行时事实当作未决。本说明取代它成为设计的所有者：保留它的全部义务，把基线固定在 `solar` 的 `117ec4ee37`（3.29.0），并拆分交付，使原生核心（P1–P3）可以单独验收，而不必宣称完整的上下文、工具披露和缓存目标（P4–P6）已完成。

在该基线读取 `solar` 后，发现下列本设计所依赖的缺口。每一项都需要在 P0 用反例测试确认，对应阶段才能开始。

- **文件读取没有沙箱检查。** `tool-fs` 的 `read` 经 `resolveRegularReadTarget` 和 `ctx.fs.resolve` 解析；沙箱插件只检查写入和编辑。读取唯一的通用检查是 `tools` 注册表的 pre-execute 与 guard 路径。由决策驱动的读取器必须在操作本身中强制执行允许的根目录。
- **被拒绝的 `agent/pre-step` 会丢掉已认领的输入。** `Agent.preStep` 在 `system-prompt/assemble` 与 `agent/pre-step` 运行之前认领 inbox，拒绝会让本轮以 blocked 结束且不重新入队。等待判断的消费者在失败、超时或弃权时必须返回原消息，绝不能拒绝。
- **完成条件是 `stopReason === 'completed'`。** TaskGraph daemon 根据 operator 的 stop reason 把节点标为 passed。验收种类只有 `operator-completed`、`artifact-present` 和 `human-review`；没有任何验证回执把声明的检查与命令、退出码和产物对应起来。
- **`approvalRef` 不绑定任何东西。** 它是调用者给的字符串或 `approval:<uuid>`，只检查是否存在并复制进封存计划。
- **Resident 审查者不是只读的。** 只有读取范围的节点只得到 `nativeToolPolicy: inherit`；只有 Codex 的 `dsh-tools-authoritative` 策略会封存 `nativeEffects: 'read-only'`。进程内子 agent 通过 `tools.restrict` 获得工具过滤和 guard，而进程外 provider 声明 `toolFilter: false`。
- **不存在审查记录。** 没有任何 session 或 orchestration 事件记录审查、其执行者或输入摘要，去重没有可依据的键。
- **角色路由可能与自适应策略冲突。** `adaptiveExecutionPreference` 仍会让看起来像编码执行的文本偏向 Luna 和 Terra；显式固定（`preferredOperatorIds` 加 `preferredModel`）先于它生效，所以工程角色必须解析为显式的分配器约束。
- **分配器已经接收公开证据。** `ModelAllocationRequest.evidence`、`ctx.schedulingEvidence.evidenceFor` 和 `publicEvidence: off | shadow | apply` 已存在；智能协作路径调用它们，TaskGraph 的 `selectOperator` 没有。

## 方案

**所有判断遵守同一条规则。** 确定性代码决定已知情况。只有当多个合法候选仍有歧义时，Decision 服务才询问判断 provider。拥有该动作的消费者重新检查权限、作用域、预算和新鲜度，然后应用或丢弃答案。provider 不读取文件、不运行工具、不修改任务状态，也不能覆盖用户固定的模型、额度下限或审批。

**所有权保持不变。** Radar 和 AI Frontier 提供证据，OpenSquilla 估计需求，`modelAllocation` 拥有模型选择，Scheduler 拥有执行。Jev 只在分配器的硬性门槛和可比证据排序无法决定时，增加有界的语义建议；它不会在分配器封存计划之后再做第二轮排序。

```text
user goal / mode / pinned model
   → DSH session, TaskGraph, permissions, cancellation (unchanged)
   → Decision service: resolve → decide
        0 candidates → no-eligible
        1 candidate  → deterministic pass-through (no provider call)
        2+ ambiguous → configured provider
   → typed answer or abstention, never an action
   → consumer re-checks dependency, permission, budget, freshness
        ├ restricted read → ContextPacket / projection artifact
        ├ role offer → modelAllocation → sealed plan
        ├ review request → existing Scheduler work
        └ full phase: context, schema, and prefix plan
   → existing Native Agent / Resident / Web execution
   → real result, acceptance record, whether the decision was applied
```

**包。** `packages/decision/decision`（服务定义与纯函数）、`packages/decision/decision-jev`（基于 vendored `jev-use` 传输的 provider）、`packages/decision/engineering`（消费者与审查）。只有当某个角色独立演化时才进一步拆分。名称在 P1 之前是暂定的。

**Decision 服务。** 用途为 `file.select`、`context.filter`、`tool.select`、`role.offer`、`next.ready`、`retry.advise` 和 `stop.advise`。结果带有一个状态：`selected`、`no-eligible`、`abstained`、`unavailable`、`timeout`、`cancelled`、`invalid`、`stale` 或 `policy-denied`，另有来源（`deterministic`、`provider` 或 `cache`）、用量、输入摘要和回退原因。`cancelled` 是终止状态：其后不再升级或重试，迟到的答案记录为未应用。未知、重复或缺失的答案、非有限数、格式错误的分布，以及与配置的部署不一致的 provider 身份，返回 `invalid` 或 `policy-denied`，绝不当作默认选择。置信度种类（类别标签、自报分数、原生分布、校准估计）彼此区分，阈值按用途和 provider 配置。从插件继承、用于初始评估的数值为：3 秒超时、8 KiB 紧凑状态、每批 8 个问题、每题 12 个候选、置信度 0.8、margin 0.2、5 分钟决策缓存；每一项都是记录在回执中的 `Config` 字段，而不是产品默认值。

**配置与用户控制。** `engineering-decisions` Settings 命名空间无需改代码即可增加 Jev 接口和开关。下面的清单是目标 schema，目前不是可运行的配置。

```yaml
engineering-decisions:
  enabled: false
  providers:
    local-judgment:
      adapter: jev-use-typesafe
      endpoint: http://127.0.0.1:PORT
      expectedModel: PINNED_DEPLOYMENT_MODEL
      credentialRef: decision/local
      residency: trusted-private
      enabled: true
  purposes:
    file.select: { mode: shadow, providers: [local-judgment] }
    context.filter: { mode: shadow, providers: [local-judgment] }
    tool.select: { mode: off }
    role.offer: { mode: off }
    next.ready: { mode: off }
    retry.advise: { mode: off }
    stop.advise: { mode: off }
  fallback:
    externalProviders: []
    onUncertainty: current-qualified-coordinator
```

- **增加 Jev 接口只需改配置。** `providers` 下的每个条目是一个接口，有自己的 endpoint、固定的模型、`credentialRef`（Settings 保存引用，不保存密钥）、`residency`（`local-device`、`trusted-private` 或 `external`）和 `enabled`。一个用途按回退顺序列出它可以使用的 provider id。重复的 id、未知的 provider 或用途、缺失的凭据引用，以及未列入 `fallback.externalProviders` 的 `external` provider，在加载时失败。重定向、部署身份变化，或与配置的 residency 不符的 loopback 地址，会阻止应用。
- **用户在三个层级开关：** 命名空间的 `enabled`、每个 provider 的 `enabled`，以及每个用途的 `mode`（`off`、`shadow`、`active`）。默认全部关闭；关闭意味着不调用 provider、不写决策记录，行为与没有该插件的构建完全一致。更改通过 Settings watcher 在下一次决策时生效，无需重启；已经发出的决策在原配置下完成或取消。Shadow 模式同样消耗资源，也可能把内容发给 provider，因此需要与 active 模式相同的 residency 授权。
- **设置页**显示启用状态、provider 类型与部署身份、数据 residency、各用途的模式、校准状态、预算、角色规则、回退规则和最近一次健康检查。健康检查只发送合成内容，凭据只显示为已配置或缺失。
- **会话与任务视图**显示下列之一：确定性直接选择、Jev 已应用、仅 shadow、已弃权、已过期、等待审查，并链接到真实的读取、执行和测试证据。

**消费者（P2）。** 受限文件读取：先构造带文件身份的合法路径候选；只有一个候选时直接读取；有多个候选时经 Decision 服务，选中的精确文件通过 DSH 文件服务和注册表 guard 读取，再把读到的字节与候选身份做哈希比对，不一致则返回 `stale`。agent 无权读取的文件绝不会发给 provider 去判断。日志与搜索结果筛选：输入是获准的不可变文本产物；用稳定的行区间索引原文；必需指令、未解决的用户要求、当前失败、验收输出和调用/结果配对由代码固定，不靠关键词列表。弃权、超时或输出非法时，原始产物保持可分块读取，报告统计保留的字节、读入的字节、候选数、再读取次数，以及最终进入请求的字节。工具选择只在已注册的只读工具中选择（保留 `dev_tool_search` 的解锁路径及其记录的 `toolNames`），不生成 shell 参数，并在调用时重新检查权限和指纹。Native Agent 的接入只处理已持久记录的工具结果和检索材料；不会在破坏性的 inbox 认领与输入持久记录之间等待判断。

**角色与审查（P3）。** 角色为 coordinator、explorer、worker、researcher 和 architect。角色通过现有分配器解析为精确的 `operator/provider/model/effort`，作为显式约束，并在该请求上禁用冲突的 `adaptiveExecutionPreference`。可编辑的预设可以参照当前 Codex 的安排，但绝不覆盖用户选定的模型。已封存的 attempt 在目录刷新后保持其身份，只有安全的交接点才重新规划。角色矩阵按能力过滤：ChatGPT Web 没有本地写入工具，因此只提供规划、研究和只读审查；没有可强制只读限制的审查者，不能被报告为独立审查。审查是持久的 Scheduler 工作，键由父 run、node、attempt、审查种类和依赖指纹组成；执行者角色来自封存计划，而不是调用者自填的 `actorRole`。父任务在安全点封存审查快照并让出槽位，使 `maxParallel=1` 也能完成；取消待处理的审查会阻止派发。只有执行者 id、模型与 effort、输入哈希和输出哈希都匹配，审查才有效，协调者对每条发现记录采纳或不采纳及理由。已要求但未派发是待处理状态，绝不再启动第二个审查者。

**先验收，后自动化。** `stop.advise` 和 `retry.advise` 保持建议性质，在确定性验收检查器把每项声明的检查与实际命令、退出码和产物对应到不可变的验证回执（P4）之前，绝不把任务写为已验收。结果未知的有副作用操作，对照原执行回执核对，不会因 Jev 的建议而重放。

**记录与缓存。** 事实复用 session 事件、TaskGraph 事件和 artifact store：`decision/requested`、`decision/resolved`、`decision/applied`，以及按事件规则命名的审查与上下文事件。每条应用记录包含父 session、run、node、attempt、输入与指令摘要、目录与工具注册表修订、策略、配置、provider 和校准修订、来源、选中与拒绝的原因，以及真实读取或执行的 id。模型可见的判断输入与筛选输出可由持久化的字节重建，而不是靠哈希。新的 required-on-read session 事件遵守 session 格式版本规则，绝不为了免去迁移而标为 `ignorable`。三种缓存分别记账：决策结果、检索或表示产物、provider 前缀/KV。缓存键包含作用域、用途、规范化且有序的候选、输入摘要、策略与指令修订、实际模型身份和校准修订；读取命中仍要重新检查当前权限和产物哈希。目前 `SpillRef` 不带内容哈希，所以不可变投影使用 artifact store，或由 P2 决定新增哈希字段。

**执行路径。** 经 `ctx.llm` 的 Native Agent 最先获得有界观察、选择、角色建议和已记录的判断，也是唯一能控制完整上下文重建和缓存目标的路径。Codex 与 Claude Code 的 Resident operator 只在适配器开放相应限制的范围内获得封存任务、精确的模型与 effort、输入包、只读审查者和回执。ChatGPT Web 遵循上面的能力规则。三者共享同一个父任务和同一个 Scheduler。

**完整阶段（P4–P6）**作为有约束力的义务保留，不因核心完成而隐含满足：覆盖事件和 artifact 的可寻址块存储、带独立生成摘要的 hide/short/long/full 表示、每个 attempt 可重建的上下文计划、持久的 inbox reserve/commit/return/revoke、分层工具披露、带实测 provider 缓存用量的前缀/KV 策略、模型/上下文/前缀联合路由、经现有工具运行时的已解析免生成动作，以及共享的只读后台观察。它可能需要修改 agent-loop 和 inbox；`agent/request` 只改调用配置，因此 P4 先证明现有扩展点是否足够，并由唯一的所有者负责上下文生成，使压缩与上下文计划不会各自独立裁剪历史。

**来源复用。** 未经许可检查不复制任何内容。`jev-use` 0.8.0 声明为 MIT（上游快照 `541c86caabf1eeb0af929256649d460f2708cb42`，npm shasum `fc74e00faacccce122a1b98f8e90ed7e26562394`）；Codex 插件项目本身没有 LICENSE 文件，所以其自身文件只作为参考和行为案例，针对 DSH 接口重写，除非所有者确认其条款。公开的来源清单（上游地址、固定版本、相对路径、SHA-256、许可证、原有测试、行为差异）是 P0 的产出，且不得包含用户 settings、授权回执、对话、工作日志和本机绝对路径。

| 来源文件（读取时的 SHA-256） | 处理方式 | DSH 落点 |
|---|---|---|
| `src/provider.mjs`（`6a345700…22ec`）与 `vendor/jev-use-0.8.0.tgz`（`553128c9…4a67`） | 复用传输与校验思路 | `decision-jev`；使用现有凭据、子请求取消、配置和 telemetry；不手写第二个网络客户端 |
| `src/decisions.mjs`（`245097fb…3ea1`） | 提取规范化、严格答案校验、置信度筛选、指纹和保守筛选的测试 | `decision` 纯函数；去掉用户目录和宿主状态耦合 |
| `src/readonly-tools.mjs`（`0b4973c7…3e9d`） | 迁移候选应用及其测试 | 基于 DSH `fs` 与 tools 的受限读取消费者；保留单候选零调用和读取后哈希检查 |
| `src/workflow.mjs`（`e1d6b4c6…3aa9`） | 保留触发与去重案例，不要 JSON 事实存储 | 审查记录与 Scheduler 绑定放在 DSH 事件中 |
| `src/gateway.mjs`（`f0e536d9…b07c`） | 仅作为 source-only 原型参考 | 动作身份、精确参数与 cwd、一次性认领和未知结果核对迁入现有生命周期；不并存第二个网关状态机 |
| `src/gateway-hook.mjs`、`hooks/*`、`src/install.mjs`、Codex TOML 管理 | 不进入 DSH 运行时 | 使用 Cordis 和工具运行时；绝不为模拟 DSH 能力而修改用户的 Codex 或 Claude Code 配置 |
| `test/*.test.mjs` | 复用行为案例，改为 DSH Vitest 与真实 Loader 测试 | 真实服务、Loader、事件和重启场景取代宿主 mock |

撰写本说明期间源码仍在变化：插件版本读为 0.2.1，`gateway.mjs` 与已安装的 0.2.0 副本不同，而 `provider`、`decisions`、`readonly-tools` 和 `workflow` 与已安装副本逐字节一致。P0 在任何提取之前重新冻结哈希。

**阶段。**

| 阶段 | 范围 | 退出条件 |
|---|---|---|
| P0 | 来源清单与哈希；带反例测试的缺口矩阵；本说明 | 实施基线按当前 `solar` 冻结；上面每个缺口都被测试确认或否定；回放 fixture |
| P1 | `decision`、`decision-jev`；配置与凭据；协议测试 | 关闭时零调用；单候选直通；严格输出与真实身份检查；取消、超时、预算和 residency 测试 |
| P2 | 受限读取与筛选消费者；投影产物；最小检查器 | 一个真实 Loader 示例减少实际读取或上下文；固定的证据保留；已变化的文件被拒用；全文保持可分块读取 |
| P3 | 角色解析；持久审查；UI；物理算子适配 | 真实 worker 与 reviewer 派发；身份与只读限制；去重；三处崩溃窗口的恢复；显式模型锁定优先 |
| P4 | 原生上下文与 inbox 生命周期；schema 披露；请求重建器；确定性验收检查器 | 按 attempt 重建；取消不丢输入；权限不被削弱；已解析动作留下真实回执 |
| P5 | 证据与缓存联合优化 | 可比证据按设计改变合法选择；不可比数据弃权；实测缓存用量 |
| P6 | 产品启用与示例 | 支持矩阵、启用/禁用/回退、可复现的证据 |

P1–P3 称为“DSH Jev Engineering 原生核心”。在 P4–P6 按完整阶段义务验收之前，它不等于完整的 Jev Engineering。并行工作仅限不会冲突的文件（例如 provider 协议测试和空状态 UI）；schema、生成目录、封存依赖、Git 和发布由协调者串行集成。P3 的审查派发与 P4 的验收检查器都会修改 `orchestration-local/src/daemon.ts`，按顺序进行。TaskGraph 的 `selectOperator` 接到同一个分配器和同一份证据快照引用，绝不另建排序器。

**收益评测。** 三类完整任务（在大日志中定位失败、多文件导航、有界的代码改动）分别在 baseline、shadow 和 active 下运行，固定源码、任务、验收测试和允许的工具，交错执行顺序，并区分冷缓存与热缓存。样本量、质量下限以及允许的延迟与成本回退，在读取任何结果之前确定。报告列出判断调用次数与延迟、前台与子任务的生成用量、筛选后的再读取、摘要、审查、等待、重试、完成时间、返工以及必需证据的召回；订阅额度和本地计算分别列示，绝不折算成美元。某个用途只有在其 A 系列正确性场景通过、质量没有回退到预先声明的下限、没有丢失必需证据或权限，并且在完整任务上显示净收益之后，才成为 `active`；否则保持 `off` 或 `shadow`。

**回滚。** 可以先按用途关闭，这会停止新的判断并保留全部历史。涉及 required 的模型可见事件、SQLite 或 inbox 语义的更改，遵循仓库的 schema 与 session 版本规则，每个阶段保留可恢复的快照，并实测迁移边界。交付报告分别列出已提取、已改造、已测试、已接入真实执行、已启用、已合并、已安装以及已证明有收益的内容，附上源码与远端 SHA、命令与退出码，以及未覆盖项。

## 备选方案

**在 DSH 旁边安装 Codex 插件的 MCP 服务器。** 它现在就能工作，但依赖模型记得去调用，会保留第二套任务与审批状态，并匹配 `Bash`、`spawn_agent` 这样的 Codex 工具名。否决：稳定的触发必须来自程序接线。

**复制插件的 JSON 状态机和 Hook。** 很快，但会为 DSH 的 Scheduler 与工具运行时已拥有的动作和审查创建第二个控制面。否决；改为复用行为案例和纯算法。

**为基于 Jev 的模型选择另建排序器。** 这会让 modelAllocation、Radar 证据和 Jev 对同一个模型各有一种意见。否决：Jev 只在分配器的排序之内、硬性门槛和可比证据之后增加有界建议。

**相信置信度数值并自动放行。** 带高分的结构化 JSON 答案不是经过校准的概率。否决；阈值按用途和 provider 配置，校准是单独的证据，验收只来自确定性检查器。

**只提供一个“智能协作”开关。** 单个开关隐藏了哪项能力在运行、内容去了哪里。否决，改用三个层级（命名空间、provider、用途）并显示模式。

**先建完整的上下文与缓存架构。** 它风险最大（涉及 agent-loop 和 inbox 的修改），并推迟任何用户可见的结果。否决；原生核心先交付，完整义务仍有约束力。

## 验收标准

下面的矩阵是所列阶段的产品验收；文档评审和源码阅读不能满足其中任何一行。A24 要求每个改变用户可见行为的阶段，都有来自真实可运行示例的 keyless 快照。真实 provider 的协议测试使用合成数据；付费或订阅调用需要当前有效的授权，缺少凭据时记录为未覆盖，不以 mock 替代。

| ID | 场景与断言 | 阶段 |
|---|---|---|
| A01 | 功能关闭时 provider 调用次数为 0，原任务正常运行 | P1 |
| A02 | 0 个候选返回 `no-eligible`；1 个合法候选确定性直通，Jev 调用为 0 | P1/P2 |
| A03 | 多候选决策改变实际读取的文件或区间；未被选中的文件不会先被同一个消费者完整读取 | P2 |
| A04 | 未知候选、缺失或重复的答案、损坏的 JSON、非有限数和错误的分布不被应用 | P1 |
| A05 | 任务仍活动时，超时、低置信度或身份不符返回明确的回退；取消后不再有升级调用，迟到的结果不覆盖较新的状态 | P1/P2 |
| A06 | `local-device` 与 `trusted-private` 请求绝不静默转到云端 provider；`off`、`shadow` 和 `active` 可以区分 | P1/P6 |
| A07 | 哈希、指令、策略、目录或作用域的变化使缓存和计划失效；缓存命中不会再次调用 provider | P1/P2 |
| A08 | 中文断言、没有错误关键词的决定性证据、必需指令和用户要求不会丢失 | P2 |
| A09 | UTF-8、空文件、末尾换行、不连续区间和超出预算的固定区域都有明确的输出和可回放的来源；P2 等待判断时取消不丢失未消费的输入 | P2 |
| A10 | 原文回退始终可完整检索；下游的预算处理不能静默删除固定内容 | P2 |
| A11 | 用户固定的模型不会被 Jev、角色预设或第二次分配器处理覆盖；不支持的组合在运行前被拒绝并给出说明 | P3/P6 |
| A12 | 目录刷新后，新模型可以参与下一次合法分配，而已封存的 attempt 保持其身份 | P3 |
| A13 | 冲突的文件作用域、容量已满和共享额度不足时正确等待或失败，不靠模型轮询 | P3 |
| A14 | 审查者有真实的执行 id、只读限制以及输入和输出哈希；伪造的角色、`agentId` 或跨任务文件无效 | P3 |
| A15 | 待处理的审查不会被重复派发；重复的错误事件不累加计数；相同的有效指纹不会重复审查；`maxParallel=1` 不死锁；取消待处理的审查会阻止派发 | P3 |
| A16 | 三个重启窗口都能正确核对；旧 attempt 或取消后迟到的回执不能让任务复活 | P3/P4 |
| A17a | 当 Jev 给出全部有利答案时，缺少审批的动作仍不能执行，Jev 的停止建议不改变任务完成状态 | P3 |
| A17b | 确定性检查器逐项匹配真实检查；缺少必需的测试或产物时不被验收；`operator-completed` 不能替代 | P4 |
| A18 | 每个 attempt 记录请求清单，独立的重建器比较消息、系统提示、schema、模型和 effort | P4 |
| A19 | 判断期间的 steering、取消或重启不丢输入，也不重复工具效果；未知效果先核对 | P4 |
| A20 | 只有已解析、合法且已记录的动作能绕过生成请求；任意 shell 文本得不到授权 | P4 |
| A21 | 不支持 KV 的 provider 显示 `unsupported`；支持时比较实测的缓存用量，而不是自报的命中 | P5 |
| A22 | 同一 cohort 的可比证据按设计改变选择；不可比、过期、冲突或小样本的证据则弃权 | P5 |
| A23 | Native、Resident 和 Web 各自在其声明支持的路径上测试；没有能力的组合在 UI 和 API 中同样被拒绝 | P3/P6 |
| A24 | 真实 Loader 的 keyless 快照端到端展示刷新或读取、判断、应用、执行和证据 | 每个用户可见阶段 |
| A25 | 禁用或回滚后历史仍可读，普通 DSH 路径保持不变；配置问题不会阻断无关的已禁用能力 | P6 |
| A26 | 在配置中增加一个 provider 条目后，无需改代码即可用于所列用途；重复的 id、未知的 provider 或用途、缺失的凭据引用或未获允许的 `external` provider，在加载时失败 | P1/P6 |
| A27 | 关闭命名空间、某个 provider 或某个用途后，provider 请求为 0、决策记录为 0，行为与禁用的构建一致；更改在下一次决策时生效且无需重启，并且不改变已经发出的决策 | P1/P6 |

P0 还要用测试确认当前 scheduler 的审批绑定、实际验收和跨 run 的作用域准入是否满足 P3 与 P4。不满足的部分成为明确的前置切片；单独的 `approvalRef` 字符串、operator 完成、进程内锁或 job id，都不当作相应的保证。

## 风险

- **许可证。** Codex 插件项目没有 LICENSE 文件。在所有者确认条款之前，只复用行为案例和算法，并且重写而不是复制。
- **源码在变化。** 插件源码在这项工作期间发生了变化（需求中为 0.1.2，读取时为 0.2.1，已安装为 0.2.0）。这里记录的哈希只描述读取时的文件。
- **缺失的起始文档。** 需求提到了 `CLAUDE_START.md`、`evidence.json` 和 `REVIEW-before-plan.md`；设计工作树里一个也没有，所以本说明不引用它们的内容。P0 找到它们，或把它们记录为未审阅。
- **Residency。** loopback 端点可能隧道到另一台机器，而 shadow 模式仍会发送内容。Residency 靠配置，并在应用时检查，而不是从地址推断。
- **判断的成本。** 在小任务上，一次判断调用的成本可能高于它节省的。单候选快速路径和进入 `active` 之前的净收益要求用来防范这一点；没有实测收益的用途保持关闭。
- **审查成本。** 每次状态更新都做审查会吞噬收益。触发条件限于大型计划、同类错误达到策略阈值，以及长任务完成，并按指纹和唯一错误事件去重。
- **Resident 的限制。** Codex 与 Claude Code 适配器只开放部分模型、输入和工具限制。没有被证明可强制执行的能力保持不启用，矩阵隐藏无法成立的组合。
- **未验证。** 本说明对照源码审阅过，但没有运行 DSH 功能测试、Jev 模型调用或性能实验。在实现之前，每个 A 系列行和收益评测都未经验证。
