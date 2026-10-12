# Agent Note: Remote native workspace context and private admission input

Status: implemented

English | [中文](2026-10-04-remote-native-workspace-context.zh.md)

## Problem

A remote executor materializes a repository at a host-local path, while the sealed TaskGraph context can contain the sender's workspace and historical absolute paths. Treating those paths as receiver directories misdirects native filesystem operations. A canonical request hash identifies admitted content but cannot reconstruct the actual resolved inputs supplied to the native Driver. An HTTP 5xx response also does not establish whether the remote command was admitted.

## Decision

The [TaskGraph prompt owner](../../../../packages/orchestration/orchestration-local/README.md#model-experience) labels the source path `Sender workspace` and directs native executors to use their current working directory with the listed relative scopes. The [Remote Sync Host](../../../../packages/client/connection/README.md#remote-sync-and-stable-session-handoff) appends deterministic JSON containing receiver cwd, repository identity, and commit to the execution system prompt. It preserves the original task, historical paths, envelope, and digest; the accepted context receipt identifies only that original input. This separates sealed source context from derived host input without expanding permissions.

The [Resident daemon](../../../../packages/physical-operator/resident-operator-local/README.md#protocol-storage-and-recovery) remains the sole admission writer. It atomically retains the complete canonical resolved input in the private accepted event before calling the Driver, and removes that snapshot from public progress projections. Same-command/hash replay retains the first snapshot; a different hash conflicts. Existing events remain readable, with no new schema, table, or protocol version.

Remote HTTP 5xx diagnostics retain a bounded body or an unavailable-body fallback while preserving transport failure and indeterminate-command semantics. Unknown admission or execution phases require reconciliation rather than automatic replay.

## Alternatives considered

**Rewrite arbitrary sender text or historical paths.** Text replacement can change task meaning and invalidate the sealed input digest. The explicit receiver supplement preserves the original material and names the execution directory separately.

**Retain only the request hash or add another input writer.** A hash cannot recover the resolved Driver input. Recording it in the existing atomic admission event preserves one Resident writer and prevents partial admission records; public projection prevents the private input from becoming progress output.

**Treat every 5xx body as refusal or retry automatically.** Neither status nor body establishes the external effect. Broad catch-and-retry or heuristic task repair can duplicate a command whose admission succeeded. The transport diagnostic retains evidence without changing classification or task acceptance.

## Consequences

The execution prompt can contain both historical source paths and an authoritative receiver cwd. The remote allowlisted source must actually contain the locked commit; this decision does not make an unavailable commit materializable. Relative scopes and the single TaskGraph Scheduler remain unchanged.

The owner-local Resident database contains sensitive resolved inputs and remains private. Older accepted events without the snapshot do not promise reconstructible inputs. Public projections still exclude prompts, private reasoning, and raw terminal transcripts.

Focused remote, Resident, and sender-prompt tests exercise receiver supplementation, original context receipt identity, atomic input retention, replay/conflict behavior, public projection, and bounded transport diagnostics. Native process completion alone does not prove that a README was read or that task acceptance passed; actual native README success and installed-runtime delivery are outside this evidence.
