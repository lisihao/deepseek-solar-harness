# Tool Debate

[English](README.md) | 中文

这是 `ctx.debates` 面向模型的 Consumer。它注册一个有界 `debate` 工具，用于启动、列出、检查持久化 Debate Run，以及执行带 revision 栅栏的控制。独立的 `/debate-mode auto|enabled|disabled` 命令把当前会话的完整偏好记录为可忽略事件；旧会话默认 `disabled`。显式选择 `enabled` 也是宿主级执行选择：下一条直接用户消息会获得持久化 `debate/dispatch`，无需先调用主模型即可启动 Debate Provider，并把有界 synthesis 作为 assistant 回复返回。`auto` 仍是模型策略，不会无条件准入。

默认策略使用固定的四角色、订阅优先阵容：Codex Sol 建议者、Claude Fable 证伪者、Codex Sol 证据审计者，以及 Claude Opus 决策裁判。Run 在有证据的收敛或三轮上限时终止，保留重要异议，并只返回工件引用与有界投影，不内联大型报告。

本包只依赖 provider-neutral Debate Service Definition 与普通 Agent／LLM 扩展点，不导入本地 Provider、TaskGraph daemon 或物理算子运行时。物理算子宿主路由器会在持久化 Session 偏好明确启用 Debate 时独立让位，因此 Codex 与 Claude Code 仍是阵容内执行算子，不会取代 Debate Run。

## Model Experience

### 有界的 `debate` 工具

#### What the model sees

模型看到一个支持 start、list、inspect 和 revision-fenced control 的 `debate` 工具 Schema，以及稳定的 Debate 策略。结果只暴露 Run 状态、有界的角色/回合投影、Evidence 与 Artifact 引用、blocker 和归集状态。

#### Token effect

工具 Schema 与策略构成稳定的提示词前缀。结果保持有界；大型 synthesis 或 Evidence 内容通过引用返回，不直接内联。

#### KV Cache effect

稳定的 Schema 与策略保持其前缀。Debate 事件和有界结果只在工具调用后追加。

## Known Limitations and Deferred Work

- 本 Consumer 需要 `ctx.debates` Provider；它的宿主适配器只负责准入，Provider 与既有 TaskGraph 仍是唯一模型执行和调度权威。
- 旧 Session 默认使用 `disabled`；启用或选择 `auto` 是显式的逐 Session 偏好。
- Debate 是有界执行模式，不保证提高答案质量；真实质量结论需要独立的盲测评估证据。
