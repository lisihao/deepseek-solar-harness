# @deepseek-ai/dsh-task-template-rpc

English | [中文](README.zh.md)

Authenticated Host RPC management Consumer for `ctx.taskTemplates`. The `/task-templates` channel exposes list, create, update, enable/disable, delete, personalize, and preview operations to trusted cockpit/admin clients. Every mutation returns the new authoritative snapshot.

The RPC validates exact payload keys and all untrusted task attributes before calling the typed Service. It is registered with `trusted-host` authority; an anonymous LAN origin and pocket scope cannot read personal templates.

## Model Experience

This package contributes no model-visible content and makes no model call.

#### Token and KV Cache effect

None.

## Known Limitations and Deferred Work

- Snapshot transfer is whole-list rather than paginated.
- Conflict control uses the Host's serialized Service writes; the RPC does not expose a separate revision precondition.
