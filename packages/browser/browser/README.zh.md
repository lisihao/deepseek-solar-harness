# @deepseek-ai/dsh-browser

[English](README.md) | 中文

`BrowserRuntime`（`ctx.browser`）是供应商中立的浏览器自动化 Service Definition。Consumer 可以提交一个有序、带版本的浏览器计划，而不需要导入具体浏览器产品、扩展协议或原生页面标识。

| 包类型 | 职责 |
|---|---|
| `@deepseek-ai/dsh-browser` | Service：可移植词汇、Provider 注册表、选择、取消和错误 |
| 浏览器 Provider 包 | 浏览器传输、workspace/page 生命周期、认证 profile 和原生错误映射 |
| 浏览器 Consumer 包 | 模型/工具 schema、策略、计划构造、attachment 持久化和结果呈现 |

本包不注册工具、不安装浏览器扩展，也不包含 Provider。Provider 和 Consumer 都依赖本包，但二者不互相依赖。

## Service API（`ctx.browser`）

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 注册一个 Provider id 并返回绑定 fiber 的 disposer；重复 id 会失败 |
| `capabilities(layer)` | 返回当前将执行该层的 Provider 所支持的可移植能力 |
| `runPlan(plan, signal?)` | 执行有序的 `BrowserRunPlanV1` 并返回 `BrowserRunResultV1` |
| `runProgram(program, signal?)` | 显式执行一个通过 capability 门控的 `browser-js-v1` source body |

`available()` 是廉价的本地检查，不得发起网络请求。每次调用 `capabilities(layer)`、`runPlan()` 或 `runProgram()` 时都会选择 Provider：

| 情况 | 结果 |
|---|---|
| 配置的 id 已注册且可用 | 使用该 Provider |
| 配置的 id 不存在 | `BROWSER_PROVIDER_CONFIGURED_MISSING` |
| 配置的 id 不可用 | `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配置 id 且恰好有一个 Provider 可用 | 使用该 Provider |
| 未配置 id 且没有 Provider 可用 | `BROWSER_UNAVAILABLE` |
| 未配置 id 且有多个 Provider 可用 | `BROWSER_PROVIDER_AMBIGUOUS` |

因此，选择永远不依赖注册顺序或 HMR 顺序。Consumer 可以根据 `capabilities(layer)` 分支，但不得根据 Provider id 分支。选择还会按 `descriptor.layers` 过滤，因此仅支持 plan 的 Provider 不能静默执行 program。

## 两个 v1 执行层

`portable-plan-v1` 是默认互操作层。它适合普通插件，因为 Service 拥有封闭的类型化词汇，Consumer 不会提交可执行 source。

`BrowserRunPlanV1` 选择当前、已有或命名 workspace、声明所需 capability，并携带有序操作数组。Service 会在第一个操作前拒绝缺失的 capability。`BrowserPageKey` 和 `BrowserOperationId` 是 Consumer 创建且仅在该计划内有效的别名。`BrowserWorkspaceId` 是 Provider 创建的稳定标识，可由后续计划继续使用。

封闭的操作联合覆盖页面选择与生命周期、导航、页面元数据、语义快照、截图、locator 交互、读取、等待、显式用户交接/接管，以及带显式 `keep` 决定的完成操作。locator 联合覆盖 CSS 和无障碍 role、text、label、placeholder、test-id 查询。新增操作或结果类型时，必须协调修改 Service、Provider 和 Consumer 契约。

`BrowserRunResultV1` 返回最终 workspace 生命周期/控制权状态，并为每个操作返回恰好一个有序结果。截图以 `Uint8Array` 和媒体类型返回；是否以及在何处持久化由 Consumer 决定。文件系统路径不会跨越此接缝。

契约刻意排除了 Provider 原生 tab id、snapshot ref、原生 workspace 命令、扩展消息、profile 目录、调试协议命令和传输细节。Provider 负责在可移植计划与原生协议之间转换。

`browser-js-v1` 是独立的显式 opt-in 层，用于需要在一次执行中使用变量、循环、分支、locator 和页面求值的工作负载。`BrowserRunProgramV1.source` 是异步函数的 body；它唯一被注入的 host object 是 `BrowserProgramApiV1`：`browser.run(operation)` 执行一个可移植操作，`browser.evaluate(page, functionExpression, argument?)` 在页面内执行函数表达式。该语言不包含 Node.js、文件系统、网络、模块加载或 Provider 原生 global。

program 声明 `requiredCapabilities`，Service 会在执行前检查。返回值必须满足显式的 `none`、有界 `text` 或有界 JSON output contract。program 局部变量、locator、page object、DOM object 和 Provider 原生 handle 会随本次执行结束，不能返回给后续调用。

## 错误与恢复

`BrowserError` 携带封闭的可移植 `BrowserErrorCode` 和可选 `operationId`。Provider 对预期的浏览器失败抛出同一错误类型；Service 保留这些错误，并将未知失败归一为带原始 cause 的 `BROWSER_PROVIDER_FAILED`。Provider 执行前或执行期间取消会变成 `BROWSER_ABORTED`。

可移植运行错误会区分用户控制、非活跃 workspace、失效页面、超时、不支持的操作和协议失败。恢复保持显式：Consumer 可提交新计划，选择稳定 workspace、重新绑定计划局部页面 key、接管控制权或完成 workspace。Service 不会重试操作，因为重放点击或表单填写可能重复副作用。

执行层和 capability 不匹配时，会在执行 source 前失败。Service 会强制 text output 上限，并拒绝过大的 JSON，而不是把无界 program 结果当成成功。

## 安全边界

- Service 信任同进程的类型化计划；Consumer 在构造计划前验证模型或用户 JSON。
- Provider 在自己的不可信边界验证并限制每条扩展、进程或网络消息。
- `handoff` 和 `takeover` 是显式操作。当用户拥有控制权时，Provider 必须返回 `BROWSER_USER_CONTROL`，不得继续执行动作。
- 页面求值仅存在于显式 opt-in 的 `browser-js-v1` 层，并要求声明 `page-evaluate` capability。调试协议仍不属于公共接缝。

## 模型体验

### Consumer 呈现的浏览器结果

#### 模型看到什么

本包不会直接向模型呈现任何内容；Consumer 决定如何把有界的 `BrowserRunResultV1` / `BrowserRunProgramResultV1` 数据或结构化 `BrowserError` 元数据放入工具结果。

#### Token 影响

没有直接 token 成本；Consumer 负责快照截断、截图 attachment 引用和结果呈现。

#### KV Cache 影响

不会直接导致失效；本 Service 不注册 prompt、工具 schema 或 Session context 条目。

## 已知限制与延期工作

- 本包不附带 Provider 或 Consumer，因此在注册 Provider 前执行会失败；仅安装本包也不会提供面向模型的浏览器工具。
- 端到端 Ego Lite 忠实度当前为 **partial**：本包保留了可移植 plan 和可编程组合，但这里尚未实现 Ego Provider、扩展生命周期或 Consumer 集成。
- v1 契约刻意没有下载、文件上传、PDF 提取或调试协议操作。页面求值仅存在于 program 层。
- availability 没有事件流；调用方通过 `capabilities(layer)` 或执行时的可移植错误观察它。
- Service 不持久化 workspace 元数据或截图。Provider 负责原生状态，Consumer 负责 harness attachment 或持久记录。
