# Agent Note: Resident qualification and diagnostic projection isolation

Status: implemented

English | [中文](2026-08-20-resident-qualification-and-diagnostic-projection.zh.md)

## Problem

Resident session polling reused `operator.list`, so reading durable session state also launched native product qualification. Multiple dashboard consumers could overlap those launches, and Claude Code qualification itself launched version, authentication, and model-catalog probes concurrently. A read-only user surface therefore exercised the macOS subscription credential path repeatedly and concurrently. Separately, durable orchestration acceptance fixtures under temporary `dsh-orchestration-*` workspaces appeared beside user tasks even though their deliberate failures were test evidence rather than user work.

## Decision

Resident control protocol version 4 separates `session.list` from `operator.list`. Session reads return only the daemon store projection and never qualify a native product. The daemon coalesces concurrent qualification for each operator id, while distinct product Drivers remain independent. Claude Code qualification runs the version probe, subscription-status probe, and model-catalog probe in order; model discovery starts only after the expected CLI version and a native subscription are established.

The temporary-workspace classifier still identifies runs whose normalized workspace is under `/tmp/dsh-orchestration-*` or `/private/tmp/dsh-orchestration-*` without using titles, failure codes, or task content. Its original default-hidden presentation is superseded by [Visible session and orchestration evidence](2026-08-21-visible-session-and-orchestration-evidence.md), which labels and includes retained diagnostic Runs by default while allowing an explicit projection-only hide.

## Verification

Daemon tests pin that a session list after handshake performs no additional qualification and that overlapping provider reads share one in-flight qualification. Presentation tests pin the narrow temporary-workspace classification while retaining an ordinary project. The packaged Desktop verification exercises the sealed Resident and orchestration packages from the same source commit.

## Alternatives considered

**Reduce dashboard polling frequency.** A slower interval still gives a session read an authentication side effect and leaves independent consumers able to overlap.

**Cache provider status for the process lifetime.** This avoids repeated probes but makes login, logout, version, and model availability stale until daemon restart.

**Delete failed acceptance runs.** Deletion removes useful durable test evidence and couples presentation policy to storage mutation; path-scoped classification keeps the evidence inspectable and distinct from user work.

## Consequences

Session activity remains fresh without touching native credentials. Provider status refresh still observes current native state, but simultaneous requests share one qualification and Claude Code never runs its own credential-bearing probes concurrently. Protocol version 4 intentionally rejects an older daemon method set, while the persisted state schema remains version 3. Diagnostic classification depends on the dedicated temporary workspace convention, so acceptance tooling must keep that convention when it expects Runs to carry the acceptance label.
