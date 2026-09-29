# Agent Note: Native tool authority and catalog freshness

Status: implemented

English | [中文](2026-09-29-native-tool-authority-and-catalog-freshness.zh.md)

## Problem

A Resident Driver can hold a sealed model-tool descriptor after the owning DSH Session changes or releases it. Sending native work from that descriptor without rechecking the owner can reach a different Session or tool set. This detail extends the [first-class DSH tool authority](2026-09-02-first-class-model-tool-authority.md) decision.

Codex execution uses the owner's shared app-server daemon, but a long-lived shared app-server can retain a stale model catalog after local Codex model caches update: the observed shared daemon did not report `gpt-6.1-sol` while a fresh stdio process did. Model and quota discovery therefore needs fresh data from the qualified executable without restarting active shared work. A cached catalog is a scheduling snapshot, not a live product response. A normal provider completion also does not prove task acceptance.

Persisted Codex threads also need to distinguish equivalent owner reattachment from changed DSH tool schemas; a changed catalog cannot silently continue native history.

## Decision

Before a native turn starts, the Driver calls the owner `tool.describe` and requires protocol version 1, active Session identity, and the exact sealed tool names. A missing bridge rejects admission; a mismatched description returns `PROTOCOL_MISMATCH`; an unavailable owner returns `RUNTIME_UNAVAILABLE`. Codex dynamic-tool descriptions and native instructions identify every exposed name as DSH-owned and state that DSH permissions and logging govern calls, including names that resemble shell or file tools.

Codex stores a SHA-256 digest of the native tool policy and complete DSH tool schemas, with tool names and nested schema keys normalized and sorted. Bridge endpoint and binding Session identities are excluded so owner reattachment does not change the digest. A different digest on a persisted Codex thread, or a missing digest on a legacy thread under `dsh-tools-authoritative`, fails with `PROTOCOL_MISMATCH` and instructs `session.reset`; reset explicitly clears the native thread identity and digest and never silently starts fresh history.

Codex turns and compaction continue through the shared owner-local app-server daemon with non-ephemeral threads. Qualification reads `model/list` and optional `account/rateLimits/read` in a fresh short-lived `--stdio` app-server process launched from the qualified executable and bounded by 15 seconds. The process is closed after the read, cannot start `thread/start` or `turn/start`, and does not restart or replace the shared daemon. The model catalog is required; quota telemetry remains advisory and unknown on read failure.

State schema v6 adds nullable `resident_sessions.native_tool_catalog_sha256`; the v5-to-v6 migration is additive and retains existing Sessions, receipts, leases, events, and artifacts. An identical canonical command may reattach an active bridge descriptor only after the new owner passes `tool.describe`; each new tool call reads the current descriptor, while in-flight calls are never retried and retain indeterminate semantics if their outcome is lost. Client `connectTimeoutMs` propagates through the client, daemon, and Driver as a bridge-admission bound only; it does not time out the native turn.

`completed` means the provider turn ended normally. It is not evidence of task acceptance, task correctness, full resume coverage, or a verified end-to-end outcome.

## Alternatives considered

- **Trust the sealed descriptor without `tool.describe`.** Rejected because release or rebind can leave a descriptor syntactically valid while its owner no longer serves the same Session and tool names.
- **Read catalogs through the long-lived shared daemon.** Rejected because it can retain stale model data after local Codex caches update; catalog refresh must not restart or replace active shared work, so the isolated stdio child reads current data and closes independently.
- **Let a changed catalog continue a persisted Codex thread.** Rejected because a changed DSH tool schema changes the native authority even when the endpoint can be reattached; the caller must reset explicitly before starting fresh native history.
- **Use cached catalogs as live data.** Rejected because model availability and quota can change between status reads; the cache remains a scheduling snapshot.
- **Treat provider `completed` as task acceptance.** Rejected because provider lifecycle and DSH task verification are separate authorities.

## Consequences

Admission errors are observable before native turn execution, and DSH provenance remains explicit at the model-visible tool boundary. Codex execution keeps the owner's shared daemon and persistent thread semantics while catalog probes own and clean up their short-lived child.

No full resume or task-acceptance guarantee is introduced here; consumers must use their own verification evidence. Existing provider status, receipt settlement, and quota advisory semantics remain unchanged.
