# Agent Note: Gouzi, long-lived execution members under one main instance

Status: proposed

English | [中文](2026-10-03-dsh-gouzi-execution-members.zh.md)

## Problem

DSH asks the user to think about servers: a local one, a remote one, and which of them holds the session. The user's real question is who stays responsible for a goal until it is accepted. The product direction is one entry DSH with a small set of named workers, called **Gouzi**, that keep executing authorized tasks on a host such as a Mac mini while the main instance plans, assigns, and accepts the results.

The platform already carries most of the machinery, so the risk is building a second one:

- `RemotePhysicalOperator` (`packages/orchestration/orchestration-local/src/remote-physical-operator.ts`) runs a task on another DSH Server through `operator.providers`, `operator.execute`, `operator.inspect`, `operator.events`, and `operator.interrupt`. It sends a clean-commit workspace identity and uses the execution id as the command id. A transport failure after the command left the process settles as `COMMAND_INDETERMINATE`; it never resends.
- The Server side is `packages/client/connection/src/index.ts` and `remote-sync-host.ts`. `operatorExecute` materializes the workspace from the identity, then starts the Resident turn. A connection scope (`pocket`) already exists and is refused on these routes.
- The daemon registers remote Servers in `refreshRemoteOperators` (`daemon.ts`) from a catalog under the orchestration root, with ids `remote.<serverId>.<operatorId>`.
- Scheduling authority comes from the cluster election only when a cluster is configured, and `runTick` is gated on `canSchedule`.
- `startup.ts` accepts only the deployment roles `web` and `server`; `worker` is rejected. Starting several ordinary Servers would give each one its own scheduler.

A Gouzi must not be a renamed Remote Frontend, ten prompt roles in one agent, or ten ordinary Servers that can each schedule.

## Proposal

**One authority, many executors.** The main instance keeps the only global TaskGraph, Scheduler, permission policy, and acceptance record. A Gouzi is a separate process with its own home, state root, Session, execution identity, and worktrees. It mounts no orchestration scheduler, no cluster election, and no member-management service; the composition decides this, not a prompt.

### Contract

The records live in `packages/orchestration/orchestration/src/gouzi.ts` and are pure types plus the member limit.

- `GouziRecord` carries `gouziId`, `ownerId`, `hostId`, `generation`, name, avatar, role and policy versions, and `membership`.
- Three independent dimensions describe a member: `membership` (`provisioning | enabled | retiring | archived`), `connection` (`online | unreachable`), and `activity` (`resting | queued | working | awaiting-approval | paused | faulted`). The UI shows one primary state and keeps all three in the detail.
- `GOUZI_MEMBER_LIMIT` is 10. `countsTowardGouziLimit` is true for every membership except `archived`. A stopped or unreachable member keeps its slot; only a member whose credentials are revoked, whose work is settled, and whose process tree is stopped or reliably isolated becomes `archived`. An expired authorization is not that evidence.
- `GouziExecutionGrant` seals one attempt: run, node, attempt, execution id, member, generation, `authorityEpoch`, plan hash, read/write/effect scopes, credential references, deadline, and `offlineUntil`. It carries no secret.
- `GouziExecutionReceipt` repeats the execution id and request hash with a sequence number, status, artifact references, and exit evidence. The same id and hash returns the stored receipt; the same id with another hash is a conflict.
- `GouziCapabilitySnapshot` is observed state with a revision and an expiry. A new task re-checks it.
- `GouziHandoff` and `GouziExperienceProposal` fix the shapes that later phases need; neither adds permission, budget, ownership, or code.

### Authority epoch

Pairing a host mints an `authorityEpoch` and the host stores the one it accepts. A main instance restored from an old snapshot must not dispatch; it re-pairs, which mints a new epoch and revokes the old binding. A lost host binding also requires re-pairing; the host never accepts the first connection it sees.

### Reuse

The member is reached through the existing remote execution path. P1 adds a restricted connection scope, an execution-grant check in front of `operatorExecute`, a durable idempotency ledger on the member, and a `gouzi.<id>.<operatorId>` operator that wraps `RemotePhysicalOperator` and attaches the grant. Cluster administration, replica, and vote routes stay unreachable for a member credential.

### Source baseline

The design was checked against `solar` at `24526765a4`, which is the current head. Each statement above was read in that source: roles in `startup.ts`, the launcher in `products/desktop/dsh-plugin-desktop/src/product-server.ts`, the operator routes in `connection/src/index.ts`, and the schema version 4 in `orchestration-local/src/store.ts`. None of it implies that a host or the installed app was exercised.

### Paths P1 will change

| Area | Path |
|---|---|
| Worker composition | new `packages/bundle/gouzi-worker/` |
| Worker launcher | new `products/desktop/dsh-plugin-desktop/src/gouzi-worker.ts` |
| Connection scope and grant check | `packages/client/connection/src/index.ts`, `remote-sync-host.ts` |
| Member table and limit | `packages/orchestration/orchestration-local/src/store.ts` (schema 5), new `gouzi.ts` |
| Operator wrapper | new `packages/physical-operator/physical-operator-gouzi/` |
| Registration | `packages/orchestration/orchestration-local/src/daemon.ts` (`refreshRemoteOperators`) |
| Host supervisor, minimal | `products/desktop/dsh-plugin-desktop/src/` |
| Entry UI | new `packages/client/ui-gouzi/` |

### Phases

P0 is this note and the contract types, with no behavior change. P1 is one member end to end: create it from the entry UI, pair a pilot host, run one authorized task in an isolated worktree, persist the receipt and artifacts, and let the main instance confirm. P2 adds atomic resource admission, process-tree reclamation, bounded offline execution, and cancel and reconnect handling. P3 adds roles, automatic division of work, bounded messages, and independent verification. P4 adds experience proposals, versioned release and rollback, and migration. Computer use is out of scope.

## Alternatives considered

**Rename the Remote Frontend.** It is a presentation role without its own execution identity, so a rename would claim a worker that does not exist.

**Start ordinary Product Servers with the `server` role.** Each one can run the scheduler and take part in the cluster election, which breaks the single authority. The member count would also be limited only by hand.

**Ten prompt roles in one agent.** It shares one Session, one process, and one set of permissions, so there is nothing to isolate, recover, or audit separately.

**Give members cluster membership.** Sleeping members would count against a quorum and an offline member could stall scheduling.

**A second task database on the host.** It would let two stores disagree about the state of a task. The main store stays the only writer; the member keeps its own execution log and unconfirmed receipts.

## Acceptance criteria

- The contract exports compile, the limit and the membership rule are tested, and `doc-sync` passes.
- The diff changes no launcher, scheduler, connection route, UI, or default.
- P1 meets the matching items of the design: create and restart keeps identity (A01), two isolated executions (A02), a member credential is refused on cluster and member-management routes (A03), a wrong generation, owner, or plan hash is refused before any effect (A04), a repeated execution id returns the stored receipt and a different hash conflicts (A05), closing the window does not stop a task (A08), a lost response is reconciled without a second dispatch (A10), and the eleventh member is refused.

## Risks

A restricted connection scope touches authentication, so every refusal needs a negative test. Schema 5 is a one-way migration and an older program cannot open the new database; the backup and rollback boundary must be written before P1 merges. P1 tasks start from a clean commit, so a dirty working tree needs an explicit snapshot in a later phase. A member shares its host user with others, so isolation here means separate state and worktrees, not a security boundary between tenants.
