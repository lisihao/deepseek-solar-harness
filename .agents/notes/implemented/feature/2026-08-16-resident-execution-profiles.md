# Agent Note: Lock native execution profiles to Resident Sessions

Status: implemented

English | [中文](2026-08-16-resident-execution-profiles.zh.md)

## Problem

Resident Claude Code and Codex turns inherited each product's machine-local default model and reasoning setting. DSH could neither show the effective choice nor preserve it as part of the durable Session contract, so a resumed Session could change behavior after a user configuration edit or product default change. A single hard-coded catalog would become stale and would misrepresent subscription-specific availability.

## Decision

The physical-operator request carries an optional provider-neutral model and reasoning-effort preference. The Resident daemon reads the live model catalog from the qualified native subscription product, validates explicit fields, resolves omitted fields through a transparent task-class policy, and stores the complete effective profile on the operator-plus-realpath-workspace Session before product execution. Every later turn reuses that profile. A different profile fails with `EXECUTION_PROFILE_CONFLICT` until an optimistic idle reset clears the native association and profile.

Claude Code discovery uses the Agent SDK control channel without submitting a model prompt. Codex discovery uses app-server `model/list`. Claude execution passes SDK `model`, `effort`, and adaptive thinking when the selected model advertises it. Codex execution passes `model` on thread start/resume and `model` plus `effort` on every `turn/start`. Both remain native-subscription-only and retain the existing version and protocol qualification checks.

The model/effort preference is an ignorable DSH Session event and a browser projection. Host dispatch copies the folded preference into its durable dispatch record, so reconnect uses the exact admitted request. The daemon records only the resolved profile, source (`smart-auto`, `mixed`, or `manual`), and canonical request hash; prompts and native transcripts remain outside the profile store.

## Catalog and automatic selection

Provider status includes the native product's current model rows, supported effort values, default effort, resolved model alias when available, and adaptive-thinking support. Smart Auto classifies only the current in-memory prompt as quick, standard, complex, or extreme. It selects product-advertised fast, balanced, or frontier rows by their stable ids and descriptions, then selects the nearest supported effort. Manual model or effort fields override only their named dimension; every resolved value still passes the live catalog check.

## Alternatives considered

**Inherit each CLI's configuration forever** — rejected because DSH cannot display or durably reproduce the effective execution profile, and resume semantics change when machine-local defaults drift.

**Ship a static Claude and Codex model list** — rejected because product versions, subscription entitlements, aliases, and supported effort levels change independently of DSH.

**Make model and effort part of the Session identity** — rejected because it would create parallel native Sessions for one operator/workspace and weaken the existing continuity contract. An explicit reset is a visible boundary for changing the profile.

**Let every turn silently change profile** — rejected because native context continuity would no longer imply stable execution behavior, and a retry could execute under a different model from its accepted receipt.

## Consequences

Desktop and other trusted clients can display live choices and the daemon-confirmed effective profile. Smart Auto remains useful without requiring product names or model ids in ordinary prompts, while manual preferences stay durable and reconnect-safe. Qualification now performs a bounded native catalog control request, and profile changes require an explicit reset that starts a new native association while preserving prior product history and artifacts. SQLite schema v2 migrates schema v1 additively; existing Sessions acquire a profile on their next admitted turn.
