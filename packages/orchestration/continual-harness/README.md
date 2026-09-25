# @deepseek-ai/dsh-continual-harness

English | [中文](README.zh.md)

Provider-neutral Continuous Harness seam. It snapshots bounded entries for a TaskGraph node and manages versioned prompt addenda, memories, TypeScript skills, and subagent definitions. It is not another Scheduler, model provider, or transcript store.

Managed entries use optimistic concurrency in session-local, workspace, or user-global scope. Read operations with no explicit scope resolve an overlay in `session` → normalized `workspace` → user-global order; a narrower entry id shadows the same id at a broader scope, while an explicit scope remains exact. Writes with no explicit scope remain session-local. The global scope has one stable identity under the owner's DSH home, so the same entry is visible across repositories without being copied into either workspace. Refinement planning does not mutate the active harness; apply runs at a declared turn boundary, reports each edit independently, and records only successful edits for explicit rollback. The immutable base prompt cannot be changed.

The Scheduler consumes only immutable snapshots and records bounded Evidence references after settlement.

Executable TypeScript skills use a second plugin registry in this same capability package. A trusted Provider registers a versioned module and explicit callable names; a managed Harness entry exposes only a safe alias and argument contract to the RLM. The model never supplies a package path, and an unavailable Provider fails instead of interpreting the entry as executable text.

## Model Experience

None, as this seam contributes no model-visible content directly.

#### KV Cache effect

Only the bounded Continuous Harness entries sealed into a node can change its request prefix.

## Known Limitations and Deferred Work

- Snapshots are fixed for one sealed node attempt; a later harness generation applies only to a later attempt.
- Mid-turn mutation and cross-machine synchronization are deferred.
- The base bundle provides the registry and invocation boundary, not a production skill catalog; Skill Providers remain separately installable plugins.
