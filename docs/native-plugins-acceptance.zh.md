# Native collaboration / Resident 手工验收指南

本文是后续验收的操作规程，不是本次源码检查或安装报告。当前 checkout 尚未在官方 Desktop 中安装并执行本指南的手工用例；因此本文不把任何用例标记为已通过。实现边界以 [native UI contract](native-ui-contract.md) 和 [native plugins contract](native-plugins-contract.md) 为准。

## 先确认验收边界

手工验收需要一个已经获得安装授权的官方 Harness Desktop 配置，并且两个插件都已启用：`@lisihao/dsh-solar-native-collaboration` 提供 `智能协同` 的客户端入口和 Host 控制面，`@lisihao/dsh-solar-native-resident` 提供持久化任务图、原生会话 lane 和唯一的调度器。单次官方委派可以在没有 Resident 时工作；任务图、任务检查、暂停/恢复/取消和两个原生连接测试需要 `solarNativeResident` 服务。

先准备以下信息，并在每个用例中保留实际观察值：

1. 官方 Desktop 版本、两个插件版本、目标 profile 和测试开始时间（按当前用户时区记录，同时保留原始 UTC 时间）。不要在报告中记录 OAuth token、API key 或完整凭据。
2. Codex 和 Claude Code 的官方 provider 是否已在本机完成登录，以及“可用”状态的实际显示。插件不会登录、复制凭据或切换账号。
3. 一个已经存在且可访问的临时工作目录，供委派和任务图使用。连接测试由插件自动创建 `$DSH_HOME/solar/native-collaboration/check-workspace`，不应把生产仓库当作连接测试目录。
4. 确认哪些用例允许消耗订阅额度。只有明确同意后才点击带有“使用订阅额度”的按钮或提交会运行原生模型的任务。

不要为了制造“崩溃”而终止真实 Desktop、Resident daemon 或原生进程，也不要通过提示词假定某个原生 driver 一定会失败或在取消时保持运行。故障恢复和未决效果只在一次性 fixture 中验证；真实运行中若取消时任务已经结束，应记录“未覆盖进行中的取消”，不能把它写成取消成功或取消失败。

## 从最小集合开始

第一次安装验收建议只做以下四项：

- **M-01 状态与入口**：确认 `智能协同` 入口、设置区、窄窗口布局和无模型刷新。
- **M-02 Codex canary**：点击“测试 Codex（使用订阅额度）”。
- **M-03 Claude canary**：点击“测试 Claude Code（使用订阅额度）”。
- **M-09a 循环图负例**：使用 keyless fixture 验证无提交的 `GRAPH_INVALID`；该项不消耗额度。

如果 M-01 显示 Resident 不可用，先记录原样错误并停止依赖 Resident 的手工用例；不要用单次 provider 静默替代 Resident。两个 canary 都需要明确的额度许可，状态刷新和负例不需要模型请求。

## 用例和判定

下表先区分证据来源。`UI` 表示在官方 Desktop 的普通用户路径执行；`fixture` 表示在 disposable home、注入的 native driver 或协议 double 中执行。keyless fixture 不证明用户已登录的 provider 行为，也不证明安装后的 UI；UI 的一次提交回执也不等于终态成功。

| 编号 | 重点 | 执行面 | 模型/额度 |
|---|---|---|---|
| M-01 | 入口、状态、刷新不调用模型 | UI | 不消耗 |
| M-02 | Codex 连接测试和 marker | UI | 消耗；需明确许可 |
| M-03 | Claude Code 连接测试和 marker | UI | 消耗；需明确许可 |
| M-04 | 单次官方委派的回执与最终结果 | UI | 消耗；需明确许可 |
| M-05 | DAG 依赖与继承的 native session lane | UI + fixture | UI 消耗；fixture 不消耗 |
| M-06 | 暂停、恢复、取消的确认边界 | UI + fixture | UI 可能消耗；fixture 不消耗 |
| M-07 | 相同 command 去重与冲突输入 | fixture（UI 只做观察） | 不消耗 |
| M-08 | 过期 revision 拒绝 | fixture（UI 只做观察） | 不消耗 |
| M-09 | 循环、缺 Resident、unsupported selection | UI 状态 + fixture | 不消耗 |
| M-10 | 崩溃/未知效果不重放 | fixture only | 不消耗 |

