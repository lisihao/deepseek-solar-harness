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

### What P1 builds

| Area | Where |
|---|---|
| Restricted device scope | `gouzi` scope in `packages/host/remote-auth` and `packages/client/connection`: only `describe`, `gouzi.hello`, and the `operator.*` methods; `/api`, snapshot, replica, cluster, the device roster, and the event sockets refuse it |
| Member gate | `GouziMemberService` (Definition and wire Consumer) in `packages/client/connection`; Provider `packages/host/gouzi-member` (stored identity, grant admission, durable idempotency ledger) |
| Member registry | `GouziRegistry` over schema 5 (`gouzi_hosts`, `gouzi_members`) in `packages/orchestration/orchestration-local`; the ten-member rule is one immediate transaction; exposed as `OrchestrationService.gouzi` (`GouziControl` in the contract) and as daemon protocol 6 methods `gouzi.*` |
| Operator | `gouziOperatorServer` and the grant hook in `RemotePhysicalOperator`; the daemon registers enabled members each refresh and tracks `connection` and `activity` |
| Member process | `dsh-gouzi-worker` (`prepareGouziWorkerProfile`, `startGouziWorker`) and the `./remote-host` entry of `orchestration-local` in `products/desktop/dsh-plugin-desktop`; `GouziSupervisor` starts, adopts, and stops detached members |
| Entry UI | `packages/orchestration/ui-gouzi`: `/api/gouzi`, `GouziHostService` (Provider `gouzi-host` in the Desktop plugin), six SVG avatars, the four-step adoption wizard |

Decisions the implementation settled:

- **`planHash` seals the posted request.** It is `gouziRequestHash` of the execution request without `commandId` and the grant, so the member recomputes it from what it received. The sealed node plan is reachable from the attempt through the execution id.
- **A member host gates every caller.** A host that mounts the member gate requires a grant for every `operator.execute`, including a loopback owner or an SSH-tunnel endpoint, which the connection treats as `admin`. Otherwise the `gouzi` scope would be bypassed.
- **The endpoint belongs to the member.** Several members on one host listen on different ports, so the endpoint is on the member row and replaced at each start.
- **Explicit refusals are not transport failures.** HTTP 400, 403, 404, 409, and 422 from a member are rejections; any other failure after the command left stays `COMMAND_INDETERMINATE`.
- **The Resident daemon outlives its member.** Stopping a worker leaves its detached Resident daemon running so durable turns survive a restart; retiring stops both and archives only when no process remains.
- **A member runs no scheduler.** The worker profile disables every orchestration row and mounts only the remote-host entry; its home gets no orchestration state.

### Remote hosts over SSH

A member can live on another machine, such as a Mac mini, that the user adds from the adoption wizard.

- **System OpenSSH, no new dependency.** The Desktop `gouzi-host` Provider runs the system `ssh`, `ssh-keygen`, and `ssh-keyscan`. A library would add a dependency that the existing platform trust store, agent, and `known_hosts` handling already cover.
- **The user confirms the machine before any login.** `host-inspect` reads the host key and shows its fingerprint. `host-add` carries the confirmed fingerprint and is refused if the machine presents another key. The key is then pinned in a per-host `known_hosts` and every later connection uses `StrictHostKeyChecking=yes`.
- **The password is used once.** `host-add` logs in with the password through a temporary `SSH_ASKPASS` script that reads it from the child's environment, installs a dedicated ed25519 key, and discards the password. It is not stored, logged, or returned. If the machine is then found unusable, or the host is removed, the key is taken back out of the remote `authorized_keys` when the machine answers.
- **Nothing is uploaded.** The remote machine runs its own installed DSH Desktop through `ELECTRON_RUN_AS_NODE`. The `dsh-gouzi-agent` command performs one operation per call (`probe`, `resolve`, `browse`, `provision`, `start`, `stop`) and prints one `DSH-GOUZI-AGENT` result line. A protocol number and a minimum version (3.36.0) are checked when the host is added, so a machine with an older application is refused with a request to upgrade.
- **The endpoint is a local port forward.** The member listens on the remote loopback. The main instance opens `ssh -N -L` to it, keeps the local port in the host catalog so the stored endpoint stays valid across restarts, reopens a dropped forward with the same port, and falls back to a new port only if another process took the old one. A remote member still needs an execution grant for every call; the forward gives it no extra permission.
- **No schema change.** The orchestration store keeps the host row (label, authority epoch, credential reference). The SSH address, user, dedicated key, and pinned host key live in the Desktop catalog `gouzi/hosts`, so schema 5 stays.

Limits: a task takes its workspace identity from a clean Git checkout on the main instance, so a repository that exists only on the remote machine cannot receive tasks yet; that needs a remote-resident workspace identity and is the next piece. The user-facing local/remote Server picker stays until remote members cover that case, and is then retired with a migration of saved Server entries.

### The kennel

The adopted dogs are not worked with through a management dialog. Adoption, editing, wake, rest, retire, and adding machines are configuration and live in Settings (a **狗子** section). What the user meets every day is the **kennel**, a sidebar row that opens one chat.

- **First version: an ordinary session with a preset.** The row opens the newest session whose preset is `kennel`, or starts a session in the current workspace and gives it the preset while it is still blank (the host refuses to change the preset of a session that has history). The `kennel` preset is the standard coding composition with a steward persona and a context plugin that lists the enabled dogs, where each lives, whether it answers, and the operator ids `gouzi.<id>.codex` and `gouzi.<id>.claude-code`.
- **The steward is the main instance's agent, not a dog.** It plans and routes with the existing `orchestration` tool, setting `operator.preferredIds` per node, so the main instance stays the only TaskGraph, Scheduler, and acceptance authority. Parallel nodes assigned to different dogs are how "split the work" happens, and the existing task-graph, progress, and approval surfaces show it.
- **Why not a dedicated group-chat room first.** A room needs its own message log, a view with a speaker per dog, and a channel for dog-to-dog messages with bounds on cost and loops. That is the P3 scope (roles, automatic division of work, bounded messages). Reusing the chat session gives a working kennel now and keeps the room as a later view over the same dispatch path.
- **Limits that follow.** A dog does not speak in its own bubble and dogs do not message each other; the steward reports and relays. The roster is read on every prompt assembly, so a dog adopted or retired in Settings appears on the next request. The workspace of the kennel session must still be a clean Git checkout whose `origin` is a repository the dog was allowed.

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
