# Agent Note：原生订阅产品作为一等模型路由

Status: implemented

[English](2026-08-27-native-subscription-first-class-model-routes.md) | 中文

## 问题

DSH 已有一次性 Codex／Claude Code subagent Provider 和持久 Resident 物理算子层，但二者都不能让原生订阅完整取代主模型：普通 Agent Loop 仍需要另一条 LLM 路由作决定和委派，首次引导仍假设用户必须填写 DeepSeek 官方密钥，Resident 产品也只接收独立文本任务，而不是当前 Agent 已组装的系统指令与 DSH 工具。拥有有效 Codex 或 Claude 订阅的用户因此只能执行一个盒装 worker，不能在没有计量 API 路由的情况下运行 DSH。

协作 Trace 对这些路径也不一致。直接 Resident 结果只显示被截断的 assistant 预览，桥接 DSH 工具完全缺席，普通订阅 subagent 的模型可见工具结果也没有与路由和 TaskGraph 事件一起投影。

## 决策

`@deepseek-ai/dsh-tool-physical-operator` 拥有名为 `dsh-physical-operator` 的 LLM adapter 路由。当前可用的每个 Resident Codex 或 Claude Code descriptor 都成为该路由下可选择的模型。选择后，原生产品就是普通 Agent Loop 当前回合的主模型；不存在一个隐藏父模型先调用 `physical_operator`，也不会发送 DeepSeek 请求。

派发前，Consumer 会组装当前精确的 DSH system prompt 与模型可见 Tool schema。它把这些 schema 绑定到一个属主本地模型工具 socket，再把密封 descriptor 与 Resident 请求一并发送。协议 v9 同时携带 system prompt 与工具 descriptor。Claude Code 把前者追加到原生 preset，并通过进程内 Agent SDK MCP server 接收后者；Codex 则接收 developer instructions 与 app-server dynamic tools。调用回到原 Agent 的 `ctx.tools`，所以 scope、guard、approval、日志、插件所有权和渲染仍归 DSH。

工具桥追加可忽略的 `physical-operator/tool-call` 与 `physical-operator/tool-result` Session 事件。以原生调用身份和 canonical request hash 为键的 Receipt 会在 DSH 重载后从这些事件重建。重复同一个已结算调用会返回其结果；请求变化则冲突。只有调用事件而没有匹配结果的命令进入 indeterminate，绝不自动重放，因此 DSH 崩溃不会静默重复工具副作用。

RLM 保持独立密封表面。仅包含 `typescript_repl` 的工具桥继续维持 Prime 兼容的 RLM 隔离，不继承通用 DSH 工具目录；普通一等模型回合接收当前完整目录。产品私有推理与原始终端文本绝不进入 DSH Session。

Models 首次引导联接新增 `llm.models`。任何可执行的原生订阅路由都满足产品就绪条件，因此已通过资格审查的 Codex 或 Claude Code 用户不会因缺少 DeepSeek 凭据而被拦截。DeepSeek API 模型仍是可选同级路由。

Governance Trace 会一致投影一条 Session 谱系：路由与派发事件、精确的一等主模型最终文本、每个桥接 DSH 工具调用／结果、普通 `subagent_codex`／`subagent_claude_code` 调用／结果，以及 TaskGraph Evidence。TaskGraph 终态事件保留有界预览，经过认证的用户可以按需读取经 digest 校验的完整模型可见 Evidence。reasoning block 会被移除。

## 权威与生命周期

- DSH Agent Loop 继续拥有 turn、step、prompt 组装、Tool Runtime、Session 事件与 UI 投影。
- `dsh-resident-operatord` 仍是 Resident Receipt／Lease／Session 唯一写者，并拥有跨 DSH／Desktop 重启的原生续接。
- Codex 与 Claude Code 仍分别拥有自己的原生产品 Session 或 thread 与订阅认证权威。
- TaskGraph 仍是唯一多节点 Scheduler；主模型路由和模型工具桥都不创建队列或第二调度器。
- 属主本地工具桥只在 DSH Host attach 期间存在。Resident 原生 turn 可以跨 Host 重启继续，但 DSH 自有工具调用必须等待 Host 重新 attach 或明确失败；产品内置工具仍归产品所有。

## 验证

离线 composition 测试在不挂载 DeepSeek adapter 的情况下组合真实 Agent Loop seam。Codex 与 Claude fixture 分别把原生订阅路由选作第一模型。Codex fixture 经真实 JSON-RPC 执行一个已注册 DSH Tool，并断言精确工具结果与 Session 事件；Claude fixture 证明其路由接收同一份已组装系统与目录约定。重载覆盖会在桥 remount 后重复同一个已结算原生调用，并证明 DSH Tool 只执行一次。协议、Driver、引导、经 digest 校验的 Evidence 读取、Host／Client typecheck 与 Governance Trace 测试均不使用产品凭据或订阅调用。

发布验收只从已安装 Desktop 构建执行一次最小真实 Codex 订阅主 Agent canary 和一次最小真实 Claude Code 订阅主 Agent canary。每条都必须证明原生订阅资格、没有 DeepSeek key 或请求、一次 DSH Tool 调用、精确 Trace 输出、持久续接，以及源码／包／运行版本一致。

## 后果

Codex 与 Claude Code 可以作为 DSH 的一等主模型、Planner、TaskGraph worker 或普通 subagent。Subagent 模式仍适合隔离委派，但不再是唯一集成角色。原生产品获得 DSH 插件组合的系统和工具表面，同时无需把 Agent Loop 复制到任一 Provider；DeepSeek 配置后仍作为同级候选存在。

首发仍只接受文本 Resident prompt，尚未为一等 adapter 映射原生 token usage，也没有远程模型工具桥。这些限制必须明确展示，不能被描述成与每项 API adapter 特性完全对等。