### M-01：`智能协同` 入口和无模型状态刷新

**前提。** 目标 profile 已加载 collaboration；Resident 可以可用，也可以作为缺失服务的状态分支观察。窗口至少检查一次默认宽度和一次窄宽度。

**动作。** 在主对话中打开 `智能协同` 会话页；再从设置打开 `智能协同` 设置区。点击状态刷新一次，等待界面显示本次检查时间。不要点击 canary，不要提交任务图。

**应观察到。** 入口和设置区都可到达，文字在窄宽度不溢出；刷新后能分别显示 Resident、`solar_resident`、`solar_delegate`、`solar_coordinate` 以及两个官方 provider 的可用性。Resident 可用时显示“Resident 已连接，任务查询正常”或等价的明确状态；Resident 缺失时显示明确的 `RESIDENT_UNAVAILABLE`/未连接原因，而不是一个看似成功的空任务列表。刷新只读取服务状态和已有任务，不请求模型目录、不提交 graph、不产生模型 turn，`checkedAt` 应更新。

**判定。** 只有在上述观察值都实际出现时才记为通过。若刷新触发模型目录或模型 turn、生成空成功结果、隐藏 provider 缺失、显示内部 graph/command id 作为常规标签，或默认宽度可见而窄宽度不可用，记为缺陷。缺 Resident 时状态分支本身是可通过的负例；不要因为没有任务就写成 Resident 正常。

### M-02：Codex 原生连接测试

**前提。** M-01 已显示 Resident 可用，并且已经获得一次订阅额度许可。Resident 的原生 Driver 使用 Codex 自己的认证；官方单次子智能体是否已注册是另一项状态，不是该测试的必要条件。不要重复点击同一个 pending canary；如果提交回执后尚未有结果，先通过任务检查观察同一 graph。

**动作。** 点击精确标签 **“测试 Codex（使用订阅额度）”**。插件应在自己的 check workspace 建立一次无文件、无工具的文本任务。

**应观察到。** 任务列表出现“Codex 原生连接测试”对应的任务，状态经过可观察的提交/执行过程后到达终态；节点结果应为 `SOLAR_CODEX_OK`（源任务要求只返回该 marker）。任务使用 Codex executor，graph 的工作目录是 `$DSH_HOME/solar/native-collaboration/check-workspace`，没有 `dsh_tools` bridge；测试提示词要求不读写文件、不调用工具，但回复 marker 本身不能证明这些限制得到遵守。原生产品仍可写自己的认证、会话和日志。界面显示的是已接收/执行/结果等翻译后的状态，不把内部 id 当作常规标题。

**判定。** “已提交”或“正在执行”只能证明回执/中间状态，不能单独通过。终态未到达或不是 `completed` 时，本用例不能通过，应保留原样错误。认证或外部服务不可用先记为阻塞，不能仅凭失败就断言插件有 bug。执行者错误、出现未请求的 DSH tool bridge、工作目录越界、自动创建第二次尝试，或状态声称成功但 marker 错误/缺失，属于具体缺陷证据。记录 provider/账号显示和额度实际使用情况，但不要估算 token 或费用。

### M-03：Claude Code 原生连接测试

**前提。** 与 M-02 相同，改为检验 Claude 原生 Driver；已获得一次订阅额度许可。官方 Claude Code 子智能体的注册状态不能代替原生认证检查。

**动作。** 点击精确标签 **“测试 Claude Code（使用订阅额度）”**。不要在结果未知时再次点击。

**应观察到。** 任务使用 Claude Code executor，在同一个 plugin-owned check workspace 内执行；终态节点结果应为 `SOLAR_CLAUDE_OK`，没有 DSH tools bridge。测试请求不修改工作目录，但不能从 marker 推导原生产品没有写会话或日志。任务详情应能区分 Claude Code 与 Codex，不把两者合并为一个泛化的“模型成功”。

