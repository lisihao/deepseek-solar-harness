# @deepseek-ai/dsh-ego-lite-browser

English | [中文](README.zh.md)

An uninstallable Ego Lite browser bundle composing three decoupled roles:

- `@deepseek-ai/dsh-browser`: the generic `ctx.browser` Service Definition.
- `@deepseek-ai/dsh-browser-ego-lite`: the Ego Lite Provider.
- `@deepseek-ai/dsh-tool-browser`: the closed-plan model Consumer.

Other DSH plugins inject only `browser`; they never depend on the Ego Lite package. Replacing the Provider does not change Consumers. The bundle neither contains nor redistributes the Ego Lite browser; users install and onboard the local application separately.

## Model Experience

### Mounted browser Consumer

#### What the model sees

The Bundle contributes no literal model text itself. Mounting it adds the stable browser policy and closed `browser` tool schema owned by [`@deepseek-ai/dsh-tool-browser`](../../browser/tool-browser/README.md); the Service Definition and Ego Lite Provider remain model-invisible.

#### Token effect

Enabling the Bundle adds one fixed policy section and one fixed tool schema, plus one Provider-bounded result for each browser call.

#### KV Cache effect

The mounted policy and schema are stable across turns. Enabling, disabling, or changing the Browser Consumer invalidates the assembled prompt from its insertion point onward.

## Known Limitations and Deferred Work

- **Ego Lite remains an external prerequisite** — the Bundle does not redistribute the browser or complete local application onboarding.
- **The model tool exposes only the portable v1 subset** — current-Workspace selection, guaranteed fresh tabs, native page listing, screenshots, and control transfer remain unavailable to the model.
