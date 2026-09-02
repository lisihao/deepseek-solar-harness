# Agent Note: Archify v2.16 DSH adapter

Status: implemented

English | [中文](2026-09-02-archify-v2160-dsh-adapter.zh.md)

## Problem

Architecture-oriented agents need a typed diagram capability without adding Archify's renderer, schemas, or file ownership to DSH Core, TaskGraph, or Scheduler.

## Decision

The managed plugin `@deepseek-ai/dsh-archify` vendors the exact Archify `v2.16.0` source at commit `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de` and exposes one model-facing `archify` tool with all five upstream diagram types: architecture, workflow, sequence, dataflow, and lifecycle.

The adapter writes typed JSON inputs to a private temporary directory and starts the pinned CLI through the injected `ctx.subprocess` seam with explicit argv and bounded collected output. It never uses a shell or imports the host `child_process` module; the DSH subprocess service owns cancellation, timeout termination, process-tree cleanup, and execution-world policy.

The plugin records adapter receipts and generated HTML/JSON/upstream compare receipts in a workspace content-addressed store, publishes only named delivery projections, and omits raw prompts and full HTML from session results. Upstream runtime dependencies are declared in the plugin manifest so an installed tarball does not rely on host hoisting.

The plugin skill guides architecture, design, requirements, and review agents to author typed IR, validate it, and deliver only after checking diagnostics and receipt references. Interactive `preview` and `--open` remain outside the model-tool surface; the fidelity matrix records this deliberate boundary.

## Alternatives considered

**Copy the Archify renderer into DSH packages.** This would create a second schema and renderer authority, so the exact pinned runtime remains vendored behind the plugin adapter.

**Spawn Node directly from the adapter.** This would bypass DSH's subprocess execution world and HMR/process-tree lifecycle, so all CLI execution goes through injected `ctx.subprocess`.

**Expose only a simplified architecture subset.** This would not satisfy the upstream contract, so the adapter preserves all five diagrams and the upstream validate, deliver, compare, migrate, inspect, guide, doctor, visual-check, examples, and brands commands that fit the bounded tool surface.

**Expose interactive preview as a model action.** Preview and browser opening require an interactive UI boundary rather than a bounded model result, so they remain an explicit omission with a vendored runtime available to a future UI/CLI consumer.

## Consequences

Archify evolves as an independently pinned managed plugin, and the DSH host retains ownership of process execution, session logging, and orchestration state. The package carries the upstream runtime and its declared dependencies, which increases the tarball size but makes installation reproducible. A future Archify upgrade requires a new source lock and a refreshed fidelity matrix rather than silently changing the v2.16 behavior.

## Verification

The adapter tests execute the exact vendored validator through a real local `ctx.subprocess` provider for one example of each diagram type, verify delivery and compare CAS receipts, reject unsafe paths, assert structured non-zero failure, and assert the implementation has no host `node:child_process` import. `npm run typecheck`, `npm test`, `npm run build`, the vendored `doctor`, and an npm pack dry-run are required before release integration.
