# Agent Note: Smart Collaboration allocation

Status: implemented

English | [中文](2026-09-26-smart-collaboration-allocation.zh.md)

## Problem

With an API main model, Smart Collaboration delegated recognized work through a text classifier: implementation-shaped requests went to Codex and analysis-shaped requests to Claude Code, with the saved native profile or the product default model and effort. It ignored quota, capacity, and model tier, and could not move work to the other product when one was unavailable. The quota-aware allocator already chose models for TaskGraph nodes, but it ran only inside the orchestration daemon. After the [product model-menu entries](2026-09-26-four-entry-model-menu.md) change, the remaining native models are meant to be chosen per task by that kind of allocator.

## Decision

The resident-operators bundle mounts `@deepseek-ai/dsh-model-allocation-local` in the Host. When Smart Collaboration delegates and the allocator is mounted, `tool-physical-operator` asks it for the collaborator. The classifier still decides whether to delegate and supplies the role (`implementation` or `analysis`); the allocator's domain scoring turns that role into a Codex or Claude Code preference.

Offers are every native model of the available Codex and Claude Code catalogs that accept the DSH tool bridge, except proxied `openrouter/…` models. Offer tiers come from `nativeModelTier`, now shared from `@deepseek-ai/dsh-model-allocation` with the orchestration daemon. Claude Code reports no quota telemetry, so these offers admit unknown quota. Each offer carries the new optional `rank`, the menu's newest-first order, which breaks score ties before the offer id; without it the allocator preferred alphabetically earlier ids, so an older model could beat a newer one. The request uses phase `execution` and objective `quality`, since the delegated work is the user's whole request.

Catalogs are qualified again only when the last read, including an explicit menu refresh, is older than `catalogMaxAgeMs` (default ten minutes); concurrent stale reads share one qualification. The chosen model and its catalog default effort become the Resident profile, and the routing decision's reason names the offer, the effort, and the allocator rationale. A missing allocator, a failed catalog read, or no qualified offer falls back to the classifier's operator, with the cause in the reason.

## Alternatives considered

**Read live catalogs on every delegation.** Quota would always be current, but each delegation would wait for every native CLI to be qualified.

**Use only the catalogs of the last manual refresh.** This adds no latency, but quota can be arbitrarily stale.

**Admit Claude Code only when pinned.** This is the TaskGraph rule for unknown quota. It protects the Claude allowance but would send analysis-shaped requests to Codex, which the owner rejected.

**Offer only the menu's newest models.** Ranking the full catalog keeps older and faster models available to later objective and effort rules.

## Consequences

- Smart Collaboration now picks the newest high-tier model of the matching product and moves to the other product when a catalog is unavailable or its quota is exhausted.
- Claude Code usage is not protected by a quota reserve during automatic delegation.
- Every delegation still uses the chosen model's catalog default effort; task-complexity, retry, and reasoning-effort rules remain proposals.
- A pinned collaborator, an explicit operator request, and a physical main model keep their previous routing.
