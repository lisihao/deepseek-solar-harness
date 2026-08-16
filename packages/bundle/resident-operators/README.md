# @deepseek-ai/dsh-resident-operators

English | [中文](README.zh.md)

Opt-in bundle that exposes stable `codex` and `claude-code` physical operators with backward-compatible ephemeral execution and explicit resident execution. Both paths use the user's native product subscription; the bundle contains no API-key fallback.

Add the prebuilt package to a profile, include the bundle in `dsh.profile.bundles`, and inspect the effective composition with `dsh --profile <name> --dump-config`. Removing the bundle removes the tool, router, and Resident client without deleting daemon state or native product sessions.

## Composition

The patch mounts the physical-operator Service Definition, Resident Service Definition, local Resident Provider, existing Codex and Claude Code subagent Providers, the dual-mode router, and the single model Consumer. The local Provider depends only on the Resident definition; the router depends on definitions, not implementation internals; the Consumer depends only on the physical definition.

The default execution mode remains `ephemeral`. Resident mode is explicit and workspace-scoped. Bundle/HMR disposal disconnects clients but does not stop the independent daemon; disabling the bundle restores the existing one-shot paths and leaves SQLite, artifacts, and native product sessions intact.

## Model Experience

Indirectly, through one `physical_operator` tool. A fresh Session uses Smart Auto routing, so the main Agent can choose a suitable operator and explicitly request resident continuation without requiring the user to name the product. The low-level run request still defaults to ephemeral when `mode` is omitted, preserving third-party compatibility.

#### KV Cache effect

Enabling the bundle adds the physical-operator tool schema to the deployment prompt.

## Known Limitations and Deferred Work

- The bundle is opt-in and does not alter the default DSH profile.
- Protocol version 1 has no writable human takeover, affinity scheduler, durable Jobs projection, or remote operator farm.
