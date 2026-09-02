# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.browser`. It constrains model input to the
closed, versioned `BrowserRunPlanV1` vocabulary. Provider commands, native
tab/target/ref handles, and the arbitrary `browser-js-v1` program surface are
not exposed to the model.

The model-visible plan is also constrained to the capabilities guaranteed by
the default Ego Lite v1.2.5 Provider: select a `named` or `existing` workspace,
use `open` with `reuse: "exact-url"`, and use `select-page` plus a URL match when
an already-open page must be selected. `workspace: { kind: "current" }`,
`open` with `reuse: "never"`, and the `pages` operation are deliberately absent
from this schema. Ego Lite cannot identify the current task space through its
public helper API, cannot guarantee a fresh tab without reuse, and cannot
export native target ids as portable page keys. The Consumer rejects these
plans before calling `ctx.browser`, so a model does not receive a schema-valid
request that is guaranteed to fail in the shipped Provider.

Other trusted plugins inject `browser` and call `ctx.browser` directly. They do
not need and must not depend on the Ego Lite Provider. The model tool supports
opening and selecting pages, navigation, semantic snapshots, locating,
clicking, filling, reading, waiting, and completing a Workspace. Screenshots
and control transfer remain on the trusted-plugin API.

Stable user-control and inactive-Workspace failures propagate from the
Provider. The Consumer never retries, takes control, or recreates work
automatically.
