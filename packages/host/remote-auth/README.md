# @deepseek-ai/dsh-host-remote-auth

English | [中文](README.zh.md)

Server-owned authentication for DSH remote Frontends. The plugin provides `ctx.remoteAuth` and is the sole writer for one-time pairing challenges, durable device credentials, short-lived access sessions, fixed `cockpit` / `pocket` / `admin` scopes, revocation, and payload-free command receipts. Durable state is kept under `$DSH_HOME/remote-auth/v1`; credentials are represented only by cryptographic digests after their one-time return to the caller, while access tokens remain process-local and expire automatically.

The package deliberately exposes a small product vocabulary rather than a general RBAC framework. The connection carrier authenticates projection and command traffic with the resulting principal; orchestration uses the same principal to restrict remote controls. A remote command is accepted under `deviceId + commandId`, stores only the canonical request hash, and either returns its previously settled bounded response, reports a conflict, or remains fenced as indeterminate after an interrupted accepted operation.

## Model Experience

None, as this Server authentication authority registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; authentication and command receipts remain outside the model context.

## Known Limitations and Deferred Work

- Pairing is intentionally local and one-time; remote administrative pairing and organization-wide identity providers are not part of v1.
- Durable state uses owner-only JSON documents and one Server writer. Multi-authority replication is unsupported.
- Product scopes are fixed. Adding a new remote surface requires an explicit protocol and authorization change rather than user-defined roles.
