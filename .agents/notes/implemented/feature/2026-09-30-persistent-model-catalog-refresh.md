# Agent Note: Persistent model catalog refresh and shortlist policy

Status: implemented

English | [中文](2026-09-30-persistent-model-catalog-refresh.zh.md)

## Problem

Provider-visible models came from separate caches and live lookups. Rendering a menu could rediscover a provider, stale state could look available, and a compact shortlist could be mistaken for benchmark ranking. The product also needs full inventories for settings and delegation while keeping ordinary reads deterministic.

## Decision

`@deepseek-ai/dsh-model-catalog-local` exposes `ctx.modelCatalogs` backed by SQLite. Registered sources cover DeepSeek's explicit `GET /models`, Codex's fresh short-lived native metadata, Claude Code's explicit `supportedModels` call, and the enabled ChatGPT Web picker. A central refresh invokes each active source once; ordinary list/read calls return persisted snapshots, and UI panels use the cached result unless an explicit refresh is requested. Each source persists its full inventory and status. A successful refresh marks models absent from the new snapshot unavailable; a failed refresh preserves stored model facts as unknown and keeps that source out of the menu.

The main menu selects at most two available entries from each menu-visible DeepSeek, Codex, and Web source: the latest upstream-ordered flagship and mainline families (DeepSeek Pro/Flash, Codex Astra/latest Sol, Web Pro/Thinking), then upstream-ordered fallback. Claude's refreshed inventory is stored for provider use and delegation, not as a main-menu source. This is family and presentation policy, not benchmark ranking. Reasoning controls come from exact native model metadata or model-scoped Web picker options; the catalog does not claim one universal Web reasoning scale. Refresh does not release, install, or update provider software.

The Web latest-model row represents multiple underlying models selected by the native intensity slider. Discovery groups the observed opaque slider options by model, records their exact per-model efforts, and ranks those groups from the strongest observed slider endpoint. It retains older explicit model rows in the full inventory. Composite routes bind the exact native row and observed model family; execution verifies both the row and the requested same-model effort before submitting text. Discovery restores the prior model and effort, and rejects incomplete observation or restoration. New slider models use this observation path without a bundled model-name list. An explicit main-menu reasoning choice remains authoritative over auxiliary Web controls.

## Alternatives considered

**Discover on every read.** Rejected because ordinary rendering would depend on credentials, network access, and provider availability.

**Persist only the menu shortlist.** Rejected because settings and delegation need the complete provider inventory and source status.

**Turn a failed refresh into an empty or unavailable catalog.** Rejected because a failed observation is unknown, while a successful refresh that omits a model is evidence that the model is unavailable.

**Rank entries by benchmark score.** Rejected because the menu policy follows provider families and upstream order; it makes no cross-provider quality claim.

**Install or release a provider during refresh.** Rejected because catalog observation does not own provider software lifecycle.

## Consequences

Menus stay compact while provider panels and delegation retain the full observed inventory. An explicit refresh can require live account or browser state, but ordinary reads remain local and cached; a source that cannot refresh is visible as unknown and contributes no menu entries. Provider publication order and family names can move the shortlist without implying a quality comparison, and reasoning controls remain provider-specific.
