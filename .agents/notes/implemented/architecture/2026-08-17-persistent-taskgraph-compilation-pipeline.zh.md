# Agent Note: 持久化 TaskGraph 编译流水线与单调能力绑定

Status: implemented

[English](2026-08-17-persistent-taskgraph-compilation-pipeline.md) | 中文

## Problem

现有 workflow engine 执行前台的模型编写脚本，jobs registry 属于进程内状态，Resident Physical Operator 只持久化原生产品连续性而不拥有 TaskGraph。因此复杂任务缺少一个负责依赖就绪、效果冲突、审批、重试、Evidence 与恢复的持久权威。若把规划、知识检索、能力发现与派发全部塞进 Scheduler，后续 Intent 或 Context Compiler Provider 将能修改执行状态，并在 Scheduler 旁产生第二套权威。

## Decision

`dsh-orchestratord` 是持久编排状态的唯一写者。它在 Harness home 下的单个 SQLite WAL 数据库中保存已认证逻辑图、节点状态、attempt、Evidence 引用、不可变编译 Artifact 和 append-only 事件。可释放的 `ctx.orchestrations` Provider 通过仅属主可访问的本地 IPC 连接（POSIX 使用 Unix socket，Windows 使用本地命名管道），因此 DSH 与 Desktop 重启不会停止已接纳 Run。

打包后的 Desktop 使用 `desktop-<SemVer>` 作为 daemon build identity。客户端以 `ORCHESTRATION_VERSION_MISMATCH` 拒绝协议、schema、方法集或 build 不一致；自动启动会先让不兼容 daemon 退出，再让已安装版本复用同一持久状态启动。开发 composition 在调用方未提供 `DSH_BUILD_COMMIT` 时继续使用显式的 `development` identity。

Run 编译使用有序不可变流水线：原始请求依次形成 `IntentIRV1`、requirement Artifact、逻辑 TaskGraph、验证、Plan Certificate 和 Run。ready 节点依次经过能力解析、上下文编译、算子选择、ExecutionPlan seal、审批和派发。`ctx.intentCompiler`、`ctx.contextCompiler` 与 `ctx.capabilityCapsules` 是独立 Provider seam；它们都不能创建 Run、修改 Graph 或派发算子。

认证 Graph 是每个节点的最大权限。晚绑定胶囊可以实现或收缩 capability、effect、scope 与已审批 secret 预算，但不能扩大它们。必需的扩权会让 Run 以新 Graph revision 和 certificate 返回审批。每个已接纳 physical attempt 都使用新的稳定 `orch:<run>:<node>:<attempt>` execution identity 和不可变 `NodeExecutionPlanV1`；重试不改写已接纳 attempt，indeterminate receipt 不会自动重放。

当前产品 Provider 只在派发前和下一 Turn 绑定胶囊。能力更新词汇包含 generation 与 checkpoint 状态，但 Claude Code 和 Codex 不声明 Turn 中 checkpoint 支持。事件与结果按 attempt 和 capability generation 隔离，较旧的迟到结果不能结算较新的执行。

AI4Research 只是通用调度经验的只读来源，不是运行时依赖或第二状态权威。其研究工作流、Sprint 词汇、Evidence Schema、tmux 传输和文件型 Graph 状态不会进入这些包。

## Alternatives considered

- **扩展 workflow engine** — 它的模型编写前台脚本与进程持有的子任务生命周期无法提供持久 Graph revision、receipt 或崩溃对账。
- **把 jobs registry 当作 Scheduler** — jobs 提供通用后台执行，但不拥有依赖、scope、effect、审批或 Evidence 语义，当前本地 Provider 也不能跨进程重启持久化。
- **在 Scheduler 内放 Compiler hook** — 任意 hook 能修改 live state，并使 Compiler 升级改变已接纳 attempt。版本化 Artifact 与 capability seam 能保留可复现性。
- **用 `dynamicCordisRunner` 承载胶囊** — 模型生成的进程内包既没有持久目录身份，也没有认证权限上限。
- **复制 AI4Research Scheduler 与 tmux carrier** — 这会复制研究专属状态并形成两套 TaskGraph 权威。DSH 实现只参考通用算法与 golden case。

## Consequences

Daemon 与 Artifact store 增加了一个本地进程和 forward-only state schema，用户则获得跨重启持续的 Graph 执行与单一可审计状态权威。每个 attempt 会增加编译步骤，但其 capability、context、operator、approval 与 verification 输入都可以按内容验证。高级 Intent、Context 和 Capsule Provider 可以替换基础 Provider而不改变 Scheduler 状态转换。真正的 Turn 中能力变更仍需 Physical Provider 提供稳定 checkpoint 与按 generation 隔离的续接能力。
