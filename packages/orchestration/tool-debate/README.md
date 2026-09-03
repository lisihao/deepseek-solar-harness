# Tool Debate

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.debates`. It registers a bounded `debate` tool for starting, listing, inspecting, and revision-fenced control of persistent Debate runs. A separate `/debate-mode auto|enabled|disabled` command stores the whole per-Session preference as an ignorable event; legacy Sessions default to `disabled`. Explicit `enabled` is also a host-level execution choice and approval: the next direct user message receives a durable `debate/dispatch`, starts and revision-fenced approves the Debate Provider without a preliminary primary-model call, then streams the public roster, each durably settled agent turn, round convergence, and the final moderator summary as one assistant response. `auto` remains a model policy rather than unconditional admission and retains the Provider's ordinary approval state.

The default policy uses a fixed four-role, native-subscription-first roster: a Codex Sol proposer, Claude Fable falsifier, Codex Sol evidence auditor, and Claude Opus decision judge. The two Claude slots explicitly permit Codex as their fallback operator; the Scheduler keeps each role and persona unchanged, resolves the actual native-subscription model from live capacity, and records the requested and actual operator/model plus the fallback reason. This declaration never authorizes a metered-API route. The decision judge is the Debate moderator and owns the final summary after the participant turns settle. Runs stop on evidence-backed convergence or after three rounds, preserve material dissent, and return artifact references plus bounded projections rather than large reports. An explicit concise/brief request selects a deterministic compact policy: one round with the proposer, falsifier, and judge, capped at 80,000 total tokens and USD 2 of reported cost.

This package depends only on the provider-neutral Debate Service Definition and ordinary Agent/LLM extension points. It does not import the local Provider, TaskGraph daemon, or physical-operator runtime. The physical-operator host router independently yields when the durable Session preference says Debate is enabled, so Codex and Claude Code remain roster executors instead of replacing the Debate run. The internal `dsh-debate-host/debate` route is not advertised as a primary chat model. A legacy Session that already selected that internal route is admitted by writing the same durable `debate/dispatch` before its request, so it remains usable while new selections go through the collaboration execution-mechanism control.

## BBS-style transcript

The host response is presented as a readable forum thread rather than a diagnostic dump:

- A topic post opens the thread with the public topic recorded by the Debate Run and its lifecycle state. Legacy Runs without a recorded topic are explicitly labelled as missing their topic instead of borrowing text from another Session message.
- The participant roster is grouped once in a Markdown table with the readable role, mandate, requested or actual operator and model, and current state. It does not expose slot identifiers, internal role identifiers, hashes, or raw HTML.
- Every round gets one heading and every terminal participant turn receives a stable global floor number. First-round posts are independent; later posts identify the claim-ledger phase, while claim text is labelled only as a claim submitted by that turn because the v1 protocol does not record reply targets.
- Only durable `outputPreview` values are emitted as public speech, preserving headings, priority labels, and list structure. A blocked, failed, or indeterminate turn explicitly says that no public output was produced; the Consumer never invents a missing response.
- Convergence, unresolved claims, preserved dissent, and the moderator's final synthesis remain visible. A budget or round limit says that the moderator is synthesizing until the final summary has settled, then says that the summary is complete. The decision judge is represented by this single pinned moderator post instead of a duplicated ordinary floor; a judge failure remains an explicit moderator status.
- Planned and dispatched lifecycle snapshots never create duplicate floors. Exact blocker copies use attempt, node, code, and message identity; different failures with the same code remain visible.

Each durable public Debate event is also appended as one ignorable `debate/trace` Session fact keyed by `(runId, sourceSequence)`. It carries the topic, round, readable role route, bounded public output, claims, Evidence references, convergence, or synthesis that is available for that event. The Session log never receives a synthetic assistant message, raw prompt, private reasoning, credentials, or native-product transcript through this projection.

## Model Experience

### Bounded `debate` tool

#### What the model sees

The model sees one `debate` tool schema for start, list, inspect, and revision-fenced control, plus the stable Debate policy. Results expose run state, the public roster, bounded per-round agent output summaries, requested and actual operator/model routing with fallback reasons, Evidence and Artifact references, blockers, and accounting status. The host transcript labels actual routing on every turn and distinguishes a blocked, never-dispatched slot from an execution failure. These summaries are explicit agent outputs, not private reasoning or chain-of-thought.

#### Token effect

The tool schema and policy form a stable prompt prefix. Results remain bounded; large synthesis or Evidence content is returned by reference rather than inlined.

#### KV Cache effect

The stable schema and policy preserve their prefix. Debate events and bounded results append only after tool calls.

## Known Limitations and Deferred Work

- This Consumer requires a `ctx.debates` Provider; its host adapter admits the run but the Provider and existing TaskGraph remain the only model-execution and scheduling authorities.
- Legacy Sessions default to `disabled`; enabling or selecting `auto` is an explicit per-Session preference.
- Debate is a bounded execution mode, not a guarantee of higher answer quality; real quality claims require the separate blind evaluation evidence.
