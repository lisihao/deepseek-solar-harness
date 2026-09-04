# @deepseek-ai/dsh-chatgpt-web-operator

[English](README.md) | 中文

这是一个可选、仅包含 Provider 的 DSH Bundle：通过公开的浏览器能力接缝，
把已登录的 ChatGPT Web 会话暴露为物理算子。它只插入
`@deepseek-ai/dsh-physical-operator-chatgpt-web`；通用的
`ctx.physicalOperators`、`ctx.browser` Service Definition、浏览器 Provider
和面向模型的 Consumer 继续由宿主 profile 持有。

Provider 行声明在 [`cordis.patch.yml`](cordis.patch.yml) 中，因此可以作为
一个 profile 层整体安装或移除，而不会重复共享 Loader ID。ChatGPT Provider 只依赖 `ctx.browser`，不依
赖 Ego Lite 私有模块，也不解析终端屏幕。浏览器自动化属于产品订阅态流
程：本 Bundle 不增加 API key 回退，也不宣称 DSH 文件沙箱会改变浏览器产
品自身的权限策略。

## 安装

使用 DSH 插件命令将 Bundle 安装到一个可选 profile：

```text
dsh plugin --profile chatgpt-web add @deepseek-ai/dsh-chatgpt-web-operator
```

该 profile 必须已经挂载通用 physical-operator、browser 接缝和兼容的浏览器
Provider。DSH Desktop 通过现有的 `resident-operators` 与
`ego-lite-browser` Bundle 满足这些前提。本机还需要安装并完成 Ego Lite
应用引导。浏览器会话的查看或授权使用 DSH 正常的浏览器控制；本 Bundle 不
重新分发 Ego Lite。

由于随包 patch 只包含唯一的 ChatGPT Web Provider 行，它可以直接叠加在上述
现有 Bundle 上，也能独立卸载而不改变共享服务。若精简 profile 缺少任一公共
Service，需要由该 profile 另行添加通用前提；本 Bundle 永远不会成为第二个
Service 写者。

## 运行约定

模型看到的是稳定的 `physical_operator` Consumer。只有在算子被显式启用或
调用方路由策略选择时，模型才会选择 `chatgpt-web`；智能自动模式不会默默
把普通任务路由到浏览器会话。Provider 将浏览器所有权留在浏览器接缝内，
并通过标准 physical operator 生命周期返回有界进展和结果；DSH Session 与
浏览器原生状态仍是彼此独立的权威。

除非 Provider 发布了不同能力，浏览器会话默认只允许单并发。登录缺失、浏
览器不可用、不支持的模型操作或需要用户批准时，会返回结构化算子失败；不
会把错误转换成成功的空结果。

## 模型体验

### 物理算子 Consumer

#### 模型可见内容

模型看到的界面由现有 `physical_operator` Consumer 持有。它列出诸如
`chatgpt-web` 的稳定算子 ID，并返回有界的最终结果或类型明确的物理算子
错误。浏览器 DOM、选择器、会话存储、登录信息和原始进度事件不会进入模型
上下文。

#### Token 影响

挂载本 Bundle 会给既有固定 `physical_operator` 工具 schema 增加一个算子条目
和有界路由提示。一次调用只贡献有界的最终结果；除非上层 Consumer 明确纳入，
prompt、页面文本和浏览器诊断不会复制进父会话历史。

#### KV Cache 影响

工具 schema 与路由提示在各轮之间保持稳定。启用、禁用或变更本 Bundle 会
从它插入的位置起使组装 prompt 失效；重复回合可以复用未变化的前缀。

## 已知限制与后续工作

- 本包是 Provider overlay，不是第二套浏览器实现，也不是独立基础 profile。
- 它要求用户已登录 ChatGPT Web；不会把凭据或原始浏览器存储复制进 DSH
  Session 日志。
- 除非 Provider 能通过浏览器契约验证模型选择，否则不保证使用指定的
  ChatGPT 模型。
- 本包本身不增加常驻持久化；连续性以物理算子 Provider 声明的执行模式为准。
- 它与通用 Ego Lite 浏览器 Bundle 保持分离，以便其他浏览器 Consumer 保持
  与提供方无关。
