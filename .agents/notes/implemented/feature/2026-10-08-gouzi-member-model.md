# Agent Note: A pinned model per Gouzi

Status: implemented

English | [中文](2026-10-08-gouzi-member-model.zh.md)

## Problem

Every kennel task named only the member's operators, so the Scheduler's Smart Auto picked the model each time and a user could not make one dog run on a particular model. A member holds a Codex and a Claude Code runtime whose catalogs offer different model ids, so any setting must also say which runtime runs the task.

## Decision

A [member](../../../../packages/orchestration/orchestration/src/gouzi.ts) carries an optional `model`: one native product model id from a runtime catalog. Absent means Smart Auto chooses, as before. The id selects the runtime too, because only the operator whose catalog lists it can run the task, so the setting needs no per-runtime map.

The [registry](../../../../packages/orchestration/orchestration-local/README.md) stores it in a nullable `gouzi_members.model` column added by state schema 6. Create and `gouzi.edit` accept a trimmed id of 1 to 128 printable characters, and `edit` clears it with `null`. An edit that omits `model` keeps it, and a model change does not bump the role version or the member generation.

The [dispatcher](../../../../packages/orchestration/ui-gouzi/README.md) offers a pinned member only through the available operators whose catalog carries the model, and a member left with none is not a candidate. The candidate carries the model, the task node gets `operator.profile.model`, and the pre-start recheck refuses to run when the member's model changed or an operator stopped offering it after the decision.

The edit form lists the models of the member's available runtimes through the `models` action, requested when the form opens because the roster poll must not query runtime catalogs. A pinned model that no runtime offers stays selectable and is marked unavailable. Adoption does not set a model, because a new member has no runtime catalog to choose from until it has started.

## Alternatives considered

**A model per runtime.** A map keyed by Codex and Claude Code would let one dog hold two models, but the node carries one profile and the model id already determines the runtime, so the map would add a state that can contradict itself.

**Keep the choice in the Desktop catalog.** The dispatcher and the registry already own member identity and generation. A second store would let a model survive a re-created member that never agreed to it.

**Add the column without a schema version.** An additive nullable column opens in an older program, but that program would then write members without the setting. Released state requires an explicit versioned failure, so schema 6 makes an older program refuse the database.

## Consequences

The schema 6 migration is one-way, as schema 5 was. A pinned model that a runtime retires makes the dog silently ineligible for dispatch until the user changes the setting, and the room shows no candidate for it. The pin applies to kennel dispatch; tasks that a user routes to a dog's operators through other paths keep Smart Auto. Installed-product behavior across a real Codex or Claude Code catalog has not been exercised here, and no deployment is implied.
