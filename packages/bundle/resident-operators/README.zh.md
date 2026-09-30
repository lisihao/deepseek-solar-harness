# @deepseek-ai/dsh-resident-operators

[English](README.md) | 中文

可选 Bundle：提供稳定的 `codex` 与 `claude-code` 物理算子，两者都保留向后兼容的 ephemeral 执行与显式 resident 执行。所有路径都使用用户的产品原生订阅，本 Bundle 不包含 API-key fallback。

把预构建包加入 profile，并在 `dsh.profile.bundles` 中包含该 Bundle；通过 `dsh --profile <name> --dump-config` 检查最终 composition。移除 Bundle 会卸载工具、路由器和 Resident 客户端，但不删除 daemon 状态或产品原生 Session。

## Composition

Patch 挂载 physical-operator Service Definition、Resident Service Definition、本地 Resident Provider、现有 Codex 与 Claude Code subagent Provider、模式感知路由器、唯一模型 Consumer 以及基于 SQLite 的 `modelCatalogs` 服务。路由器依赖 definitions 而非实现内部；Consumer 只依赖 physical definition。一次显式刷新会分别调用 DeepSeek `GET /models`、全新的 Codex 元数据、Claude Code 显式的 `supportedModels` 目录和已启用的 Web picker，各调用一次；普通读取使用持久化快照，UI 面板复用缓存结果。完整目录和来源状态都会持久化：被移除的条目标记为不可用，刷新失败则保留为未知且不进入菜单。菜单按最新旗舰/主线策略（DeepSeek Pro/Flash、Codex Astra/最新 Sol、Web Pro/Thinking）为 DeepSeek、Codex 和 Web 各提供最多两个可用入口，缺少家族时按上游顺序回退；Claude 刷新的目录只为提供方使用而存储，不作为主菜单来源。该策略不是基准排名，也不会安装或发布提供方软件。该 patch 还挂载 `@deepseek-ai/dsh-model-allocation-local`，智能协作每次委派都会向它询问协作者、模型和强度。

默认执行模式保持 `ephemeral`。Resident Session 按工作区确定。Bundle/HMR 释放只断开客户端，不停止独立 daemon；禁用 Bundle 会恢复现有一次性路径，并保留 SQLite、Artifact 与产品原生 Session。

## Model Experience

模型通过一个 `physical_operator` 工具间接调用。新 Session 缺省使用“智能自动”路由，因此主 Agent 无需等待用户点名产品，就能选择合适的算子并显式请求 resident 连续性。底层 run 请求在省略 `mode` 时仍缺省为 ephemeral，以保持第三方兼容性。

#### KV Cache effect

Enabling the bundle adds the physical-operator tool schema to the deployment prompt.

## Known Limitations and Deferred Work

- Bundle 为 opt-in，不修改默认 DSH profile。
- RLM 与 Continuous Harness 属于独立 TaskGraph Bundle 的编排策略，两者都不是物理算子。
- 当前不包含人工写接管、亲和调度、durable Jobs 投影或远程算子池。
