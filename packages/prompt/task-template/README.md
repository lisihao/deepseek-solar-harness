# @deepseek-ai/dsh-task-template

English | [中文](README.zh.md)

Task-level prompt-template Service Definition, deterministic selector, and file-backed Provider. Users define reusable methods and matching task characteristics; Consumers ask `ctx.taskTemplates.select()` for the best enabled template without granting tools, permissions, or execution authority.

## Storage and config

The default document is `<DSH_HOME>/task-templates.json` (`~/.dsh/task-templates.json` when no home is configured). The Provider creates parent directories with mode `0700` and writes the document atomically with mode `0600`. It never reads a repository or working-directory template file.

| Key | Default | Meaning |
|---|---|---|
| `dshHome` | resolved DSH home | Private-data root used when `path` is absent. |
| `path` | `<dshHome>/task-templates.json` | Explicit JSON document path. |

Every read validates the complete document, its format version, unique ids, complete revision histories, match fields, and personal layers. Corrupt or unsupported documents fail startup instead of being replaced.

## Service

`ctx.taskTemplates` exposes `list`, `get`, `versions`, `personalization`, `create`, `update`, `setEnabled`, `delete`, `personalize`, and `select`. Method-layer edits archive the previous complete revision and increase the version. Enablement and personal-layer edits do not change the method version. Writes are serialized and become visible only after atomic persistence succeeds.

Selection first filters enabled templates whose declared fields all admit the task. It then orders candidates by constrained-dimension count, explicit rank, name, and id. An explicit template id overrides automatic ranking but still rejects an unknown or disabled record. No match means `skip`; the system does not inject a generic fallback.

Match fields cover task type, domain, objective keywords, output format, risk, required tools, required skills, operators, language, and priority. These fields select guidance only. They cannot authorize a tool, elevate a sandbox, or change a selected operator.

Methods may use `{{objective}}`, `{{taskType}}`, `{{domain}}`, `{{outputFormat}}`, and `{{language}}`. Rendering is single-pass and rejects malformed, unknown, or unavailable variables. Every selection returns the exact rendered layers, content digest, candidate order, attributes, and rationale in a serializable receipt.

## Model Experience

This Service Definition contributes no model message by itself. [`dsh-task-template-context`](../task-template-context/README.md), TaskGraph, Debate, and physical-operator dispatch Consumers own model-visible injection.

#### Token effect

None until a Consumer selects and injects a template.

#### KV Cache effect

None directly. A Consumer appends selected guidance after the reusable request prefix where its transport permits.

## Known Limitations and Deferred Work

- Attribute inference is Consumer-owned and deterministic; this package does not use another model to classify a task.
- There is no template import/export or cross-device merge operation. Remote Frontends manage the selected Server's private store through authenticated RPC.
- Personal content is protected by local file permissions, not application-level encryption.
