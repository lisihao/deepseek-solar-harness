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
    submissionTimeoutMs: 10000
    pollIntervalMs: 500
    progressIntervalMs: 15000
    outputMaxBytes: 24576
```

| 配置键 | 含义 |
|---|---|
| `id` | 调用方可见的稳定算子 ID；默认 `chatgpt-web`。 |
| `workspaceName` | 为 ChatGPT 复用的已认证命名浏览器工作区。 |
| `url` | 必须是 `https://chatgpt.com/`；默认也是该地址。 |
| `submissionTimeoutMs` | 证明网页已接受所填提示的有界等待；默认 10 秒。 |
| `generationTimeoutMs` / `pollIntervalMs` | 提交成功后的有界回复等待时间与轮询间隔。 |
| `progressIntervalMs` | 不含内容的等待心跳间隔；默认 15 秒。 |
| `outputMaxBytes` | 经 `ctx.browser` 返回的 JSON 最大长度；默认 24 KiB。 |

已配置的浏览器 Provider 必须声明 `browser-js-v1`，以及 `authenticated-profile-reuse`、`named-workspace`、`page-evaluate` 三项能力。本算子不会启动浏览器、不会连接调试端口，也绝不发起 OpenAI API 请求或 API Key 回退。

## 行为

- 发现界面暴露一个 `chatgpt-web` 算子，固定 `maxConcurrency: 1`。直接模式提供 `ephemeral`；显式配置 MCP 协调后还提供 `resident`。切换模式要求算子空闲。
- 当组合注入 `modelWorkers` 时，它可以为这个已配置算子 ID 注册 `ChatGptWebModelWorker`。该 worker 将 `website-default` 作为原生订阅的高层级规划/研究路由提供；高层级只表示路由偏好，令牌表示网站当前选择，不是 GPT 模型身份。它需要编排 parent，只接受纯文本 ephemeral 工作，在启动浏览器前拒绝已启用的 RLM 和所有 model-tool bridge，并在算子结束后 dispose。
- 上下文信封会以可读文本分节输入，而不是 JSON 文档：先是系统文本，然后是每个以 `## name` 标题标出的命名上下文，最后是任务。直接 Web 请求携带任务、当前的 Web handoff 或 steering 以及匹配的 task-template 指令；面向工具型 agent 的系统指令和运行时上下文不会发送。
- 每次已接受调用都会复用已认证的命名工作区，但在填入提示词前先把选中的页面导航到全新的 `https://chatgpt.com/` 根对话。根对话中的用户轮次与助手轮次必须均为零；否则本次调用会以 `CHATGPT_WEB_CONTEXT_NOT_ISOLATED` 失败且不会提交。在该空根页面上，程序会等待唯一可见的 `div.ProseMirror[contenteditable="true"]` 编辑器，并忽略服务端渲染的 textarea 占位框。填入后，它会规范化换行符、确认编辑器仍包含完整请求，并保持根页面为空。随后它只会在该编辑器所属 form 内选择唯一可见、启用且 `type="submit"` 的发送按钮：旧版 `#composer-submit-button`、`data-testid="send-button"`，或 `aria-label` 精确为 `Send`、`Send message`、`Send prompt`、`发送`、`发送消息` 的按钮。它只点击一次，并在等待最终助手文本前证明新用户轮次或生成已经开始。
- 填入前若发现可见的非空编辑器草稿或附件，本算子会以 `CHATGPT_WEB_DRAFT_PRESENT` 拒绝，并只报告有界计数，提示调用方先在浏览器中清除或发送后再重试；填入前还会立即复查，不会把本次自身填入的文字误判为恢复草稿。
- 缺少或被改写的编辑器、不可用或歧义的发送控件，或网页未接受点击时，都会在 `submissionTimeoutMs` 内以 `CHATGPT_WEB_SUBMIT_FAILED` 失败，不进入更长的生成等待；生成超时只附带不含提示或回复正文的有界页面状态。
- 回复收集器支持旧版 role 标记消息，以及当前 `data-content-search-unit-key` 用户和助手 unit。它会移除嵌套重复 unit，把最新 `data-markdown-text-style="assistant-message"` 正文转换为 Markdown（段落、标题、列表、引用、表格、去掉代码块工具栏的围栏代码、按 TeX 源码输出为 `$…$`/`$$…$$` 的 KaTeX，以及作为来源链接的引用），并要求两次匹配且未生成的样本。对于当前 unit，只有其自身单助手 action ancestor 中、位于回答正文之外、精确为 `Copy`、`复制`、`Copy response` 或 `复制回复` 的按钮才能标记回复完成；流式回答正文内的代码块和表格复制按钮不会触发完成，搜索会在 `main`、`body` 或包含多个助手的 ancestor 之前停止。`stop-button` test id 或停止类标签表示回复仍在生成。
- 若物理算子调用方提供 `systemPrompt`，它会按 `systemPrompt + "\n\n---\n\n" + task` 与任务合并；这与旧 Solar 网页路由一致。
- `AbortSignal` 会取消浏览器程序并得到 aborted 终态。dispose 不会关闭用户浏览器或已认证工作区。
- 进度流只保存生命周期阶段、等待时长心跳、失败状态和结果大小元数据；它刻意不包含 prompt 或网页回复正文。

## 动态模型控制

