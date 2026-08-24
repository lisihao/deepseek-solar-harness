# Durable surfaces belong to capability plugins

English | [中文](2026-08-25-durable-surfaces-belong-to-capability-plugins.zh.md)

DSH Server is the sole authority for Resident physical-operator sessions and persistent orchestration runs, while Desktop, browser and phone clients are projections of that authority. The capability surfaces therefore live with their capability packages rather than inside the Desktop product plugin.

`@deepseek-ai/dsh-ui-orchestration` and `@deepseek-ai/dsh-ui-physical-operator` are dual-face plugins. Their Host halves register authenticated HTTP projections; their Client halves register ordinary Cordis slots. The Resident bundle mounts its UI package, and the orchestration bundle already mounts its UI package, so a pure Server profile advertises both browser modules in its boot manifest without importing Electron or Desktop code. Desktop now contributes only product branding and native shell behavior.

All generic Client HTTP surfaces use `ctx.connection.request`. The connection service attaches the same memory-only bearer as the primary remote transport, so feature plugins do not import credential storage or know whether the page is local or frontend-only. Host routes share `authorizeRemoteRequest`: strict loopback requests may read locally, while non-loopback requests require the Remote Auth bearer. The Resident projection is read-only; task execution and durable state mutation remain owned by the existing Resident and orchestration services.

This split preserves one package graph for local Desktop, Mac mini Server and remote browser clients. Disconnecting a Client unloads only its slot contribution; it cannot stop a daemon, complete a run, or create a second state writer. A Server-only composition test must prove both APIs and both boot-manifest modules without mounting the Desktop plugin.
