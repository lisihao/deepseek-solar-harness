# Tool Debate

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.debates`. It registers a bounded `debate` tool for starting, listing, inspecting, and revision-fenced control of persistent Debate runs. A separate `/debate-mode auto|enabled|disabled` command stores the whole per-Session preference as an ignorable event; legacy Sessions default to `disabled`. Explicit `enabled` is also a host-level execution choice and approval: the next direct user message receives a durable `debate/dispatch`, starts and revision-fenced approves the Debate Provider without a preliminary primary-model call, then streams the public roster, each durably settled agent turn, round convergence, and the final moderator summary as one assistant response. `auto` remains a model policy rather than unconditional admission and retains the Provider's ordinary approval state.

The default policy uses a fixed four-role, native-subscription-first roster: a Codex Sol proposer, Claude Fable falsifier, Codex Sol evidence auditor, and Claude Opus decision judge. The decision judge is the Debate moderator and owns the final summary after the participant turns settle. Runs stop on evidence-backed convergence or after three rounds, preserve material dissent, and return artifact references plus bounded projections rather than large reports. An explicit concise/brief request selects a deterministic compact policy: one round with the proposer, falsifier, and judge, capped at 80,000 total tokens and USD 2 of reported cost.

This package depends only on the provider-neutral Debate Service Definition and ordinary Agent/LLM extension points. It does not import the local Provider, TaskGraph daemon, or physical-operator runtime. The physical-operator host router independently yields when the durable Session preference says Debate is enabled, so Codex and Claude Code remain roster executors instead of replacing the Debate run. The internal `dsh-debate-host/debate` route is not advertised as a primary chat model. A legacy Session that already selected that internal route is admitted by writing the same durable `debate/dispatch` before its request, so it remains usable while new selections go through the collaboration execution-mechanism control.

## Model Experience

### Bounded `debate` tool

#### What the model sees

The model sees one `debate` tool schema for start, list, inspect, and revision-fenced control, plus the stable Debate policy. Results expose run state, the public roster, bounded per-round agent output summaries, Evidence and Artifact references, blockers, and accounting status. These summaries are explicit agent outputs, not private reasoning or chain-of-thought.

#### Token effect

The tool schema and policy form a stable prompt prefix. Results remain bounded; large synthesis or Evidence content is returned by reference rather than inlined.

#### KV Cache effect

The stable schema and policy preserve their prefix. Debate events and bounded results append only after tool calls.

## Known Limitations and Deferred Work

- This Consumer requires a `ctx.debates` Provider; its host adapter admits the run but the Provider and existing TaskGraph remain the only model-execution and scheduling authorities.
- Legacy Sessions default to `disabled`; enabling or selecting `auto` is an explicit per-Session preference.
- Debate is a bounded execution mode, not a guarantee of higher answer quality; real quality claims require the separate blind evaluation evidence.