本地所有者接口 `/api/chatgpt-web` 从已认证网站发现账户可见的模型和推理选项。DSH 刷新控件更新此目录，不发送提示。失败时保留上一次成功目录；已下架的已保存模型保留为不可用偏好，不会阻止发现替代模型。推理选项属于观察到的当前模型，不是所有模型通用的等级列表。

显式选择先经网站验证，再通过 `chatgpt-web/profile` Session 事件保存。每个 Session 独立保存 Web 偏好；原生 CLI 配置不提供 Web 推理等级。刷新不会改变 Session 偏好或主路由。Web 任务运行期间不能发现或选择模型。新增目录项不代表支持新的输入模态、本地工具或已变化的网站协议。

## MCP 协调

协调需要 ChatGPT 自定义 MCP 应用通过已配置隧道连接 Provider 的私有端点。本地设置区分已选模式与最近一次已验证工具调用。只有精确匹配的原生网页请求身份才能取得当前执行的 DSH 工具权限。MCP 会话 ID 和模型提供的参数不能选择另一个 DSH 所有者。命令回执保留原生轮次身份；恢复时观察不确定的提交，不会再次发送。

## 旧 Solar 保真矩阵

迁移基线为 Solar 提交 `cf7df54d0`。该提交的 `core/chatgpt-web/client.ts` 实现了一次同步 Puppeteer/CDP 请求。下表明确区分忠实行为与 Ego Lite 平台适配；不会把后来的包装或未实现能力归到旧算子名下。

| Solar 行为 | 本 Provider | 保真状态 |
|---|---|---|
| 使用用户已登录的 ChatGPT 网页订阅 | 使用经过认证的命名 browser workspace；不读取 API key | faithful |
| 连接端口 9222 上单独启动的 Chrome Profile | 使用公共 `ctx.browser` seam 和 Ego Lite 的 authenticated-profile reuse | 平台适配；移除脆弱的调试端口和 Profile 所有权 |
| 打开或复用 `https://chatgpt.com/` | 复用已认证工作区，再把选中的页面导航到根地址，并验证它不是已有对话 | 有意改进任务隔离 |
| 提交前检测可见登录控件 | 返回 `CHATGPT_WEB_AUTH_REQUIRED` | faithful，并提供类型化失败 |
| 合并 `systemPrompt + "\n\n---\n\n" + task` | 保留完全相同的文本边界 | faithful |
| 填写输入框、按 Enter、等待并提取最新 Markdown 回复 | 点击当前可见发送控件，证明提交后在同一可信 browser program 中等待并提取 | 平台适配；避免依赖编辑器的 Enter 行为 |
| 可选模型选择失败时静默保留当前模型 | 显式请求的模型必须被选择并验证，否则调用失败 | 有意的可靠性改进 |
| 断开但不关闭用户浏览器 | dispose 只取消当前调用并保留命名 workspace | faithful |
| 不存在 durable receipt、`submit/poll/collect`、原生 resume 或 Deep Research 模式 | 独立路径保持有界；可选 resident 协调持有持久回执与恢复 | faithful 的范围边界 |
| 顺序执行的人格比较脚本 | 交由 Debate/Orchestration，而不在 Provider 中重复实现 | 有意放在正确的 capability seam |

## 模型体验

### 由 Consumer 持有的物理算子结果

#### 模型可见内容

直接模式下，现有的 [`physical_operator` Consumer](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator) 持有模型可见 schema；当它选择 `chatgpt-web` 后，只渲染最终的有界文本结果或稳定的物理算子错误。它不会暴露调试端点、浏览器工作区、页面选择器、网页 DOM 或原始进度事件。

#### Token 影响

直接模式不增加 prompt section 或工具 schema。协调模式通过 MCP 暴露所属 DSH 工具 schema，并增加仅用于当前任务的检查点指导；工具参数和结果使用现有 Session 日志。直接调用 Consumer 的固定 schema 不变；只有选中的最终助手文本进入父级历史，生命周期进度和浏览器程序内部细节都不会进入模型上下文。

#### 对 KV Cache 的影响

稳定的 `physical_operator` Consumer 约定不变。网页会话上下文和模型选择都封装在该 Provider 后面，因此更换部署不会改变模型可见的工具 schema；最终回复只会追加在可复用请求前缀之后。

## 已知限制与后续工作

- **账户支持的协调**：无密钥协议测试不能证明账户允许自定义 MCP 应用，也不能证明配置的隧道可被 ChatGPT 访问。
- **独立调用的上下文**：ephemeral 调用启动新对话，需要完整任务。持久轮次身份和续接属于已配置的 resident 协调。
- **仅文本任务**：首发 Provider 不接受图片、文件或原生工具负载。
- **网站 UI 是约定边界**：ChatGPT UI 变更可能令登录、输入、模型选择或回复提取不可用；不存在 API 回退。
- **显式模型选择采取保守策略**：ChatGPT 套餐能力与 UI 标签会变化。未指定模型时使用用户当前网页默认值；指定但无法验证时明确失败。
- **不含人格测试框架**：旧 Solar 的人格对比循环属于上层 debate/orchestration，而不是一次物理算子调用。
- **真实订阅 canary 为手工步骤**：聚焦测试使用假的 `ctx.browser` Provider，绝不会访问 ChatGPT 或消耗订阅。