**判定。** 只有 provider、工作目录、marker、无 bridge 和终态都符合才通过。Claude 原生认证失败或未返回结果应保留原样错误并记录为未通过/阻塞；不得改用 Codex 作为静默 fallback。

### M-04：单次官方委派的“回执”和“最终结果”

**前提。** 只验证一个 executor 即可，Resident 可不安装；官方 provider 已可用。准备一个现有的临时目录 `<WORKSPACE>`，其中有可读取的 `README.md`。该操作会消耗所选官方 provider 的额度。

**可复制的 DSH 对话提示。** 把 `<WORKSPACE>` 替换为已存在的绝对路径，然后要求 DSH 调用已知 schema 的 `solar_delegate`。下面的 JSON 字段与工具 schema 一一对应；不要添加 `profile`、`session_key` 或 `dsh_tools`，因为 `single` 模式明确拒绝这些字段。

```text
请只调用一次 solar_delegate，使用 single 模式委派给 Codex。参数如下；把 cwd 替换成我提供的临时工作目录：
{
  "executor": "codex",
  "mode": "single",
  "cwd": "<WORKSPACE>",
  "scope": { "read": ["README.md"], "write": [] },
  "task": "只读取 README.md 的第一行并返回该行，不修改任何文件。",
  "expected_result": "返回 README.md 第一行，并说明实际读取结果。",
  "verification": "说明是否实际读取；未运行的检查明确写未运行，不要宣称未执行的验证。"
}
```

**应观察到。** `solar_delegate` 先返回“已接收”及子任务引用（这是 acceptance acknowledgement）；随后官方子任务运行时把 child 的终态结果交付给父任务。回执不应把尚未完成的 child 写成最终成功。`single` 应调用公开的官方 subagent activation，并保留真实父 Agent、父取消信号和 `delivery: "parent"` 语义；不应创建 Resident graph 或改变 DSH 主模型、账号、provider。

**判定。** 只看到回执没有最终结果时记为未完成；最终结果必须说明实际读取和未运行的检查。child 被静默切换到另一个 executor、添加了不支持的 profile/session/tool 覆盖、回执丢失或插件停止了无关 child，均为缺陷。未知结果时不要重发同一请求。

### M-05：DAG 依赖顺序与继承的 native session lane

**前提。** Resident 可用；准备现有临时目录 `<WORKSPACE>`。手工 graph 会运行两个原生节点并可能消耗额度。继承 lane 的精确身份由 fixture 验证；UI 不应把内部 native session id 作为常规标签。

**可复制的 DSH 对话提示。** 要求调用 `solar_coordinate`，用 explicit executor 免除自动 catalog 选择；不要提供 `dsh_tools`。将 `<UNIQUE>` 换成一次性 ASCII 后缀，将 `<WORKSPACE>` 换成绝对路径。

```text
请调用 solar_coordinate 提交下面的 TaskGraph；不要添加 dsh_tools，也不要改写 dependsOn 或 sessionKey。使用 Codex 的 native default，不要猜测或切换账号：
{
  "formatVersion": 1,
  "id": "manual-deps-<UNIQUE>",
  "label": "manual dependency and lane check",
  "cwd": "<WORKSPACE>",
  "maxParallel": 1,
  "nodes": [
    {
      "id": "first",
      "executor": "codex",
      "sessionKey": "manual-lane-<UNIQUE>",
      "prompt": "只回复 FIRST_OK；不要读取、创建或修改文件，不要运行命令，不要调用工具。"
    },
    {
      "id": "second",
      "executor": "codex",
      "dependsOn": ["first"],
      "sessionKey": "manual-lane-<UNIQUE>",
      "prompt": "只回复 SECOND_OK；不要读取、创建或修改文件，不要运行命令，不要调用工具。"
    }
  ]
}
```

**应观察到。** `first` 先成功后，`second` 才进入可调度/执行；`first` 失败时，`second` 应为 blocked，不能因依赖失败而执行。两个节点的相同 `(executor, cwd, sessionKey)` 应继承同一个已确认的 native lane；这项身份连续性以 Resident snapshot/events 或 keyless fixture 的 `nativeSessionId` 证据为准，不以两个输出看起来相似来推断。

