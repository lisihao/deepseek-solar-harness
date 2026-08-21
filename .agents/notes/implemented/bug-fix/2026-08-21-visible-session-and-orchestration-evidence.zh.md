# Agent Note: 可见的会话与编排证据

Status: implemented

[English](2026-08-21-visible-session-and-orchestration-evidence.md) | 中文

## 问题

两项展示选择让已保留的证据看起来像不存在。编排面板会从默认列表中静默删去每个本地验收 Run，因此只有验收 Run 的安装看起来是空的，尽管 SQLite 和 daemon 仍然保留它们。Code-as-Harness 治理使用了占用持久导航空间的左侧栏 action，并且解析全局当前会话，而不是接收所选会话视图拥有的会话。它的空状态文案还描述了 DSH 会话日志无法观察的外部任务边界。

编排事件时间线能证明 Resident 算子已派发并保存 Evidence 引用，但它省略了提供方无关的执行阶段和算子最终面向用户的输出。用户无法从同一个 Trace 区分活动的 Codex 或 Claude Code 执行与停滞的派发，也无法检查其结果。

## 决策

编排 Host 投影使用 `diagnostic: true` 对临时 `dsh-orchestration-*` Run 进行分类，并默认包含它们。Desktop 列表将其标记为验收记录，并提供明确的显示／隐藏控制；隐藏只改变投影，并保留诊断记录数量。选中 Run 后仍保留完整的已过滤列表，同时添加该 Run 的有界事件。

编排 daemon 通过不会覆盖并发推进 Run 快照的仅事件存储操作，将有界、提供方无关的 Resident 进度阶段复制到 `node.operator.progress` 事件。结算会把完整结果保存在其内容寻址的 Evidence 产物中，并把最多 8,000 字符的面向用户的输出预览、截断标记、算子 id 和停止原因添加到已接受或已失败事件。Desktop 协作 Trace 渲染这些阶段、输出和 Evidence 引用。它绝不投影私有推理文本、提示词、终端屏幕或产品本地 transcript。

Code-as-Harness 治理插件 0.3.9 将“治理 Trace”注册为 order-15 的 `conversation.view` 配置项。slot 传入确切的 `sessionId`；视图只获取并刷新该会话的实时或持久治理投影。左侧栏入口和模态窗口不再存在。空状态文案会说明，外部 Codex 任务和 GitHub Actions 是独立权威，不会自动进入所选 DSH 会话日志。

本记录仅取代 [Resident 资格探测与诊断投影隔离](2026-08-20-resident-qualification-and-diagnostic-projection.md) 中的默认隐藏展示决策。其 Resident 资格探测、串行探测和临时工作区分类仍然有效。

## 验证

提供方测试固定了可见的诊断分类、可选隐藏、Resident 进度传递、Codex 与 Claude Code 派发、有界输出投影和 Evidence 保留。客户端测试固定了每会话视图 slot、确切会话 id 请求、不出现在左侧栏、诊断控制、进度标签和最终输出渲染。打包验收会运行两种原生订阅产品，并通过已安装 Desktop 投影观察它们对应的进度、结果和 Evidence 事件。

## 考虑过的替代方案

**删除或继续静默隐藏验收 Run。** 删除会破坏持久测试证据。静默默认隐藏虽保留字节，却使只有验收记录的安装无法与历史丢失区分。可见分类让证据易于理解，并让用户选择展示方式。

**保留一个全局左侧栏 Trace。** 全局当前会话查找可能偏离用户所选标签，并永久占用导航空间。会话范围的对话视图从 slot 约定接收身份，并与 Memory 和 Trajectory 视图遵循相同的选择生命周期。

**将完整 Resident transcript 复制到编排事件。** 这会复制无界产品历史、私有推理和终端活动。提供方无关的阶段加上面向用户的输出和不可变 Evidence 引用，可以在不改变隐私或存储边界的情况下显示执行与结果。

## 后果

重启后保留的验收历史可见，且绝不会被误认为用户工作。每个会话拥有自己的治理 Trace，编排 Trace 则单独解释智能派发和执行。普通输出可在行内阅读；较大输出会显式标记，并继续保留在 Evidence 产物中。进度投影会在执行期间添加有界事件，因此消费方必须将 `node.operator.progress` 视为观察而不是完成证据；只有终态 Evidence 事件才能证明节点结果。
