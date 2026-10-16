# @deepseek-ai/dsh-rlm-runtime-local

English | [中文](README.zh.md)

Owner-local Provider for `ctx.rlmRuntime`. It supplies a persistent TypeScript REPL namespace, node-local child registry, family-scoped messaging, command receipts, variable snapshots, goals, and cursor events.

## Runtime behavior

One logical RLM session owns one lexical namespace. The programmable `context` object and independently restorable bindings survive Provider restart; one failed binding remains named as degraded without blocking the others. The kernel discovers top-level declarations with the TypeScript AST, including destructuring and multiple declarations in one statement. Cloneable values restore from their latest V8 value snapshot. Static imports, functions, classes, and direct function-expression bindings that V8 cannot clone restore from their declaration source. A factory-created closure with private captured state is deliberately degraded: this runtime does not pretend that V8 can serialize closures.

Snapshot limits match Prime v0.8 defaults: 16 MiB per binding and 256 MiB for the aggregate programmable state, including `context`. An over-cap or otherwise unrestorable binding is skipped independently while the remaining namespace continues to recover.

`rlm(task, { name })` admits a child through Consumer-provided host bindings and returns a handle before the child result settles. `skills.list()` projects the parent execution's sealed Skill catalog, and `skills.call(name, args)` forwards only an available Host-issued alias from that catalog through the Consumer-owned binding, so runtime code cannot submit an import path or observe a directory update mid-attempt. Cells execute serially while admitted child executions may proceed concurrently. Explicit messages and artifact references are the answer channel. The local Provider also implements the versioned Agents View `attach → input → detach` control surface: one live caller owns one lease, controller input is queued through the existing message/continuation pump, and a dead process lease is reclaimable after restart.

The durable root also records its child-model rule. Under `parent-inherit`, an omitted child model always uses the exact current parent selection; an accidental allocator default is rejected. Under `allocator-default`, an omitted model uses only the Scheduler-sealed default child selection. Each child persists its `modelOrigin`, and every child dispatch receives the parent's sealed tools, Skills, retry policy, and capability context. The kernel rejects every `rlm()` option other than `name`, `model`, and `thinking`; explicit selections are forwarded unchanged for Consumer-side catalog validation rather than silently falling back.

State is written atomically below the configured owner-local root. Restart recovery restores independently serializable variables, changes unfinished receipts to `indeterminate`, and requires explicit abandonment instead of replaying an unproven native effect. `compact.run()` only records a receipt-bound Host scheduling decision; the Host must perform native history compaction at a real turn boundary, while the TypeScript namespace remains untouched.

The Provider stores version 6 state in `state.json`, which requires the `messageBatchDispatches` array. Construction reads only version 6 and refuses every other version, a version 6 file without that array, and a batch record that disagrees with the messages, with `RLM_UNAVAILABLE` before it registers the runtime owner; it migrates, repairs, and rewrites nothing, so the refused file keeps its bytes. A Provider that reads only versions up to 5 refuses a version 6 file the same way. Version 5 and earlier state is therefore not opened by this build: replacing an older Provider needs a separate migration decision, and an evaluation uses a new, empty home.

`interrupt(sessionId)` asks every active execution of that session and of every session below it to stop, including executions of deleted children that are still stopping and refused executions that have not ended, and returns when those requests settled, not when the executions stopped. It closes nothing: a later message or due heartbeat admits a new execution. `deleteChild` is permanent. Before its first await it closes the child's subtree and records the command. A closed session admits no message delivery, due heartbeat, spawn, cell, heartbeat creation, or message to or from it, and `trackExecution` interrupts a dispatch that finishes later, refuses it, and keeps it counted until it ends. The closed state (the `deleted` mark on the child, the stopped sessions below it, and the delete command's receipt) is persisted, so a restart keeps the subtree closed. Execution handles, registered or refused, live only in memory and a restart loses them. `deleteChild` then interrupts every active execution below the child. If an interrupt rejects, the command fails with the first rejection: the subtree stays closed, the receipt is `failed`, the same command id returns that failure, and a new delete command interrupts again. Partial interrupts are not rolled back, and the runtime does not prove that an interrupted execution has stopped. `drain` counts executions of deleted descendants that are still running, and refused executions that have not ended, so the root is not reported drained before they stop; messages queued for a deleted session are not counted and are never delivered. A result that arrives for the directly deleted child is ignored (`rlm.child.late_result_ignored`). A descendant admitted under a closed ancestor is not ignored: it can still settle its own record, so a deleted child's subtree can show a descendant as `settled` after the delete. `drain` returns the last continuation result with its own `status`, `stopReason`, and partial `output`; it does not rewrite a failed or indeterminate continuation into a success.

## Model Experience

Indirectly, through a Consumer that exposes the Provider as the `typescript_repl` model tool.

#### KV Cache effect

The Provider does not directly assemble model context. Tool schemas and bounded cell results are Consumer-owned and independent of an already reusable prompt prefix.

## Known Limitations and Deferred Work

- **Not an OS security sandbox** — the TypeScript namespace has owner-daemon operating-system authority; TaskGraph scope/effect admission must run before dispatch.
- **Source-recovery boundary** — declaration-source recovery preserves direct functions/classes/imports and references to other restored top-level bindings. It recreates declaration code, not mutable runtime state such as factory-closure captures or changed class static fields.
- **Running cell in a deleted session** — a delete does not interrupt a cell that is already running in the subtree; its spawn, send, and heartbeat calls are refused, and the cell ends within `maxCellMs`.
- **Resident turns across a restart** — execution handles are in memory, so a Resident turn that outlives a daemon restart is not reconciled and `drain` cannot see it. An accepted interrupt is not proof that the native process stopped.
- **Compatible subset** — native provider tools and Continuous Harness own the remaining Prime end-to-end compatibility rows.
