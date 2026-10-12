# Tool Debate

English | [中文](README.zh.md)

The model-facing Consumer for `ctx.debates`. It registers a bounded `debate` tool for starting, listing, inspecting, and revision-fenced control of persistent Debate runs. `start` is available only in a kennel Session, whose preset is `kennel`; any other Session gets a refusal that points to the kennel, while `list`, `inspect`, and `control` work in every Session. A kennel `start` is the user's explicit request, so the Consumer starts the run and approves it through the Provider's revision-fenced `control` in the same call. Debate never replaces a Session's primary model, and no Session-wide mode or command selects it. Session logs written while Debate was a Session-wide execution mode still load: their `debate/preferences` and `debate/dispatch` events are ignorable and are skipped.

The default policy uses a fixed four-role, native-subscription-first roster: a Codex Sol proposer, Claude Fable falsifier, Codex Sol evidence auditor, and Claude Opus decision judge. The two Claude slots explicitly permit Codex as their fallback operator; the Scheduler keeps each role and persona unchanged, resolves the actual native-subscription model from live capacity, and records the requested and actual operator/model plus the fallback reason. This declaration never authorizes a metered-API route. The decision judge is the Debate moderator and owns the final summary after the participant turns settle. Initial depth is transparent and deterministic: an exact one-round request plans one round, an explicit quick/basic request plans two, an ordinary request plans three, and an explicit deep, system-design, architecture, or multi-constraint request plans four. `concise`, `brief`, and a request for three bullets describe presentation only. Each planned round reserves an upper bound of 100,000 input and 15,000 output tokens for every roster participant, including the moderator; the four-role three-round baseline is 1,200,000 input and 180,000 output tokens. These are ceilings rather than targets. A caller-provided policy, including its monetary cap, passes through unchanged. The `start` result shows the selected plan and reason, and a settled run distinguishes convergence, a round limit, and token or cost exhaustion.

This package depends only on the provider-neutral Debate Service Definition, the agent preset lookup, and ordinary Agent extension points. It does not import the local Provider, TaskGraph daemon, or physical-operator runtime, and it registers no model adapter. Codex and Claude Code run as roster executors through the Provider's TaskGraph.

## Session trace


Each durable public Debate event is also appended as one ignorable `debate/trace` Session fact keyed by `(runId, sourceSequence)`. It carries the topic, round, readable role route, bounded public output, claims, Evidence references, convergence, continuation grant, or synthesis that is available for that event. Running TaskGraph slots additionally project phase, public-output preview, tool start/completion name, approval requirement, and usage as separate trace facts. The model-facing `debate` tool `start`, `control` (including resume and eligible two-round continuation), and `inspect` paths use one idempotent projector when their Session tool-call lineage is available. The Session log never receives a synthetic assistant message, raw prompt, private reasoning, credentials, native command/session identifiers, or native-product transcript through this projection.

## Model Experience

### Bounded `debate` tool

#### What the model sees

The model sees one `debate` tool schema for start, list, inspect, and revision-fenced control, plus the stable Debate policy. A `start` result also exposes the selected automatic initial plan and reason when this Consumer derived the policy. Results expose run state, the public roster, bounded per-round agent output summaries, requested and actual operator/model routing with fallback reasons, Evidence and Artifact references, blockers, and accounting status. Their `currentRound` field counts only persisted rounds whose state is `completed`; planned, running, reviewing, failed, and indeterminate rounds remain visible when a result includes the bounded `rounds` projection but do not increment that count. These summaries are explicit agent outputs, not private reasoning or chain-of-thought.

#### Token effect

The tool schema and policy form a stable prompt prefix. Results remain bounded; large synthesis or Evidence content is returned by reference rather than inlined.

#### KV Cache effect

The stable schema and policy preserve their prefix. Debate events and bounded results append only after tool calls.

## Known Limitations and Deferred Work

- This Consumer requires a `ctx.debates` Provider; the Provider and existing TaskGraph remain the only model-execution and scheduling authorities.
- A started run uses the fixed default roster. Filling the roster from kennel members is not implemented.
- Debate is a bounded execution mode, not a guarantee of higher answer quality; real quality claims require the separate blind evaluation evidence.
