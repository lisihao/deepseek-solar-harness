# `@deepseek-ai/dsh-base`

English | [中文](README.zh.md)

The shared dsh core as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts every base plugin row — model adapters, the shared [`agent-default-model`](../../core/agent-default-model/README.md) selection, tools, persistence, policy, settings/credentials, telemetry, and host-level subagent providers — over the empty profile root, as the first layer of every profile's `dsh.profile.bundles` list. Codex and Claude Code providers load dormant; Agent Presets independently decide whether their agent contributes either model-facing delegation tool. Later bundle layers (e.g. [`dsh-web-app`](../web-app/README.md)) and the user's profile `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`, so mode-specific values live in mode bundles, not here. The package has no runtime API; the profile composer resolves the patch through the `dsh.bundle.patch` manifest field, never through code.

The patch carries the supported POSIX shell stack: `bash-sandbox` and `tool-bash` are the default executor and tool rows, with the Linux/macOS sandbox policy supplied by `sandbox` and `sandbox-policy`. The permission switcher and approval service run unchanged, and `fs-sandbox` keeps fencing `ctx.fs` writes — mounting `dsh-fs-local` alongside it would double-register `ctx.fs` and fail the load. Platform-specific compatibility packages remain source-only and are not inserted into the default profile.

The row set and its rationale are documented inline in the patch file; the [generated composition graph](../../../apps/cli/composition.md) renders it.

## Model Experience

Indirectly, through the inserted rows: this bundle selects the shipped persona-less prompt base, tool set, and DeepSeek adapter that mode bundles specialize, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
- **Claude's SDK platform CLI remains in the Profile install closure** — the base bundle depends on the Claude provider, whose production path resolves the host `claude`; removing the SDK's unused optional payload is deferred to the product installation-closure follow-up.
