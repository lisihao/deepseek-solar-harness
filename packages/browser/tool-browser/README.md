# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.browser`. It constrains model input to the closed, versioned `BrowserRunPlanV1` vocabulary. Provider commands, native tab/target/ref handles, and the arbitrary `browser-js-v1` program surface are not exposed to the model.

The model-visible plan is also constrained to the capabilities guaranteed by the default Ego Lite v1.2.5 Provider: select a `named` or `existing` workspace, use `open` with `reuse: "exact-url"`, and use `select-page` plus a URL match when an already-open page must be selected. `workspace: { kind: "current" }`, `open` with `reuse: "never"`, and the `pages` operation are deliberately absent from this schema. Ego Lite cannot identify the current task space through its public helper API, cannot guarantee a fresh tab without reuse, and cannot export native target ids as portable page keys. The Consumer rejects these plans before calling `ctx.browser`, so a model does not receive a schema-valid request that is guaranteed to fail in the shipped Provider.

Other trusted plugins inject `browser` and call `ctx.browser` directly. They do not need and must not depend on the Ego Lite Provider. The model tool supports opening and selecting pages, navigation, semantic snapshots, locating, clicking, filling, reading, waiting, and completing a Workspace. Screenshots and control transfer remain on the trusted-plugin API.

Stable user-control and inactive-Workspace failures propagate from the Provider. The Consumer never retries, takes control, or recreates work automatically.

## Model Experience

### Browser policy prompt

#### What the model sees

The Consumer adds this stable policy section whenever the `browser` tool is available:

##### Verbatim browser policy

```markdown
Use the browser tool when a task requires interacting with a real webpage, especially one that benefits from the user's existing browser login. Submit one ordered portable plan with the fewest necessary operations. Use a named workspace (createIfMissing true when needed) or an existing workspace id; the default Ego Lite browser cannot identify a current workspace. For open, use reuse:"exact-url"; reuse:"never" is not available. Do not request pages, because provider-native tab ids are not portable; use select-page with a URL match, then page-info or snapshot. Prefer semantic snapshots and role/label/text locators over CSS. Reuse a named workspace only when continuity matters. Never assume a click or form submission succeeded: read the resulting state in the same plan. If the browser reports user control or an inactive workspace, stop and report it; do not retry, take control, or recreate the task automatically.
```

#### Token effect

The policy contributes one fixed prompt section to each assembled request while this Consumer is mounted.

#### KV Cache effect

The policy is stable across turns. Changing its wording invalidates the assembled prompt from this section onward.

### `browser` tool schema and results

#### What the model sees

The model receives the closed `browser` tool schema documented in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser). It sees only named or existing Workspaces, exact-URL open/reuse, portable page aliases, typed semantic operations, and JSON-only results or stable errors.

#### Token effect

The tool schema is a fixed request cost. Each invocation appends one tool call and a Provider-bounded result whose size depends on the requested operations and returned page state.

#### KV Cache effect

The schema is stable across turns, while each call result is session-specific and extends the uncached suffix. A schema change invalidates the assembled request from the tool-definition insertion point onward.

## Known Limitations and Deferred Work

- **The model surface is intentionally narrower than `ctx.browser`** — `current` Workspace selection, `open` with `reuse: "never"`, native page listing, screenshots, and control transfer remain unavailable to this Consumer.
- **Recovery stays explicit** — user-control and inactive-Workspace failures stop the plan; the Consumer does not retry, reclaim control, or recreate work.
