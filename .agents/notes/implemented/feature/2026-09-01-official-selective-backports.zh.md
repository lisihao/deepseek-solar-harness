# Agent Note: 选择性回迁官方 Harness 行为

Status: implemented

[English](2026-09-01-official-selective-backports.md) | 中文

## Problem

官方 DeepSeek Harness 在 Solar 源码基线之后的版本可能包含有价值的修复，但其架构与持久化约定仍处于实验期。整仓合并还会引入删除 SQLite Session 持久化、继续使用一次性 Codex／Claude 子 Agent 等不兼容选择。仅凭发布说明文字相似，不能证明某项官方行为在 Solar 中确实缺失且兼容。

## Decision

Solar 在隔离 worktree 中评审每个官方版本，只复制 Solar 尚未具备且不会改变既有权威边界的行为。首轮评审覆盖官方 `dsh-v0.1.2-alpha.1` 至 `dsh-v0.1.2-alpha.3`；评审的官方源码提交为 `dd6322d604e00eec1ba5e0c8541159906a21094a`，Solar 对照源码提交为 `cf4ffebc4f4ef329ebc510c5098da9f8c36e0760`。

以下忠实度矩阵记录最终的归属与兼容决策。

| 官方行为 | Solar 决策 | Solar 适配 | 证据 |
|---|---|---|---|
| `read_image` 接受无扩展名的 PNG／JPEG／WebP／GIF 路径 | 回迁 | 保留 Solar 的附件与模型路由权威；仅在缺少扩展名时嗅探签名，随后沿用既有有界读取与附件权威解码 | 签名、无扩展名成功、非图片字节和既有类型不匹配测试 |
| Tab 补全高亮的斜杠候选项 | 回迁 | 扩展既有 textarea 触发器仲裁，不引入官方 Lexical 编辑器 | 触发器控制器与 InputBar 键盘测试 |
| 后端缓慢时不误判为断线 | 回迁 | 保留 Solar 的双 WebSocket 加 `host.describe` 握手；阈值只告警，不发布 `connected`，也不中止仍存活的 generation | 慢打开、真实丢失、describe 失败与重连测试 |
| 屏幕外代码块和读取卡延迟语法高亮 | 回迁 | 复用 Solar 的 Shiki 白名单与纯文本回退，使用一份共享、单向激活的 `IntersectionObserver` | 代码块、读取卡、不支持语言、回退和清理测试 |
| 精确 token、耗时、首 token 和吞吐显示 | 等价 | 保留 Solar 的全日志 `sessionStats` 与 `tokenUsage` 投影 | 既有对话与轨迹测试 |
| 未知外部 Session 事件可标记为 ignorable | 等价 | 保留 Solar 的 `SessionEvent.ignorable` 兼容约定 | 既有持久化与冷加载测试 |
| Codex 与 Claude 模型选择 | 已超越 | 保留 Solar 的持久 Resident 算子、订阅资格审查、协作策略和 Trace 投影 | Resident 与 Desktop 验收门禁 |
| 覆盖未加载回合的全会话导航轨及定向分页 | 暂缓 | 该行为依赖官方 Session Controller 与新 `turnOutline` 投影，需要专门的投影兼容决策 | 不声称完成 |
| 排队图片缩略图与可续接子 Agent 图片 follow-up | 暂缓 | 官方补丁横跨附件准入、Session Controller、子 Agent continuation 和队列呈现，必须保持为一个原子契约变化 | 不声称完成 |
| 日程目录／页眉与插件列表呈现优化 | 暂缓 | 必须先与 Solar 的 Desktop 侧栏和远程／前端呈现协调，不能覆盖产品专用界面 | 不声称完成 |
| 删除 SQLite Session 持久化后端 | 拒绝 | Solar 已发布的 Session、Resident、编排与远程同步恢复约定继续保留持久状态 | 既有持久化继续作为权威 |
| 用官方 API／远程架构替换 Solar，或把 Resident 降级为官方一次性子 Agent | 拒绝 | 这些属于架构迁移，不是孤立行为回迁 | N/A |

一手来源是官方 [alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)、[alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2)与 [alpha.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3)发布和源码标签。

Desktop `3.10.0` 将受影响的五个 Solar 工作区包（`client-connection`、`client-ui-conversation`、`client-ui-input-trigger`、`client-ui-primitives` 与 `tool-fs`）密封为本地 tarball 输入。这样会替换此前解析到已发布官方 `rc.6` 包的四个 UI／工具依赖，使安装产品执行的是已经评审的 Solar 适配，而不是无边界引入整个官方包载荷。

## Alternatives considered

**把官方 master 合并进 Solar。** 不采纳，因为它会把面向用户的修复与不兼容的持久化、API、Client 和子 Agent 架构变化绑在一起。随后的冲突处理会变成一场隐蔽迁移，而不是有界回迁。

**复制发布说明中列出的每一项。** 不采纳，因为 Solar 已经实现或超越其中若干项，其他项目则依赖 Solar 当前刻意不采用的官方子系统。

**在官方稳定前完全不吸收修复。** 不采纳，因为局部且有测试的行为修复可以改进 Solar，而无需承诺采用周边官方架构。

## Consequences

Solar 获得四项可独立验证的行为，同时不改变插件、持久化、Resident、编排或远程权威边界。Desktop 包边界现在对每个受影响包都清晰可见，代价是在既有密封输入平面中增加四个经评审的 tarball。后续评审必须对照源码与运行时行为，而不能按名称判断；相关输入未变化时要复用既有证据；当官方等价实现满足 Solar 的更强约定后，应退役 Solar 补丁。暂缓的 Session 导航与图片传递工作保持明确未完成，不用占位接口伪装已交付。
