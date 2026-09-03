# @deepseek-ai/dsh-physical-operator-chatgpt-web

English | [中文](README.zh.md)

This physical-operator Service Provider sends one bounded text task through an already authenticated ChatGPT web session. It uses only the provider-neutral `ctx.browser` seam, so an Ego Lite deployment supplies the browser implementation without exposing a debugging port, a browser profile path, or any Ego Lite private API to this package.

## Configuration

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

| Key | Meaning |
|---|---|
| `id` | Stable caller-visible operator id. Defaults to `chatgpt-web`. |
| `workspaceName` | Named authenticated browser workspace reused for ChatGPT. |
| `url` | Must be `https://chatgpt.com/`; the default is the same URL. |
| `generationTimeoutMs` / `pollIntervalMs` | Bounded response wait and polling interval. |
| `outputMaxBytes` | Maximum JSON result returned across `ctx.browser`; default 24 KiB. |

The configured browser Provider must declare `browser-js-v1` plus `authenticated-profile-reuse`, `named-workspace`, and `page-evaluate`. The operator starts no browser, never opens a debugging connection, and makes no OpenAI API request or API-key fallback.

## Behavior

- Discovery exposes one `chatgpt-web` operator with `maxConcurrency: 1` and `executionModes: [ephemeral]`.
- Each accepted call opens or reuses `https://chatgpt.com/` inside its named workspace, detects a login requirement, submits the text prompt, waits for a fresh assistant response, and returns only that final text.
- A `systemPrompt`, when supplied by the physical-operator caller, is merged with the task as `systemPrompt + "\n\n---\n\n" + task`, matching the legacy Solar web route.
- `AbortSignal` cancels the browser program and yields an aborted result. Dispose never closes the user's browser or authenticated workspace.
- Progress is bounded to lifecycle phases and result size metadata; it deliberately excludes the prompt and webpage output.

## Legacy Solar fidelity

The migration baseline is Solar commit `cf7df54d0`, where `core/chatgpt-web/client.ts` implemented one synchronous Puppeteer/CDP request. The table distinguishes faithful behavior from deliberate Ego Lite platform adaptations; it does not attribute later or unimplemented behavior to the legacy operator.

| Solar behavior | This Provider | Fidelity |
|---|---|---|
| Use the user's authenticated ChatGPT website subscription | Uses an authenticated named browser workspace; no API key is read | faithful |
| Connect to a separately launched Chrome profile on port 9222 | Uses the public `ctx.browser` seam and Ego Lite authenticated-profile reuse | platform adaptation; removes the fragile debugging-port/profile ownership |
| Open or reuse `https://chatgpt.com/` | Opens or reuses the exact URL in `dsh-chatgpt-web` | faithful |
| Detect a visible login control before submission | Returns `CHATGPT_WEB_AUTH_REQUIRED` | faithful, with a typed failure |
| Merge `systemPrompt + "\n\n---\n\n" + task` | Preserves the same text boundary | faithful |
| Fill the composer, press Enter, wait, and extract the newest Markdown reply | Performs the same ordered interaction in one trusted browser program | faithful |
| Optional model selector could fail and silently keep the current model | A requested model must be selected and verified or the call fails | deliberate reliability improvement |
| Disconnect without closing the user's browser | Dispose cancels only this call and keeps the named workspace | faithful |
| No durable receipt, `submit/poll/collect`, native resume, or Deep Research mode | This first Provider does not claim those capabilities | faithful scope boundary |
| Sequential personality comparison script | Left to Debate/Orchestration rather than duplicated in the Provider | deliberate capability-seam placement |

## Model Experience

### Consumer-owned physical-operator result

#### What the model sees

Nothing directly from this Provider package. The existing [`physical_operator` Consumer](../../../docs/tool-catalog.md#deepseek-aidsh-tool-physical-operator) owns the model-facing schema and, after it selects `chatgpt-web`, renders only the final bounded text result or a stable physical-operator error. It does not expose a debugging endpoint, browser workspace, page selector, webpage DOM, or raw progress events.

#### Token effect

The Provider adds no prompt section or tool schema. The Consumer's fixed schema is unchanged; only the selected final assistant text enters parent history, while lifecycle progress and browser-program internals remain outside model context.

#### KV Cache effect

The stable `physical_operator` Consumer contract does not change. Web-session context and model selection remain behind this Provider, so switching its deployment does not alter the model-visible tool schema; the final response appends after the reusable request prefix.

## Known Limitations and Deferred Work

- **Ephemeral only** — this package does not create a durable ChatGPT turn receipt or resume a browser-generation after a DSH restart.
- **Text task only** — image, file, and native tool payloads are not accepted by this first Provider slice.
- **Website UI is the contract boundary** — a ChatGPT UI change can make login, input, model selection, or extraction unavailable; no API fallback exists.
- **Explicit model selection is conservative** — ChatGPT plan availability and UI labels vary. Omitted model selection uses the user's current web default; requested but unverified selection fails loud.
- **No persona harness** — the legacy Solar personality comparison loop belongs to higher-level debate/orchestration, not a single physical operator call.
- **Live subscription canary is manual** — focused tests use a fake `ctx.browser` Provider and never contact ChatGPT or consume a subscription.
