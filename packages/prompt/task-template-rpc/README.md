# @deepseek-ai/dsh-task-template-rpc

English | [中文](README.zh.md)

Authenticated Host RPC management Consumer for `ctx.taskTemplates`. The `/task-templates` channel exposes list, create, update, enable/disable, delete, personalize, and preview operations to trusted cockpit/admin clients. Every mutation returns the new authoritative snapshot, allowing a multi-operation editor to retain each earlier committed result; preview returns the deterministic explicit selection and its rendered content layers.

The RPC validates exact payload keys and all untrusted task attributes before calling the typed Service. It is registered with `trusted-host` authority; an anonymous LAN origin and pocket scope cannot read personal templates.

## Model Experience

### Management RPC

#### What the model sees

RPC payloads and responses do not enter a model request. Mutations change private template data that `@deepseek-ai/dsh-task-template-context` may inject into a later logical task.

#### Token effect

List, mutation, and preview requests add no direct tokens and make no model call. A mutation affects later tokens only when `@deepseek-ai/dsh-task-template-context` selects the changed template.

#### KV Cache effect

RPC handling does not alter an in-flight request prefix. A mutation can change the injected prefix of a later task that selects the template.

## Known Limitations and Deferred Work

- Snapshot transfer is whole-list rather than paginated.
- Conflict control uses the Host's serialized Service writes; the RPC does not expose a separate revision precondition.
