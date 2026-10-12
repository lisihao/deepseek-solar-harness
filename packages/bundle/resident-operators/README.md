# @deepseek-ai/dsh-resident-operators

English | [中文](README.zh.md)

Opt-in bundle that exposes stable `codex` and `claude-code` physical operators with backward-compatible ephemeral execution plus explicit resident execution. Every path uses the user's native product subscription, and the bundle contains no API-key fallback.

Add the prebuilt package to a profile, include the bundle in `dsh.profile.bundles`, and inspect the effective composition with `dsh --profile <name> --dump-config`. Removing the bundle removes the tool, router, and Resident client without deleting daemon state or native product sessions.

## Composition

The patch mounts the physical-operator Service Definition, Resident Service Definition, local Resident Provider, existing Codex and Claude Code subagent Providers, the mode-aware router, the single model Consumer, and the SQLite-backed `modelCatalogs` service. The router depends on definitions, not implementation internals; the Consumer depends only on the physical definition. One explicit refresh collects DeepSeek's `GET /models`, fresh Codex metadata, Claude Code's explicit `supportedModels` inventory, and the enabled Web picker once; ordinary reads use persisted snapshots and UI panels reuse that cached path. Full inventories and source statuses persist: removed entries become unavailable, while a failed refresh remains unknown and is excluded from the menu. The menu exposes up to two available entries per DeepSeek, Codex, and Web under the latest flagship/mainline policy (DeepSeek Pro/Flash, Codex Astra/latest Sol, Web Pro/Thinking), with upstream-ordered fallback; Claude's refreshed inventory is stored for provider use but is not a main-menu source. This policy is not benchmark ranking and does not install or release provider software. The patch also mounts `@deepseek-ai/dsh-model-allocation-local`, which Smart Collaboration asks for the collaborator, model, and effort of each delegated request.

The default execution mode remains `ephemeral`. Resident mode is workspace-scoped. Bundle/HMR disposal disconnects clients but does not stop the independent daemon; disabling the bundle restores the existing one-shot paths and leaves SQLite, artifacts, and native product sessions intact.

## Model Experience

Indirectly, through one `physical_operator` tool. A fresh Session uses Smart Auto routing, so the main Agent can choose a suitable operator and explicitly request resident continuation without requiring the user to name the product. The low-level run request still defaults to ephemeral when `mode` is omitted, preserving third-party compatibility.

#### KV Cache effect

Enabling the bundle adds the physical-operator tool schema to the deployment prompt.

## Known Limitations and Deferred Work

- The bundle is opt-in and does not alter the default DSH profile.
- RLM and Continuous Harness are orchestration strategies in the separate TaskGraph bundle; neither is a physical operator.
- There is no writable human takeover, affinity scheduler, durable Jobs projection, or remote operator farm.