**判定。** 依赖被忽略、后继在前驱未成功时执行、lane 被静默替换、profile/bridge catalog 改变后仍复用旧 lane，均为缺陷。手工任务若在第二节点前已结束或 UI 不呈现 lane 连续性，记录“依赖已观察；lane 连续性未在 UI 覆盖”，不要伪造通过。

### M-06：暂停、恢复、取消及确认边界

**前提。** Resident graph 已提交且任务列表可检查。准备一个至少包含两个节点的任务图；不要通过提示词要求模型“故意卡住”。暂停/恢复/取消实际运行的 graph 可能消耗额度。

**动作。**

1. 在 graph 处于 `queued` 或 `running` 时点击“暂停后续调度”，然后刷新检查。观察新节点不再 admission；已经 `running` 的节点可以继续。
2. 使用任务详情中的最新 revision 点击恢复，观察 graph 回到可调度状态。若页面提示 revision 已变化，先刷新检查，不要盲点重试。
3. 只有在 UI 明确显示有 `running` 节点时才点击一次“请求中断任务”。预期先出现“正在请求中断，尚未确认停止”（`cancelling`）；原生 driver 确认终态后才可显示 `cancelled`。若中断结果无法确认，预期是 `indeterminate`，并保留 lane/scope fence。若点击前任务已终态，只能验证等待节点取消，不能声称覆盖了进行中的中断。

**判定。** 取消按钮的点击回执不是停止证明；UI 在确认前显示 `cancelled`、超时后自动发起第二个 command、用旧 revision 成功修改、暂停期间仍接纳新节点、或对 `indeterminate` 自动重试，均为缺陷。取消后的原生产品可能仍有已发生的额度消耗，不能把取消写成退款。

### M-07：相同 command 去重与冲突输入（fixture only）

**前提。** 使用 disposable home 和注入的 driver/bridge fixture；不要在生产 profile 中构造相同内部 command id，也不要用 UI 的重复点击代替这个测试。此用例不登录、不调用模型、不消耗额度。

**动作和证据。**

- 对同一个 graph admission 或 bridge call，重复提交完全相同的 `command_id`、kind 和输入。预期第二次返回原始 receipt，native effect/bridge effect 计数保持 1。
- 复用相同 command/call identity 但改变参数（例如 bridge call 的 path），预期返回 `COMMAND_CONFLICT`，不执行第二个 effect。
- 如果 UI 的一次 mutation 返回未知/超时，手工只刷新并检查原 graph；不要为了“确认”再次提交。

**对应 fixture。** `incubator/native-resident/tests/core.engine.test.ts` 覆盖持久化 admission、bridge receipt 的一次 effect 和冲突输入；`incubator/native-collaboration/tests/control.test.ts` 覆盖未知控制结果不自动重试。具体 fixture 的通过不等于已安装 UI 的通过。

**判定。** 相同输入产生第二次 native effect、冲突输入被当作原 receipt、未知效果自动重放，均为缺陷。预期的 `COMMAND_CONFLICT` 是通过的负例。

### M-08：过期 revision 拒绝（fixture；UI 只观察）

**前提。** 使用 disposable Resident fixture；UI 不一定暴露内部 `commandId` 或 `expectedRevision`，所以不要从常规标签猜测这项结果。

**动作和证据。** 先 inspect 得到 revision `r`，再用另一个合法 control 使 graph revision 前进；随后用旧的 `expectedRevision: r` 发起 pause/resume/cancel 或 resolve。预期返回 `REVISION_CONFLICT`，graph 不发生这次旧控制请求要求的 mutation。调用者必须重新 inspect 后再由所有者决定下一步；系统不能把旧操作改写成新 command 自动重试。

**UI 观察。** 若两个窗口或一个过期页面触发控制，页面应显示 revision 冲突并保留最新任务引用；不要显示“已暂停/已取消”作为确定结果。该行为若 UI 不可达，记录 fixture 结果和 UI 未覆盖范围。

**判定。** 接受旧 revision、悄悄读取新 revision 后重试、冲突后丢失 graph，均为缺陷。预期 `REVISION_CONFLICT` 是通过的负例。

