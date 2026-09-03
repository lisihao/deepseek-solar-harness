# @deepseek-ai/dsh-physical-operator-chatgpt-web

[English](README.md) | 中文

本物理算子 Service Provider 会通过一个已经登录 ChatGPT 的网页会话，提交一次有界的文本任务。它只依赖 Provider 无关的 `ctx.browser` 接缝；因此部署中的 Ego Lite 负责浏览器实现，而本包不会接触调试端口、浏览器 Profile 路径或 Ego Lite 私有 API。

## 配置

```yaml
- id: browser
  name: '@deepseek-ai/dsh-browser'

- id: browser-ego-lite
  name: '@deepseek-ai/dsh-browser-ego-lite'
  config:
    executable: /Applications/ego lite.app/Contents/MacOS/ego-browser

- id: physical-operator
  name: '@deepseek-ai/dsh-physical-operator'

- id: physical-operator-chatgpt-web
  name: '@deepseek-ai/dsh-physical-operator-chatgpt-web'
  config:
    workspaceName: dsh-chatgpt-web
    generationTimeoutMs: 1800000
    pollIntervalMs: 500
    outputMaxBytes: 24576
```

| 配置键 | 含义 |
|---|---|
| `id` | 调用方可见的稳定算子 ID；默认 `chatgpt-web`。 |
| `workspaceName` | 为 ChatGPT 复用的已认证命名浏览器工作区。 |
| `url` | 必须是 `https://chatgpt.com/`；默认也是该地址。 |
| `generationTimeoutMs` / `pollIntervalMs` | 有界的回复等待时间与轮询间隔。 |
| `outputMaxBytes` | 经 `ctx.browser` 返回的 JSON 最大长度；默认 24 KiB。 |

已配置的浏览器 Provider 必须声明 `browser-js-v1`，以及 `authenticated-profile-reuse`、`named-workspace`、`page-evaluate` 三项能力。本算子不会启动浏览器、不会连接调试端口，也绝不发起 OpenAI API 请求或 API Key 回退。

## 行为

- 发现界面暴露一个 `chatgpt-web` 算子，固定 `maxConcurrency: 1`、`executionModes: [ephemeral]`。
- 每次已接受调用都会在命名工作区内打开或复用 `https://chatgpt.com/`，检测是否需要登录，提交文本提示，等待一条新的助手回复，再只返回最终文本。
- 若物理算子调用方提供 `systemPrompt`，它会按 `systemPrompt + "\n\n---\n\n" + task` 与任务合并；这与旧 Solar 网页路由一致。
- `AbortSignal` 会取消浏览器程序并得到 aborted 终态。dispose 不会关闭用户浏览器或已认证工作区。
- 进度流只保存生命周期阶段和结果大小元数据；它刻意不包含 prompt 或网页回复正文。

## 旧 Solar 保真矩阵

迁移基线为 Solar 提交 `cf7df54d0`。该提交的 `core/chatgpt-web/client.ts` 实现了一次同步 Puppeteer/CDP 请求。下表明确区分忠实行为与 Ego Lite 平台适配；不会把后来的包装或未实现能力归到旧算子名下。

| Solar 行为 | 本 Provider | 保真状态 |
|---|---|---|
| 使用用户已登录的 ChatGPT 网页订阅 | 使用经过认证的命名 browser workspace；不读取 API key | faithful |
| 连接端口 9222 上单独启动的 Chrome Profile | 使用公共 `ctx.browser` seam 和 Ego Lite 的 authenticated-profile reuse | 平台适配；移除脆弱的调试端口和 Profile 所有权 |
| 打开或复用 `https://chatgpt.com/` | 在 `dsh-chatgpt-web` 中打开或复用完全一致的 URL | faithful |
| 提交前检测可见登录控件 | 返回 `CHATGPT_WEB_AUTH_REQUIRED` | faithful，并提供类型化失败 |
| 合并 `systemPrompt + "\n\n---\n\n" + task` | 保留完全相同的文本边界 | faithful |
| 填写输入框、按 Enter、等待并提取最新 Markdown 回复 | 在一个可信 browser program 中按相同顺序执行 | faithful |
| 可选模型选择失败时静默保留当前模型 | 显式请求的模型必须被选择并验证，否则调用失败 | 有意的可靠性改进 |
| 断开但不关闭用户浏览器 | dispose 只取消当前调用并保留命名 workspace | faithful |
| 不存在 durable receipt、`submit/poll/collect`、原生 resume 或 Deep Research 模式 | 首版 Provider 不宣称支持这些能力 | faithful 的范围边界 |
| 顺序执行的人格比较脚本 | 交由 Debate/Orchestration，而不在 Provider 中重复实现 | 有意放在正确的 capability seam |

## 模型体验

### 由 Consumer 持有的物理算子结果

#### 模型可见内容

本 Provider 包不会直接向模型暴露内容。现有的 [`physical_operator` Consumer](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator) 持有模型可见 schema；当它选择 `chatgpt-web` 后，只渲染最终的有界文本结果或稳定的物理算子错误。它不会暴露调试端点、浏览器工作区、页面选择器、网页 DOM 或原始进度事件。

#### Token 影响

Provider 不增加 prompt section 或工具 schema。Consumer 的固定 schema 不变；只有选中的最终助手文本进入父级历史，生命周期进度和浏览器程序内部细节都不会进入模型上下文。

#### 对 KV Cache 的影响

稳定的 `physical_operator` Consumer 约定不变。网页会话上下文和模型选择都封装在该 Provider 后面，因此更换部署不会改变模型可见的工具 schema；最终回复只会追加在可复用请求前缀之后。

## 已知限制与后续工作

- **仅 ephemeral**：本包不创建持久 ChatGPT turn receipt，也无法在 DSH 重启后续接网页生成。
- **仅文本任务**：首发 Provider 不接受图片、文件或原生工具负载。
- **网站 UI 是约定边界**：ChatGPT UI 变更可能令登录、输入、模型选择或回复提取不可用；不存在 API 回退。
- **显式模型选择采取保守策略**：ChatGPT 套餐能力与 UI 标签会变化。未指定模型时使用用户当前网页默认值；指定但无法验证时明确失败。
- **不含人格测试框架**：旧 Solar 的人格对比循环属于上层 debate/orchestration，而不是一次物理算子调用。
- **真实订阅 canary 为手工步骤**：聚焦测试使用假的 `ctx.browser` Provider，绝不会访问 ChatGPT 或消耗订阅。
