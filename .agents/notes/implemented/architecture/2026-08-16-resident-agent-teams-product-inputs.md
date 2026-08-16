# Agent Note: Resident and anchored AgentTeams product inputs

Status: implemented

English | [中文](2026-08-16-resident-agent-teams-product-inputs.zh.md)

## Problem

Resident Physical Operators existed in an unpublished DSH feature branch, while the AgentTeams persona fix and the Anchored Standard delegated-agent gate lived in two other source trees. A Desktop package built only from the published DSH `0.1.0-rc.6` family therefore omitted Resident execution and could start team workers with a promoted tool catalog instead of the selected preset's controlled first turn.

## Decision

Desktop carries a narrow set of content-addressed, prebuilt product inputs. Seven Resident/physical-operator tarballs come from one recorded DSH commit, one AgentTeams tarball comes from its recorded commit, and the patched Anchored Standard directory is copied byte-for-byte from its source tree. `vendor/manifest.json` owns the SHA-256 inventory and `verify-vendored-inputs.mjs` rejects missing, added, or changed inputs.

The launcher composes Resident and AgentTeams as product overlays without persisting them into a selected user profile. Existing profile bundles are not duplicated. The physical Consumer projects a logged per-Session `auto | direct | codex | claude-code` routing policy, with `auto` as the untouched value. Desktop contributes an additive selector beside model selection and persists changes through `/operator`; it does not present execution products as primary LLM routes. The underlying run contract still defaults an omitted mode to ephemeral, while Smart Auto tells the main Agent to prefer resident execution for repository, multi-turn, and restart-continuous work. On macOS, owner-only private wrappers expose the user's native Claude Code and Codex commands to the packaged daemon; no API credential is forwarded and no API fallback exists. Electron's `ELECTRON_RUN_AS_NODE` marker is scoped to the daemon bootstrap and removed before either product driver launches a child.

The packaged Anchored Standard root precedes the published preset root at system trust. Both promotion gates use `includeSubagents: true`, so a delegated worker with no durable event is unpromoted and receives only `bash` plus `str_replace_editor` on request one. AgentTeams is finalized with `memberPersonaPlacement: prompt`, preserving the selected preset persona while placing the member protocol in the first user message.

## Verification

The full workspace check builds all faces, typechecks, runs the Desktop suite, verifies the sealed vendor inventory and proves runtime closure. Packaging checks require the Resident, AgentTeams, native-product runtime, and Anchored Standard files inside `app.asar.unpacked`. The packaged composition smoke loads the real Electron artifact and proves exactly one Resident row, one dual-mode router, one AgentTeams row with prompt placement, and an unpromoted delegated Anchored Standard first turn.

The packaged Resident smoke starts the daemon through the application executable, verifies the actual process chain, and qualifies Claude Code and Codex as `native-subscription`. Explicit no-tool turns through both providers return unique nonces and native session IDs. These smokes use an isolated short DSH home, forward no API key, shut the daemon down, and remove their temporary state.

## Consequences

Desktop can ship the feature before the relevant packages have a public DSH release, but each change to a sealed input requires an intentional manifest and lockfile update. Smart Auto is proactive model policy, not a deterministic classifier or separate scheduling authority; queueing, affinity, cost optimization, and multi-operator DAG routing remain deferred. The product layer shadows a stale user copy of the same Anchored Standard id without deleting user data. Resident release acceptance is macOS-only for this milestone; unsupported or changed native products fail loud while ordinary ephemeral execution stays available. Mac mini deployment is outside this change and must later pull a formal GitHub release remotely.
