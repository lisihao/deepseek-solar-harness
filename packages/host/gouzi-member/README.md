# @deepseek-ai/dsh-host-gouzi-member

English | [中文](README.zh.md)

Provider of `ctx.gouziMember` for one Gouzi execution member. The Service Definition is `GouziMemberService` in `@deepseek-ai/dsh-client-connection`, which the Remote Sync `gouzi` scope consumes. This package stores the member's identity, admits or refuses each execution grant, and keeps the durable idempotency ledger. It is the sole writer of `<stateRoot>/gouzi/identity.json` and `<stateRoot>/gouzi/ledger.json`, both owner-only.

The main instance provisions the identity once with `provisionGouziIdentity`: `gouziId`, `ownerId`, `hostId`, `generation`, and the `authorityEpoch` minted at pairing. A member that starts without an identity fails loudly; it never accepts the first connection it sees. An existing identity is never replaced, so re-pairing is an explicit later operation and not an overwrite.

`admit` runs before the workspace is materialized or a Resident turn starts. It refuses, in order, another member, another generation, another authority epoch, and a request whose `gouziRequestHash` differs from the grant's `planHash`. It then consults the ledger by execution id. The same id with the same hash returns the stored accepted receipt, or `new` when an earlier attempt was admitted but never recorded a receipt; the same id with another hash is `GOUZI_EXECUTION_CONFLICT`. Only a new execution is checked against the grant `deadline`, so a reconnecting main instance can still reconcile an accepted execution after its deadline. `recordAccepted` stores the receipt the main instance received. Every start increments an `incarnation` counter reported by `gouzi.hello`.

Config: `stateRoot`, the member's absolute state root.

## Model Experience

None, as this execution-member gate registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; identity checks and the ledger remain outside the model context.

## Known Limitations and Deferred Work

- Grant `scopes` and `credentialRefs` are parsed and carried but not yet enforced against file or effect access; the first version relies on the clean-commit workspace and the Resident operator's own tool policy.
- Re-pairing, which mints a new authority epoch, and retiring a member are not implemented; both are later phases.
- The ledger is one JSON document written whole on every change. It is sized for the first version's single active task per member and is not a high-rate store.
