# Agent Note: Product model-menu entries

Status: implemented

English | [中文](2026-09-26-four-entry-model-menu.zh.md)

## Problem

The Desktop model menu listed about 37 rows: three DeepSeek models, one row per physical operator, and one row per native model in each refreshed Codex (20) and Claude Code (11) catalog. The owner drives work from a few of them. The remaining models are meant to be chosen per task during orchestration by cost, quality, reasoning effort, and task features, not picked by hand. Native menu rows existed only in memory, so after a restart they reappeared only after an explicit refresh. The collaboration panel's basic page also offered five routing preferences plus primary-owned native profiles, and the allocator rated GPT-6-Astra, Codex's frontier model, as medium tier because its name matched no tier rule.

## Decision

The Solar product offers five entries: DeepSeek-V4-Pro, DeepSeek-V4-Flash, Codex's two strongest newest native models, and ChatGPT Web.

`tool-physical-operator` gains optional `Config` fields. Leaving them unset keeps the previous menu.
- `entryOperatorIds` lists the operators offered as their own entries.
- `latestModelEntries` offers an operator through its newest native models. Proxied ids that name another provider (`openrouter/…`) are skipped. The generation parsed from the id orders the rest, newest first, and the catalog's own order is kept within one generation. An older generation fills a short newest one. The first selected model is shown on the bare operator entry, and a bare selection pins that model with the menu's effort or the catalog default. The others are `operator:model` entries.
- `stateRoot` retains refreshed catalogs in `native-catalogs.json`. A refresh that finds a catalog unavailable keeps that operator's last successful models.
- A plain menu read returns the retained entries at once. When the last native catalog read is older than `catalogMaxAgeMs` (ten minutes), it starts one in the background, so a later read shows a product's upgraded models without an explicit refresh. A background read that a newer refresh overtakes is discarded.

The resident-operators bundle, which Desktop and the Product Server both load, sets `entryOperatorIds: [chatgpt-web]`, Codex with `count: 2`, and `stateRoot: $DSH_HOME/physical-operator`. It also narrows `llm-deepseek.models` to V4-Pro and V4-Flash, V4-Pro first, and sets the new `discoverModels: false`, so a refresh neither calls `GET /models` nor adds endpoint ids. The product default model stays the bare `codex` entry, which now runs the newest flagship.

The collaboration panel's basic page offers Smart Collaboration and Current Model Only. The Codex, Claude Code, and ChatGPT Web preferences move to the advanced page as a pinned collaborator, together with the pinned native model and effort. A Codex primary takes its model and effort from its menu entry, so it has no primary-owned profile. The allocator's tier rule adds `astra` and treats a catalog description containing "frontier" as high and "fast" or "affordable" as low.

## Alternatives considered

**Hard-code the two Codex model ids.** This needs a product change for every Codex release. Ranking the live catalog lets a background read or a refresh move the entries.

**Refresh the catalog only on explicit request.** The first version did this. A fresh install then showed a bare `Codex` entry, and a Codex upgrade stayed invisible until the owner clicked refresh.

**Stable slot ids such as `codex:@latest-2`.** Every session on the second entry would silently change models at refresh. With an explicit `codex:<model>` id, a session keeps the model it chose; only the bare flagship entry follows the newest model, as the Codex default already did.

**Keep endpoint discovery on for DeepSeek.** A refresh would re-add every `/models` id to the menu, which defeats the two chosen DeepSeek entries.

**Hide native models only in the client.** The Host directory would still advertise them, and every other consumer of the directory would disagree with the menu.

## Consequences

- Existing sessions on a model that is no longer offered keep routing to it. The menu shows `Select model` for them, and a bare `codex` session now runs the flagship instead of a saved Codex profile.
- Claude Code and the non-entry Codex models remain registered, so delegation and TaskGraph allocation still use them.
- A fresh install lists a bare `Codex` entry until the first background read, which the first menu read starts, records the catalog.
- A stale menu read qualifies the native products, which starts their CLIs, at most once per `catalogMaxAgeMs`.

## Deferred

[Smart Collaboration allocation](2026-09-26-smart-collaboration-allocation.md) now chooses the collaborator and model of a delegated request. Task-feature matching, reasoning-effort selection, and per-turn DeepSeek effort remain proposals from the same design.
