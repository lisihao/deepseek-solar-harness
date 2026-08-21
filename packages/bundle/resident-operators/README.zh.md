# @deepseek-ai/dsh-resident-operators

[English](README.md) | 中文

可选 Bundle：提供稳定的 `codex`、`claude-code` 与 `prime-agent` 物理算子。Codex 和 Claude Code 保留向后兼容的 ephemeral 执行与显式 resident 执行；Prime Agent 仅支持 resident。所有路径都使用用户的产品原生订阅，本 Bundle 不包含 API-key fallback。

把预构建包加入 profile，并在 `dsh.profile.bundles` 中包含该 Bundle；通过 `dsh --profile <name> --dump-config` 检查最终 composition。移除 Bundle 会卸载工具、路由器和 Resident 客户端，但不删除 daemon 状态或产品原生 Session。

## Composition

Patch 挂载 physical-operator Service Definition、Resident Service Definition、本地 Resident Provider、现有 Codex 与 Claude Code subagent Provider、独立 Prime Agent Driver 模块、模式感知路由器，以及唯一模型 Consumer。Driver 模块只依赖公开 Resident SPI；路由器依赖 definitions 而非实现内部；Consumer 只依赖 physical definition。

默认执行模式保持 `ephemeral`；如果请求选择仅支持 resident 的 Prime 却未设置 `mode=resident`，系统会明确失败。Resident Session 按工作区确定。Bundle/HMR 释放只断开客户端，不停止独立 daemon；禁用 Bundle 会恢复现有一次性路径，并保留 SQLite、Artifact 与产品原生 Session。

## Model Experience

模型通过一个 `physical_operator` 工具间接调用。新 Session 缺省使用“智能自动”路由，因此主 Agent 无需等待用户点名产品，就能选择合适的算子并显式请求 resident 连续性。底层 run 请求在省略 `mode` 时仍缺省为 ephemeral，以保持第三方兼容性。

#### KV Cache effect

Enabling the bundle adds the physical-operator tool schema to the deployment prompt.

## Known Limitations and Deferred Work

- Bundle 为 opt-in，不修改默认 DSH profile。
- Prime Agent 必须在 Prime 中通过 `/login` 登录；`openai-codex` OAuth 资格通过前，Bundle 会明确显示其不可用。
- 当前不包含人工写接管、亲和调度、durable Jobs 投影或远程算子池。
