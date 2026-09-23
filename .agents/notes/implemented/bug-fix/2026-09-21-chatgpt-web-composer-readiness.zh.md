# Agent Note: ChatGPT Web 编辑器就绪

Status: implemented

[English](2026-09-21-chatgpt-web-composer-readiness.md) | 中文

## 问题

ChatGPT Web Provider 在 DOM 内容加载后把任意可见 textarea 当作就绪输入框。当前网站中，它可能只是服务端渲染的占位框，而不是已水合的编辑器。点击其发送控件会提交原生 form，并把页面改为带 `prompt-textarea` 查询参数的根地址，却不会创建 ChatGPT 轮次。旧的固定发送选择器也无法识别当前公开的 form 提交按钮。

## 决策

可信浏览器程序保留 [ephemeral 对话隔离](2026-09-08-chatgpt-web-ephemeral-conversation-isolation.md) 检查，然后等待唯一可见的 `div.ProseMirror[contenteditable="true"]` 编辑器。它不读取 React 私有属性，也不接受 textarea 占位框。

收集时，它保留旧版 role 标记消息读取器，并添加当前公开的 content-search unit。它会在计数前移除嵌套 unit、读取最新 `data-markdown-text-style="assistant-message"` 正文，并且只有该 unit 的单助手 action ancestor 中精确为 `Copy` 或 `复制` 的控件才能标记完成。它不会向上查入 `main`、`body` 或含多个助手 unit 的 ancestor。

一次填入后，程序会从 ProseMirror 块、空段落和普通硬换行重建文本，忽略 `ProseMirror-trailingBreak`，再在换行规范化后与完整请求比较。等待期间，页面必须保持空根对话。它只从该编辑器所属 form 中选择唯一可见、启用且 `type="submit"` 的按钮。候选可以使用 `#composer-submit-button`、`data-testid="send-button"`，或精确支持的 `aria-label`。全部检查通过后，程序才添加私有 DOM 标记，点击一次，并及时移除输入和发送标记。

缺少、被改写、禁用或歧义的控件会在点击前以 `submission-failed` 失败。Provider 仍将该结果映射为 `CHATGPT_WEB_SUBMIT_FAILED`，只输出有界状态诊断，因此任务和网页正文都不会进入失败消息或进度日志。

第一次真实浏览器 canary 在 `promptMatches` 处停止，创建的用户和助手轮次均为零。Ego Lite 的 flat helper 在填入时保留了六个字符的 contenteditable 草稿，而 ProseMirror 又把段落间距渲染为额外的可见换行。这是 browser Provider 的替换语义缺陷与适配器文本读取缺陷，不是提交成功。`dsh-browser-ego-lite` 负责 contenteditable 替换，现会在填入前清空其 DOM range，且不改变 plain-input 或 object-facade 路径。本适配器只负责忠实重建 ProseMirror 文本并作精确比较，不会自行清空编辑器。

## 考虑过的替代方案

**接受可见 textarea 或读取 React 私有字段。** textarea 可能是水合前的占位框，React 所有字段也不是稳定的浏览器接口。

**提交 form 或按 Enter。** 占位 form 会执行原生 GET，而编辑器的按键处理会随 ChatGPT 版本变化。

**在整张页面中选择第一个匹配发送控件。** 另一张 form 可能有不相关的发送按钮。当前编辑器所属 form 给点击提供了明确归属，而该 form 中有多个候选仍会明确失败。

## 后果

当公开 ChatGPT 编辑器变化时，Provider 会安全失败，而不会提交另一个控件或导航占位 form。每次调用只有一次填入和至多一次点击；就绪等待不会重试任一操作。

包内 JSDOM 回归测试会在 SSR 和水合 DOM 状态下执行发出的浏览器程序。它们覆盖当前中英文可访问标签、保留换行的文本确认、禁用和歧义控件、跨 form 排除、标记清理、畸形 evaluator 输出、嵌套 content-search unit 以及多助手 copy action 拒绝。Loader snapshot 另外通过组装后的 Provider 路径覆盖水合、提交以及不再含编辑器的回复页面。

一次真实提交 canary 创建了 ChatGPT 轮次。随后，最终 collector 源码在该已回复对话上只读执行，而没有重新提交任务。在 source SHA256 `9604a3681f73b5a2e2ab55f1b2d072718eae4b7619f4638002d527fa32250cf0` 下，连续两次样本都报告 `page=conversation`、一条用户消息、一条助手消息、`response='我是 GPT-5.6 Sol。'`、`generating=false` 和 `settled=true`。这是拆分的提交与收集证据，不是最终源码的一次自动端到端运行。
