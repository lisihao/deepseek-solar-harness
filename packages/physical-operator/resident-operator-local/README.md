# @deepseek-ai/dsh-resident-operator-local

English | [中文](README.zh.md)

Local Service Provider and independent daemon for `ctx.residentOperators`. The DSH plugin is a disposable Unix-socket client; `dsh-resident-operatord` is the sole SQLite writer and survives DSH/HMR disposal. It owns command receipts, single-session leases, state revisions, bounded structured events, and content-addressed large results.

Claude Code uses the official Agent SDK with persisted/resumed sessions and reads its subscription-visible models through the SDK control channel without submitting a prompt. Qualification resolves one absolute user-owned `claude` executable, and SDK model discovery and turns use that same executable instead of the SDK's bundled fallback; version, Keychain refresh behavior, TLS trust, and subscription state therefore cannot diverge between the qualification and execution paths. Codex uses the pinned app-server daemon over its owner-local Unix WebSocket control socket with non-ephemeral threads and reads models through `model/list`; the CLI `proxy` is only a raw WebSocket byte bridge, not an NDJSON transport. Both drivers fail closed unless the installed CLI proves native subscription authentication; API-key fallback is not supported.

## Protocol, storage, and recovery

JSON-RPC 2.0 messages are newline-delimited over an owner-only Unix socket. Handshake rejects mismatched Resident protocol, state schema, daemon build, required method set, configured Driver manifest, product version, product protocol hash, or native-subscription qualification. Protocol v6 adds the generic Driver SPI and graceful `system.shutdown`; a newly configured Driver set retires an older incompatible daemon before reconnecting. The daemon stores `resident_sessions`, `command_receipts`, `session_leases`, bounded events, and artifact indexes in a single-writer WAL database.

Codex model discovery is an execution prerequisite, while subscription quota telemetry is advisory scheduling input. A transient rate-limit telemetry failure therefore preserves the qualified model catalog and execution path, exposes `quotaUnavailableReason`, and leaves quota pools unknown instead of misreporting the whole native subscription as unavailable.

A receipt advances `accepted -> running -> settled`; bounded `turn.progress` phases expose connection, native-session readiness, reasoning/tool activity, and finalization without storing prompts or transcripts. Protocol v5 carries a required caller-owned lane plus a sanitized, 160-character display-only task label on the Receipt and accepted event, and its `session.list` reads durable state without native product qualification. State migrations copy historical rows by named columns, so earlier `ALTER TABLE` column order cannot shift Receipt fields during a table rebuild. Concurrent qualification requests for one operator share a single in-flight probe; Claude Code checks version, subscription status, and model catalog in order. Before admission, the daemon validates explicit model/effort fields against the live product catalog, resolves Smart Auto omissions, and locks the effective profile to the operator/workspace/lane Session. A manually selected effort with an automatic model constrains automatic selection to models that advertise that effort; if none exists, admission fails loud instead of choosing an incompatible model. Later profile changes fail until reset. A newly connected DSH or Desktop client can inspect that profile, lane, active turn, latest phase, and settled result from daemon-owned state. A daemon crash before provable settlement recovers the receipt as `indeterminate`. Replaying the same command and canonical hash returns the same receipt, while changed content or profile conflicts. A retry is admitted only after explicit resolution, uses a new command id, and records a unique link to the old receipt. Graceful daemon stop drains admitted turns; forced process death relies on startup recovery and never auto-replays work.

Caller cancellation and client disposal detach only the local polling handle after admission; they do not send `turn.interrupt`. This keeps a daemon-owned native turn alive across DSH, HMR, or Desktop restart. Trusted callers that intend to stop product work must use the explicit interrupt method.

## Configuration and security

| Field | Default | Meaning |
|---|---:|---|
| `dshHome` | resolved DSH home | Parent of `resident-operators/`. |
| `autoStart` | `true` | Start the independent local daemon when no compatible socket is reachable. |
| `connectTimeoutMs` | `5000` | Bounded connection and startup wait. |
| `pollIntervalMs` | `250` | Turn-settlement polling interval. |
| `driverModules` | `[]` | Independent product Driver packages loaded by the detached daemon. |

The root is mode `0700`; socket, lock, pid, SQLite files, and artifacts are mode `0600`. Raw prompts and terminal screens are not stored. Receipts store only a canonical hash; persisted failures redact prompt and credential-shaped material. Product children receive the shared credential-scrubbed environment, native product permission/approval policies remain authoritative, and neither driver falls back to an API key.

When hosted by an Electron application with the RunAsNode fuse enabled, the client adds `ELECTRON_RUN_AS_NODE=1` only to the detached daemon bootstrap child. The daemon removes that marker before qualifying or launching Claude Code and Codex, so product processes never inherit Electron's launch mode. Ordinary Node hosts also strip a stale inherited marker.

## Model Experience

Indirectly, through the dual-mode physical-operator provider and `physical_operator` tool. The daemon stores no raw prompt or terminal screen; a large final result becomes a SHA-256 artifact reference.

#### KV Cache effect

No direct invalidation; the model-visible physical-operator Consumer owns its schema.

## Known Limitations and Deferred Work

- Protocol version 6 and state schema version 4 support local Unix sockets and macOS acceptance; schemas v1 through v3 migrate into the compatibility `legacy` lane, while Windows named pipes are deferred.
- Product-native permission policies remain authoritative. DSH file sandboxing does not automatically confine these external products.
- Human write takeover, durable Jobs projection, remote farms, scheduling affinity, and transcript persistence are intentionally absent.
