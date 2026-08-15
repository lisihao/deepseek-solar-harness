# @deepseek-ai/dsh-physical-operator-subagent

[English](README.md) | 中文

本包是首个物理算子 Service Provider。它把部署稳定的算子 ID 映射到现有 `ctx.subagents` Provider，使 DSH 能通过统一的物理算子约定调用 Codex、Claude Code 或其他已注册的执行产品。

## 配置

```yaml
- id: physical-operator
  name: '@deepseek-ai/dsh-physical-operator'

- id: physical-operator-subagent
  name: '@deepseek-ai/dsh-physical-operator-subagent'
  config:
    operators:
      - id: physics-codex
        provider: codex
        displayName: Physics via Codex
        description: Solves one bounded physics task with Codex.
        tags: [physics, codex]
        maxConcurrency: 1
      - id: physics-claude-code
        provider: claude-code
        displayName: Physics via Claude Code
        description: Solves one bounded physics task with Claude Code.
        tags: [physics, claude-code]
        maxConcurrency: 1
```

| 配置键 | 含义 |
|---|---|
| `operators[].id` | 调用方可见的稳定算子 ID。 |
| `operators[].provider` | 现有 `ctx.subagents` Provider 名称。 |
| `displayName` / `description` | 发现界面的展示信息。 |
| `tags` | 可选的选择提示，不具备权限语义。 |
| `maxConcurrency` | 每个 ID 的快速失败容量，默认为 `1`。 |

即使后端 subagent Provider 尚不存在，映射也会注册。此时发现结果报告 `unavailable`；Provider 加载或重载后会自动转为可用。加载本插件不会启动子进程，也不会探测产品二进制。已接受的调用通过 `ctx.subagents.start` 委托，并保留调用方的父 agent 与取消信号；subagent Provider 仍是生命周期和资源释放的责任方。

Provider 与 Consumer 包只依赖 Service Definition，绝不互相 import。本包不添加调度器、持久化、命令 receipt、模型选择、子进程实现或 AI4Research 业务代码。

## 模型体验

模型体验由 `dsh-tool-physical-operator` 间接提供；后端的 `codex`、`claude-code` 或未来 Provider 传输均隐藏在一个稳定算子 ID 后面。

#### 对 KV Cache 的影响

本包不会直接改变父级前缀；只更换部署映射时，Consumer 的工具 schema 保持稳定。

## 已知限制与后续工作

- **单次 subagent 传输**：本包不增加续接、进度流、持久化执行记录或跨进程恢复。
- **面向文本的任务约定**：Provider 专用物理输入、类型化工件与 schema 校验留待后续。
- **部署决定映射**：本包不负责 Provider 间的评分、基准、路由、故障切换或负载均衡。
- **Provider 副作用仍归 Provider 所有**：取消不能撤销 Provider 停止前完成的文件或外部操作。
