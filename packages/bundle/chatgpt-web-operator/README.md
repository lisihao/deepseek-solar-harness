# @deepseek-ai/dsh-chatgpt-web-operator

English | [中文](README.zh.md)

An opt-in, provider-only DSH Bundle that exposes a logged-in ChatGPT Web
session as a physical operator through the public browser capability seam. It
inserts only `@deepseek-ai/dsh-physical-operator-chatgpt-web`; the host profile
continues to own the generic `ctx.physicalOperators` and `ctx.browser` Service
Definitions, the browser Provider, and the model-facing Consumer.

The Provider row is declared in [`cordis.patch.yml`](cordis.patch.yml), so the
Bundle can be installed or removed as one profile layer without duplicating
shared Loader IDs. The ChatGPT Provider
depends on `ctx.browser`, not on private Ego Lite modules or terminal screen
parsing. Browser automation remains a product-subscription flow: this Bundle
does not add an API-key fallback or claim that DSH's file sandbox changes the
browser product's own permission policy.

## Install

Install the Bundle into an opt-in profile with the DSH plugin command:

```text
dsh plugin --profile chatgpt-web add @deepseek-ai/dsh-chatgpt-web-operator
```

The profile must already mount the generic physical-operator and browser seams
and a compatible browser Provider. DSH Desktop satisfies those prerequisites
through its existing `resident-operators` and `ego-lite-browser` Bundles. The
external Ego Lite application must also be installed and onboarded. Use the
normal DSH browser controls to inspect or authorize the browser session; this
Bundle does not redistribute Ego Lite.

Because the shipped patch contains only the unique ChatGPT Web Provider row,
it can be layered directly with those existing Bundles and removed without
changing them. A minimal custom profile that lacks either public Service must
add the generic prerequisites separately; this Bundle never becomes a second
Service writer.

## Runtime contract

The model sees the stable `physical_operator` Consumer. It selects the
`chatgpt-web` operator only when the operator is explicitly enabled or chosen
by the caller's routing policy; Smart Auto does not silently route ordinary
tasks through a browser session. The Provider keeps browser ownership in the
browser seam and returns bounded progress/results through the normal physical
operator lifecycle, leaving DSH Session and the browser's native state as
separate authorities.

The browser session is intentionally single-concurrency unless the Provider
publishes a different capability. A missing login, unavailable browser,
unsupported model operation, or required user approval is reported as a
structured operator failure; it is not converted into a successful empty
result.

## Model Experience

### Physical operator Consumer

#### What the model sees

The model-facing surface is the existing `physical_operator` Consumer. It lists stable operator IDs such as `chatgpt-web` and returns a bounded final result or a typed physical-operator error. Browser DOM, selectors, session storage, login details, and raw progress events stay outside the model context.

#### Token effect

Mounting the Bundle adds one operator entry to the existing fixed `physical_operator` tool schema and its bounded routing guidance. A call contributes only the bounded final result; prompts, page text, and browser diagnostics are not copied into the parent history unless a higher-level Consumer explicitly includes them.

#### KV Cache effect

The tool schema and routing guidance remain stable across turns. Enabling, disabling, or changing this Bundle invalidates the assembled prompt from the Bundle's insertion point onward; repeated turns reuse the unchanged prefix.

## Known Limitations and Deferred Work

- This package is a Provider overlay, not a second browser implementation or
  a standalone base profile.
- It requires a user-authenticated ChatGPT Web session; credentials and raw
  browser storage are not copied into DSH Session logs.
- It does not guarantee a particular ChatGPT model selector unless the
  Provider can verify that selection through the browser contract.
- It does not add resident persistence by itself; continuity follows the
  physical operator Provider's declared execution mode.
- It is intentionally separate from the generic Ego Lite browser Bundle so
  other browser Consumers remain provider-neutral.
