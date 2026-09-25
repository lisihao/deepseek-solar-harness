# @deepseek-ai/dsh-rlm-runtime-local

English | [中文](README.zh.md)

Owner-local Provider for `ctx.rlmRuntime`. It supplies a persistent TypeScript REPL namespace, node-local child registry, family-scoped messaging, command receipts, variable snapshots, goals, and cursor events.

## Runtime behavior

One logical RLM session owns one lexical namespace. The programmable `context` object and independently restorable bindings survive Provider restart; one failed binding remains named as degraded without blocking the others. The kernel discovers top-level declarations with the TypeScript AST, including destructuring and multiple declarations in one statement. Cloneable values restore from their latest V8 value snapshot. Static imports, functions, classes, and direct function-expression bindings that V8 cannot clone restore from their declaration source. A factory-created closure with private captured state is deliberately degraded: this runtime does not pretend that V8 can serialize closures.

Snapshot limits match Prime v0.8 defaults: 16 MiB per binding and 256 MiB for the aggregate programmable state, including `context`. An over-cap or otherwise unrestorable binding is skipped independently while the remaining namespace continues to recover.

`rlm(task, { name })` admits a child through Consumer-provided host bindings and returns a handle before the child result settles. `skills.list()` projects the parent execution's sealed Skill catalog, and `skills.call(name, args)` forwards only an available Host-issued alias from that catalog through the Consumer-owned binding, so runtime code cannot submit an import path or observe a directory update mid-attempt. Cells execute serially while admitted child executions may proceed concurrently. Explicit messages and artifact references are the answer channel. The local Provider also implements the versioned Agents View `attach → input → detach` control surface: one live caller owns one lease, controller input is queued through the existing message/continuation pump, and a dead process lease is reclaimable after restart.

The durable root also records its child-model rule. Under `parent-inherit`, an omitted child model always uses the exact current parent selection; an accidental allocator default is rejected. Under `allocator-default`, an omitted model uses only the Scheduler-sealed default child selection. Each child persists its `modelOrigin`, and every child dispatch receives the parent's sealed tools, Skills, retry policy, and capability context. The kernel rejects every `rlm()` option other than `name`, `model`, and `thinking`; explicit selections are forwarded unchanged for Consumer-side catalog validation rather than silently falling back.

State is written atomically below the configured owner-local root. Restart recovery restores independently serializable variables, changes unfinished receipts to `indeterminate`, and requires explicit abandonment instead of replaying an unproven native effect. `compact.run()` only records a receipt-bound Host scheduling decision; the Host must perform native history compaction at a real turn boundary, while the TypeScript namespace remains untouched.

The Provider stores version 5 state in `state.json`. Construction migrates versions 1 through 4 and atomically rewrites the file before registering the runtime owner. Migrated children carry `modelOrigin: legacy`; a settled child receipt without a result becomes `indeterminate` and is never dispatched again automatically. Keep a private pre-upgrade state copy when replacing an older Provider: rolling back its binary also requires restoring its compatible state file.

## Model Experience

Indirectly, through a Consumer that exposes the Provider as the `typescript_repl` model tool.

#### KV Cache effect

The Provider does not directly assemble model context. Tool schemas and bounded cell results are Consumer-owned and independent of an already reusable prompt prefix.

## Known Limitations and Deferred Work

- **Not an OS security sandbox** — the TypeScript namespace has owner-daemon operating-system authority; TaskGraph scope/effect admission must run before dispatch.
- **Source-recovery boundary** — declaration-source recovery preserves direct functions/classes/imports and references to other restored top-level bindings. It recreates declaration code, not mutable runtime state such as factory-closure captures or changed class static fields.
- **Compatible subset** — native provider tools and Continuous Harness own the remaining Prime end-to-end compatibility rows.
