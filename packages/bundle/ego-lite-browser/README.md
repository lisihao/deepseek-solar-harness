# @deepseek-ai/dsh-ego-lite-browser

English | [中文](README.zh.md)

An uninstallable Ego Lite browser bundle composing three decoupled roles:

- `@deepseek-ai/dsh-browser`: the generic `ctx.browser` Service Definition.
- `@deepseek-ai/dsh-browser-ego-lite`: the Ego Lite Provider.
- `@deepseek-ai/dsh-tool-browser`: the closed-plan model Consumer.

Other DSH plugins inject only `browser`; they never depend on the Ego Lite
package. Replacing the Provider does not change Consumers. The bundle neither
contains nor redistributes the Ego Lite browser; users install and onboard the
local application separately.
