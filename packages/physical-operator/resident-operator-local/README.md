# @deepseek-ai/dsh-resident-operator-local

English | [中文](README.zh.md)

Local Service Provider and independent daemon for `ctx.residentOperators`. The DSH plugin is a disposable Unix-socket client; `dsh-resident-operatord` is the sole SQLite writer and survives DSH/HMR disposal. It owns command receipts, single-session leases, state revisions, bounded structured events, and content-addressed large results.

Claude Code uses the official Agent SDK with persisted/resumed sessions. Codex uses the pinned app-server daemon over its owner-local Unix WebSocket control socket with non-ephemeral threads; the CLI `proxy` is only a raw WebSocket byte bridge, not an NDJSON transport. Both drivers fail closed unless the installed CLI proves native subscription authentication; API-key fallback is not supported.

## Protocol, storage, and recovery

JSON-RPC 2.0 messages are newline-delimited over an owner-only Unix socket. Handshake rejects mismatched Resident protocol, state schema, daemon build, required method set, product version, product protocol hash, or native-subscription qualification. The daemon stores `resident_sessions`, `command_receipts`, `session_leases`, bounded events, and artifact indexes in a single-writer WAL database.

A receipt advances `accepted -> running -> settled`; a daemon crash before provable settlement recovers it as `indeterminate`. Replaying the same command and canonical hash returns the same receipt, while changed content conflicts. A retry is admitted only after explicit resolution, uses a new command id, and records a unique link to the old receipt. Graceful daemon stop drains admitted turns; forced process death relies on startup recovery and never auto-replays work.

## Configuration and security

| Field | Default | Meaning |
|---|---:|---|
| `dshHome` | resolved DSH home | Parent of `resident-operators/`. |
| `autoStart` | `true` | Start the independent local daemon when no compatible socket is reachable. |
| `connectTimeoutMs` | `5000` | Bounded connection and startup wait. |
| `pollIntervalMs` | `250` | Turn-settlement polling interval. |

The root is mode `0700`; socket, lock, pid, SQLite files, and artifacts are mode `0600`. Raw prompts and terminal screens are not stored. Receipts store only a canonical hash; persisted failures redact prompt and credential-shaped material. Product children receive the shared credential-scrubbed environment, native product permission/approval policies remain authoritative, and neither driver falls back to an API key.

When hosted by an Electron application with the RunAsNode fuse enabled, the client adds `ELECTRON_RUN_AS_NODE=1` only to the detached daemon bootstrap child. The daemon removes that marker before qualifying or launching Claude Code and Codex, so product processes never inherit Electron's launch mode. Ordinary Node hosts also strip a stale inherited marker.

## Model Experience

Indirectly, through the dual-mode physical-operator provider and `physical_operator` tool. The daemon stores no raw prompt or terminal screen; a large final result becomes a SHA-256 artifact reference.

#### KV Cache effect

No direct invalidation; the model-visible physical-operator Consumer owns its schema.

## Known Limitations and Deferred Work

- Protocol version 1 supports local Unix sockets and macOS acceptance; Windows named pipes are deferred.
- Product-native permission policies remain authoritative. DSH file sandboxing does not automatically confine these external products.
- Human write takeover, durable Jobs projection, remote farms, scheduling affinity, and transcript persistence are intentionally absent.
