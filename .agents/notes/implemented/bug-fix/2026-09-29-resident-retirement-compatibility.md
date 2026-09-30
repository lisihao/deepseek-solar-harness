# Agent Note: Bounded Resident daemon retirement compatibility

Status: implemented

English | [中文](2026-09-29-resident-retirement-compatibility.zh.md)

## Problem

The state schema 6 client cannot use its strict schema 6 handshake to qualify a schema 5 daemon before sending `system.shutdown`. Treating that failed handshake as permission to kill the recorded PID would risk stopping a replacement process or losing active native work.

## Decision

Business requests keep the protocol 14/state schema 6 handshake. Retirement first preserves the existing path for a peer that returned a complete handshake response: it re-handshakes the observed protocol, state schema, and Driver manifest identity, then requires the response's non-empty `daemonInstanceId` and the observed PID to match the authority SQLite record before sending `system.shutdown` on that same qualified transport.

When the adjacent schema 5 peer gives no response to the initial schema 6 handshake, retirement makes one direct compatibility probe with request fields `protocol_version: 14`, `state_schema_version: 5`, and the current Driver manifest digest. It accepts only a response declaring protocol 14/schema 5, the same Driver digest, a non-empty `buildCommit` and `daemonInstanceId`, and the required methods. It then applies the same instance-and-PID authority check before graceful shutdown. A mismatch or unconfirmed peer fails closed with `PROTOCOL_MISMATCH`; no PID kill or active-work loss is used. This compatibility exception covers only the adjacent schema 5 to schema 6 upgrade and adds no configuration field.

## Alternatives considered

- **Use the strict schema 6 handshake for every retirement.** Rejected because a schema 5 daemon cannot answer it, leaving the known upgrade unable to drain and stop the old daemon.
- **Kill the recorded PID after a failed handshake.** Rejected because the PID may have been reused and the process may own active native work; the authority instance and PID must both be observed and confirmed.
- **Relax the business handshake to accept schema 5.** Rejected because ordinary requests must retain strict protocol and state-schema qualification.
- **Accept any schema 5 response for shutdown.** Rejected because the response must prove the same Driver manifest, required methods, daemon identity, and observed authority owner.

## Consequences

An adjacent 3.25.1-style daemon can drain and retire during a 3.25.2-style upgrade without weakening normal request qualification. Same-schema peer mismatches continue through the existing observed-identity retirement path; peers whose identity cannot be confirmed remain running and report `PROTOCOL_MISMATCH`.

The compatibility path is intentionally narrow and transport-local. It does not claim general cross-schema support, automatic process replacement, or recovery of an unconfirmed daemon.