### M-09：循环、缺 Resident、unsupported selection

这是三个互不替代的负例；任何一个预期错误都不能通过静默 fallback 来“修复”。

**M-09a 循环图（fixture，推荐最小集合的一部分）。** 给 `solar_coordinate` 一个两个节点互相 `dependsOn` 的 graph。预期在 allocation 或 Resident submit 前拒绝，错误为 `GRAPH_INVALID`/dependency cycle；`resident.submit` 不应被调用，不消耗额度。

**M-09b 缺 Resident（状态 UI + fixture）。** 在 disposable fixture 中不提供 `solarNativeResident`，刷新 `智能协同` 状态。预期 `resident.available: false` 并显示明确的 `RESIDENT_UNAVAILABLE`/未连接原因；inspect、control 和 canary test 都应明确失败。不要在有实际任务的 profile 中禁用或停止服务来制造该状态，也不要退回单次 provider。

**M-09c unsupported selection 或无 catalog（fixture）。** 提供未在 Resident catalog 宣告的 reasoning effort，或让自动 allocation 没有可用 catalog。预期显式拒绝（例如 `not advertised` 或 “requires the Resident model catalog”），不切换到另一个模型/账号、不提交 graph。显式 executor/model 在 catalog 不可用时可以按合同使用该 native selection；不能把这条能力误写成自动选择成功。

**对应 fixture。** `incubator/native-collaboration/tests/coordinate.test.ts` 覆盖循环、unsupported effort、缺 catalog 和 explicit selection；`incubator/native-collaboration/tests/control.test.ts` 覆盖缺 Resident 的状态与控制错误。预期 validation error 是通过。

### M-10：崩溃或未知效果不重放（fixture only）

**前提。** 仅使用 disposable database、注入 driver 和已有 crash/recovery fixture；不要终止真实进程，不要让生产 graph 进入未决状态，不要用提示词要求模型崩溃。

**动作和证据。** 由 fixture 模拟 daemon 在原生 effect 已写入 admission、但结果未确认时退出，再重新打开同一数据库。预期原 graph/node 进入 `indeterminate`，attempt 数不增加，已有 session lane 和冲突 scope 保持 fence，系统不再次调用 native driver。只有 owner 明确作出 `resolve_fail` 或 `resolve_retry` 决定后，相关后续工作才可按实际结果继续；`resolve_retry` 只是一次新的明确尝试，不证明原 effect 没有发生。

**对应 fixture。** `incubator/native-resident/tests/core.engine.test.ts` 的 crash recovery、unknown cancellation、lane/scope fence 用例覆盖该边界。它们使用 controlled fixture；不能把 fixture 的 SIGKILL 或数据库编辑步骤复制到用户的生产环境。

**判定。** 重启后自动重发、把未知结果显示为成功、释放 fence 后让同一 lane 继续、或没有人工 resolution 就继续 downstream，均为缺陷。`indeterminate` 加上明确的人工处理要求是预期通过证据。

## 记录模板

每个 case 单独填写；“通过”只表示实际观察到合同规定的证据，不表示模型质量、代码正确性或计费金额。

```text
Case ID / 名称：
执行面：UI / keyless fixture / 两者
执行时间：本地时区；原始 UTC：
官方 Desktop / plugin 版本：
目标 profile：
Resident / provider 可用性（原样记录）：
是否有额度许可：是 / 否 / 不适用
额度结果：未使用 / 已使用（不估算金额）/ 未知
动作摘要（不含凭据）：
graph label 或任务标签（分享时隐藏内部 id）：
观察到的状态序列：
观察到的 revision：
节点结果、error code/message、canary marker：
依赖顺序或 session lane 证据：
是否发生重复 native/tool effect：
截图/日志/fixture 证据位置（去除 token 和个人路径）：
判定：通过 / 失败 / 未运行 / 阻塞
缺陷或未覆盖范围：
```

`未运行` 用于尚未获得安装或额度授权；`阻塞` 用于缺少真实 provider、Resident 或其他外部前提；`失败` 用于已执行且观察到不符合合同的结果。加载插件、看到入口、收到提交回执或 fixture 通过，都不能单独写成整体验收通过。
