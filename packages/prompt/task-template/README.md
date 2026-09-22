# @deepseek-ai/dsh-task-template

English | [中文](README.zh.md)

Task-level prompt-template Service Definition, deterministic selector, and file-backed Provider. Users define reusable methods and matching task characteristics; Consumers ask `ctx.taskTemplates.select()` for the best enabled template without granting tools, permissions, or execution authority.

## Storage and config

The default document is `<DSH_HOME>/task-templates.json` (`~/.dsh/task-templates.json` when no home is configured). The Provider creates parent directories with mode `0700` and writes the document atomically with mode `0600`. It never reads a repository or working-directory template file.

| Key | Default | Meaning |
|---|---|---|
| `dshHome` | resolved DSH home | Private-data root used when `path` is absent. |
| `path` | `<dshHome>/task-templates.json` | Explicit JSON document path. |
| `watch` | `true` | Watch the document and hot-publish external edits. |
| `pollIntervalMs` | `100` | External-change polling interval in milliseconds. |

Every read validates the complete document, its format version, unique ids, complete revision histories, match fields, and personal layers. Corrupt or unsupported documents fail startup instead of being replaced.

### Cross-process refresh

The Provider polls its document and hot-publishes an external write from another process on the same host — for example, a Desktop UI process editing the store through its own Provider instance — into every already-running Consumer holding this service, such as a long-lived TaskGraph daemon. A refresh emits `task-template/updated` for exactly the templates that changed since the last committed document, so the daemon's next `select()` call sees the new content without restarting. Every write re-reads the document under a cross-process writer lock before persisting, so a write can never resurrect a document an external edit already replaced. Set `watch: false` to disable this monitor for a single-process or ephemeral store.

## Service

`ctx.taskTemplates` exposes `list`, `get`, `versions`, `personalization`, `create`, `update`, `setEnabled`, `delete`, `personalize`, and `select`. Method-layer edits archive the previous complete revision and increase the version. Enablement and personal-layer edits do not change the method version. Writes are serialized and become visible only after atomic persistence succeeds.

Selection first filters enabled templates whose declared fields all admit the task. It then orders candidates by constrained-dimension count, explicit rank, name, and id. An explicit template id overrides automatic ranking but still rejects an unknown or disabled record. No match means `skip`; the system does not inject a generic fallback.

Match fields cover task type, domain, objective keywords, output format, risk, required tools, required skills, operators, language, and priority. These fields select guidance only. They cannot authorize a tool, elevate a sandbox, or change a selected operator.

Methods may use `{{objective}}`, `{{taskType}}`, `{{domain}}`, `{{outputFormat}}`, and `{{language}}`. Rendering is single-pass and rejects malformed, unknown, or unavailable variables. Every selection returns the selected identity, display name, exact rendered layers, content digest, candidate order, attributes, and rationale in a serializable receipt; readers of an older receipt with no display name may fall back to its candidate entry or id.

## Model Experience

### Selected template content

#### What the model sees

When a Consumer injects a `TaskTemplateSelection`, the selected content consists of the rendered method and optional preferences and memory pinned in its receipt. This Service Definition does not add a model message by itself; the Consumer owns the surrounding message and its placement.

#### Token effect

Zero until a Consumer injects a selection. An injecting selection adds a data-dependent number of tokens from the rendered method and optional personal layers; the Consumer defines how often that content is injected and how long it remains.

#### KV Cache effect

An unchanged receipt keeps the package-owned selected bytes stable. Selecting another template or version, changing its personalization, or rendering different task variables changes those bytes; the Consumer owns placement and retention, so it determines where the reusable request prefix ends.

## Known Limitations and Deferred Work

- Attribute inference is Consumer-owned and deterministic; this package does not use another model to classify a task.
- There is no template import/export or cross-device merge operation. Remote Frontends manage the selected Server's private store through authenticated RPC.
- Personal content is protected by local file permissions, not application-level encryption.
