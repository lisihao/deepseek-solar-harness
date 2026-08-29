# Tool Debate

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.debates`. It registers a bounded `debate` tool for starting, listing, inspecting, and revision-fenced control of persistent Debate runs. A separate `/debate-mode auto|enabled|disabled` command stores the whole per-Session preference as an ignorable event; legacy Sessions default to `disabled`.

The default policy uses a fixed four-role, native-subscription-first roster: a Codex Sol proposer, Claude Fable falsifier, Codex Sol evidence auditor, and Claude Opus decision judge. Runs stop on evidence-backed convergence or after three rounds, preserve material dissent, and return artifact references plus bounded projections rather than large reports.

This package depends only on the provider-neutral Debate Service Definition. It does not import the local Provider, TaskGraph daemon, or physical-operator runtime.

## Model Experience

### Bounded `debate` tool

#### What the model sees

The model sees one `debate` tool schema for start, list, inspect, and revision-fenced control, plus the stable Debate policy. Results expose run state, bounded role/round projections, Evidence and Artifact references, blockers, and accounting status.

#### Token effect

The tool schema and policy form a stable prompt prefix. Results remain bounded; large synthesis or Evidence content is returned by reference rather than inlined.

#### KV Cache effect

The stable schema and policy preserve their prefix. Debate events and bounded results append only after tool calls.

## Known Limitations and Deferred Work

- This Consumer requires a `ctx.debates` Provider and does not execute models itself.
- Legacy Sessions default to `disabled`; enabling or selecting `auto` is an explicit per-Session preference.
- Debate is a bounded execution mode, not a guarantee of higher answer quality; real quality claims require the separate blind evaluation evidence.
