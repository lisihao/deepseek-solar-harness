# @deepseek-ai/dsh-browser-ego-lite

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-browser`](../browser/README.md) 的 Ego Lite Service Provider。它通过 `ctx.subprocess` 把 portable plan 和可信插件 program 翻译为单次 `ego-browser nodejs` 调用；Provider 与 Consumer 之间不会传递 Ego `targetId`、snapshot `@N` ref、原生 handle、profile 路径或 extension 消息。

适配器冻结于 upstream [`v1.2.5`](https://github.com/citrolabs/ego-lite/tree/v1.2.5) 与 commit [`fd3aae7146cf6c9c52014a9752f411bf9978ae93`](https://github.com/citrolabs/ego-lite/commit/fd3aae7146cf6c9c52014a9752f411bf9978ae93)。主要契约证据是 upstream [agent skill](https://github.com/citrolabs/ego-lite/blob/v1.2.5/skills/ego-browser/SKILL.md)、[stdin runner](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/run.ts)、[稳定错误码](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/ego-errors.ts)、[hard-stop output sink](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/output-sink.ts) 和 [update notice](https://github.com/citrolabs/ego-lite/blob/v1.2.5/package/ego-browser/src/update-notice.ts)。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `executable` | 自动发现 | `ego-browser` 绝对路径。省略时先探测 `/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser` 内置 helper，再回退到 `~/.local/bin/ego-browser`；不使用 shell 或 PATH 搜索。 |
| `cwd` | DSH 进程 cwd | 每次隔离命令使用的绝对工作目录。 |
| `graceMs` | `2000` | 托管进程树的终止宽限期。 |
| `stdoutMaxBytes` | `8388608` | 完整 framed stdout 上限；溢出返回 `BROWSER_OUTPUT_LIMIT`。 |
| `stderrMaxBytes` | `262144` | 保留的 stderr 诊断尾部上限。 |
| `operationTimeoutMs` | `30000` | 未提供 `timeoutMs` 时使用的 Provider 默认值。 |

配置的 executable 无效时插件加载失败。自动发现全部失败时仍注册不可用的 `ego-lite`，因此 `ctx.browser` 会在不启动进程的情况下返回 `BROWSER_UNAVAILABLE`。

## 进程与结果协议

每次调用都严格使用 `[resolvedExecutable, "nodejs"]`，不经过 shell，并把一个完整 JavaScript program 写入 stdin 后关闭。`ctx.subprocess` 负责凭据清洗后的环境继承、取消、进程树终止和有界输出收集。带固定前缀的单行 JSON frame 承载结果或稳定错误；所有 subprocess JSON 在转换为 browser result 前都经过验证。任一收集流发生截断都会以 `BROWSER_OUTPUT_LIMIT` 失败。

Upstream 尾部的 `[ego-browser:notice]` 更新提示会从结果通道移除，并作为 out-of-band diagnostics 写入 DSH logger；它不会改变成功或错误分类。

原生 `EGO_TASK_SPACE_USER_IN_CONTROL` 映射为 `BROWSER_USER_CONTROL`，`EGO_TASK_SPACE_INACTIVE` 映射为 `BROWSER_WORKSPACE_INACTIVE`。即使可信 source 捕获异常，同一 heredoc 中第一次 hard stop 也会锁存，阻止后续浏览器调用并使整个请求失败。Provider 不会自动重试、claim 或 takeover；只有显式 portable `takeover` 操作才会调用 `taskSpaces.takeOver`。

## 翻译忠实度

Provider 支持命名 task space 与稳定的 `ego-lite:<numeric-id>`；按完整 URL 打开/复用和选择页面；关闭、导航、刷新、页面元数据、snapshot、有界 screenshot bytes；语义/CSS locator 交互与读取；等待；显式 handoff/takeover；完成；以及 `browser-js-v1` 中的页面求值。

| Upstream v1.2.5 契约 | DSH 实现 | 状态 |
|---|---|---|
| 一个 `ego-browser nodejs` heredoc 组合完整任务 | `browser-js-v1` 保留单进程及 JavaScript 变量、分支、循环、动作与验证 | faithful |
| Agent 在复用用户浏览器状态的隔离 task space 中工作 | Portable named/existing workspace 映射为稳定 `ego-lite:<id>` 身份 | faithful |
| Snapshot、语义 locator、动作、wait、capture 与求值 | 类型化 portable operation 覆盖模型安全子集；可信插件保留 capture、handoff/takeover 与求值 | faithful with split authority |
| 用户控制与 inactive-space 错误是 hard stop | 首个原生 hard stop 被锁存并映射为稳定 `BrowserError`；不会隐式重试或 takeover | faithful |
| Update notice 是带外 CLI 诊断 | Notice 进入 DSH 日志，绝不改变 framed result | adapted |
| 原生 current-space 查询、保证全新 tab、原始 page 列表 | 公共 helper 无法保持 DSH 可移植身份契约，因此明确拒绝 | deliberate omission |

`browser-js-v1` 保留 Ego 的核心单 heredoc 行为：可信插件代码可在一个进程中组合 JavaScript 变量、循环、分支、locator、动作、求值、验证和完成逻辑。Ego heredoc 在 Node.js 中执行，因此这一层是**可信插件可执行面，而不是面向模型的安全沙箱**。Provider 不使用 `vm`、静态黑名单或词法遮蔽伪装隔离。面向模型的 Consumer 必须只暴露类型化 `runPlan`，不得让模型把任意 `source` 传给 `runProgram`。

Program 局部 page alias 仅在生成的 heredoc 内映射到原生 `targetId`。它们以及所有 DOM/原生 handle 都随进程结束而消失。返回值受声明的 `none`、按 grapheme 限制的 `text` 或按 UTF-8 bytes 限制的 JSON output contract 约束。

## 模型体验

### Consumer 负责的浏览器执行

#### 模型看到什么

本 Provider 包不会直接向模型呈现任何内容。随产品交付的 `@deepseek-ai/dsh-tool-browser` Consumer 负责面向模型的 schema，并且只呈现类型化 `runPlan` 结果或可移植错误；不会向模型暴露 `browser-js-v1` source 执行。

#### Token 影响

没有直接 token 成本。Consumer 负责 snapshot 截断、screenshot attachment 引用和有界结果呈现。

#### KV Cache 影响

不会直接导致失效。本 Provider 不注册 prompt、工具 schema 或 Session context 条目。

## 已知限制与延期工作

- **Binary 仍是外部前置条件** — 本包不再分发 Ego Lite，也不管理其 extension/onboarding 生命周期。`@deepseek-ai/dsh-tool-browser` 提供面向模型的 Consumer，`@deepseek-ai/dsh-ego-lite-browser` 提供 Bundle，DSH Desktop 默认组合二者。真实已安装浏览器验收仍须等待 Ego Lite 完成 onboarding；fixture 覆盖不会冒充该证据。
- **不支持 `current` workspace** — upstream v1.2.5 公共 helper 无法无损给出当前选中的 task-space identity，因此 Provider 会在启动前返回 `BROWSER_UNSUPPORTED_OPERATION`。
- **不支持 `reuse: "never"` 的 `open`** — 公共 `browser` facade 暴露 `openOrReuseTab`，但不暴露 `newTab`；Provider 不会伪装成可保证新页面。
- **不支持 `pages`** — upstream 返回原生 `targetId`，而 portable result 要求 Consumer 创建 page key；Provider 会失败，而不是导出或持久化原生标识符。
- **Screenshot transport 使用 Ego 进程内临时文件** — heredoc 把 PNG 读入 framed result，并在返回前 unlink。路径不会跨越 `ctx.browser`，但进程崩溃可能遗留 Ego 临时截图。
- **Node 执行面是可信的** — program source 能访问 Ego Node 进程的 ambient 能力。Capability 声明只描述浏览器行为，不限制可执行 source。
