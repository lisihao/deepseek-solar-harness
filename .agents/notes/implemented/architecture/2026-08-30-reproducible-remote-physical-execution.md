# Agent Note: Reproducible remote physical execution

Status: implemented

English | [中文](2026-08-30-reproducible-remote-physical-execution.zh.md)

## Problem

Remote Physical Operators originally forwarded the scheduling machine's absolute workspace path and kept only the remote Resident artifact reference for oversized results. An absolute path has no stable meaning on another Server, and a remote-only reference leaves the scheduling authority unable to retain and independently verify the result. Remote capacity also lived in `remote-operators.json` separately from `cluster.json`, so membership and schedulable capacity could drift.

## Decision

Remote Sync carries a versioned workspace identity consisting of a credential-free canonical repository identity, exact clean Git commit, and optional repository-relative subdirectory. The `@deepseek-ai/dsh-client-connection` package owns this wire contract and a `ctx.remoteOperatorHost` Service Definition; `@deepseek-ai/dsh-orchestration-local` provides the Server-local Git and Resident-artifact implementation. The receiving Server resolves only repositories in its local allowlist, keeps immutable Git objects in an owner-private cache, and creates a leased command-isolated writable checkout. Neither the sender's absolute path nor Git credentials enter the wire. The Server advertises execute only after qualification proves that the local cluster member enabled remote execution and at least one configured repository is materializable.

Remote Sync exposes at most 8 MiB of exact immutable JSON bytes for an oversized Resident result reference under a bounded read deadline. The caller verifies the claimed SHA-256 over those bytes, validates the complete product-neutral result, and writes a provenance envelope into its local Orchestration CAS before settlement is returned to the Scheduler. Accepted command identity, polling affinity, indeterminate handling, and generation fencing do not change. Protocol 1.3 remains projection-compatible with a 1.4 Server, but its legacy execute shape is not admitted.

`cluster.json` owns both election membership and remote execution capacity. Each member may declare `remoteExecution`, including its enabled state, polling interval, and repository allowlist. The old `remote-operators.json` remains a migration-only input when no cluster member declares remote execution; using both sources is an error.

## Verification

Focused composition tests derive identity from a real temporary Git repository, materialize its exact detached commit and subdirectory on the Server side, prove that concurrent executions cannot share tracked or untracked mutations, reject dirty or unknown repositories, transfer and corrupt/size/cancellation-check exact Resident artifact bytes, persist the complete result in local CAS, and verify that the wire request contains no absolute workspace. Election tests suspend votes and heartbeats to prove that a later term fences stale completions; daemon tests prove close quiescence and persisted detached-tick failure diagnostics.

## Alternatives considered

**Forward or rewrite absolute paths.** Rejected because identical path text neither identifies identical content nor proves that two machines share a filesystem. A configurable prefix map would reproduce the ambiguity instead of defining the input.

**Let every remote Server clone any sender-provided URL.** Rejected because repository availability and credentials are deployment concerns. The wire identifies content; the Server-local Provider owns how an allowed repository is obtained.

**Keep oversized results only on the executing Server.** Rejected because the scheduling authority could not prove or retain the result behind its settled attempt. Copying exact bytes and then using the caller's CAS preserves both remote and local content identities.

**Keep membership and capacity catalogs independent.** Rejected because a stale second catalog could schedule work onto a node outside the current authority topology or omit a valid member.

## Consequences

- Remote work accepts only clean committed Git inputs with an origin and a Server-local allowlist entry; uncommitted changes require a commit before dispatch.
- Every execution Server decides its own source path or credential-free URL, so repository credentials remain outside Remote Sync.
- Exact Git objects are cached, while every execution gets an isolated writable checkout whose lease is renewed by observation and released on proven settlement.
- Large remote results incur one bounded artifact transfer and one local CAS write before the Scheduler observes terminal output.
- Capacity discovery and leader election share one member roster; changing membership still requires explicit fixed-cluster configuration.
