# 浏览器自动化

[English](browser.md) | 中文

浏览器自动化能力是一项供应商中立的 seam，通过 `ctx.browser` 控制已安装的浏览器。它与 [`ctx.web`](web.md) 不同：Web 搜索与抓取用于获取资源；浏览器自动化用于驱动交互式页面，在 Provider 支持时保留具名工作区，并可复用用户已有的登录状态。

这项 seam 包含三个可独立替换的角色：

- [`@deepseek-ai/dsh-browser`](../../packages/browser/browser) 持有 Service Definition、可移植约定、Provider 注册表、选择、取消和错误。
- [`@deepseek-ai/dsh-browser-ego-lite`](../../packages/browser/browser-ego-lite) 适配单独安装的 Ego Lite 浏览器，不暴露其原生 target id 或 snapshot ref。
- [`@deepseek-ai/dsh-tool-browser`](../../packages/browser/tool-browser) 是模型 Consumer。它只开放闭合的 `portable-plan-v1` 词汇，不开放任意 JavaScript。

其他可信插件注入 `browser`，并且只依赖 Service Definition。它们禁止导入 Ego Lite Provider。因此，部署可以把 Ego Lite 替换为另一种 Provider，而不需要修改 Consumer。

源码：[`packages/browser/browser/src/types.ts`](../../packages/browser/browser/src/types.ts) 与 [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

## 执行层

`portable-plan-v1` 是由导航、发现、定位、交互、等待、截图和完成操作组成的有序类型化批次。面向模型的工具只接受这一层，并将每个计划限制为至多 64 项操作。Provider 要么实现声明的操作，要么明确拒绝；seam 不会静默回退到另一种传输方式。

`browser-js-v1` 是单独的显式 opt-in 执行面，供需要在一次浏览器事务中使用变量、循环、分支、locator 或页面求值的可信插件使用。其 source 是可执行代码，不是模型安全沙箱。Consumer 禁止把不可信模型文本转发给 `runProgram()`。

## 选择与生命周期

Provider 选择是确定性的。配置的 Provider id 必须存在、在本机可用、支持请求的执行层，并满足全部所需能力。没有显式 id 时，只允许选中唯一一个可用 Provider；没有候选或存在多个候选都会明确失败。注册会返回 disposer，因此 HMR 和 Bundle 卸载不会留下失效的 Provider。

持久浏览器 profile 数据和任务工作区始终由 Provider 持有。DSH 只接收归一化结果和可移植句柄。用户控制权是权威：当 Provider 报告 `USER_IN_CONTROL` 或工作区 inactive 时，调用方必须停止并展示该状态，禁止重试或夺取控制权。

Ego Lite Bundle 不重新分发浏览器二进制。用户需要单独安装并完成 Ego Lite 本机引导；可执行文件不可用时，Provider 保持 unavailable，但不会破坏 DSH 的其他功能。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserruntime"></a>

### `ctx.browser` — `BrowserRuntime`

Registry and execution authority for the browser capability seam.

Provider resolution happens for every call. Explicit selection fails closed when missing or unavailable; implicit selection succeeds only when exactly one provider is locally usable, so registration and HMR order never decide.

```ts cordis-catalog
/**
 * Register one backend. Duplicate stable ids fail instead of replacing a live
 * Provider. The returned disposer is also tied to the contributing Cordis fiber.
 * @param provider - browser backend and its stable descriptor.
 * @returns a disposer that unregisters this Provider.
 */
registerProvider(provider: BrowserProvider): () => void

/**
 * Portable capabilities of the Provider that would execute one layer now.
 * @param layer - explicit execution layer to resolve.
 * @returns the selected Provider's portable capability names.
 */
capabilities(layer: BrowserExecutionLayerV1): readonly BrowserCapabilityV1[]

/**
 * Execute one ordered v1 plan. The Provider receives the exact plan and abort
 * signal. Portable Provider errors survive; arbitrary failures are normalized.
 * @param plan - closed, ordered portable operation plan.
 * @param signal - optional cancellation forwarded to the Provider.
 * @returns the Provider's normalized ordered result.
 */
async runPlan(plan: BrowserRunPlanV1, signal?: AbortSignal): Promise<BrowserRunResultV1>

/**
 * Execute one explicitly opted-in `browser-js-v1` program. This method never
 * converts a plan into source and never retries or takes control implicitly.
 * @param program - source, workspace, required capabilities, and output bound.
 * @param signal - optional cancellation forwarded to the Provider.
 * @returns the bounded provider-neutral program result.
 */
async runProgram( program: BrowserRunProgramV1, signal?: AbortSignal, ): Promise<BrowserRunProgramResultV1>
```

Source: [`packages/browser/browser/src/index.ts:72`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
