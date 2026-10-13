# Agent Note: Switch models and effort inside one DSH session, and keep the initial context small

Status: proposed

English | [中文](2026-10-13-same-session-model-switching-and-context-reuse.zh.md)

## Problem

A user wants to stay in one DSH session, change the model or reasoning effort when the work changes, and have every model understand what happened while another one was active, without paying for the same prompt text again on every request. An audit of installed 3.41.0 and a design review of the 3.42.1 source found three gaps.

- **A native lane locks its first profile.** A Resident Codex or Claude session is locked to the model and effort of its first accepted command. A different explicit choice is refused with `EXECUTION_PROFILE_CONFLICT` (`packages/physical-operator/resident-operator-local/src/store.ts:628-647`). `session.reset` clears the lock but also clears the native thread link, so it is not a switch. The routed path now reuses a locked profile instead of failing ([profile reuse](../../implemented/feature/2026-08-16-resident-execution-profiles.md)), but an explicit choice of another native model still conflicts.
- **Returning to a native thread skips the conversation in between.** A resumed native thread receives the current task, the runtime context and the task templates. The operator context envelope states that prior user, assistant and tool history never enters it (`packages/core/system-prompt/src/envelope.ts:80-93`). If the requirement changed in a DeepSeek turn, the native thread does not hear about it.
- **The initial request is large.** The audited session carried about 197,000 characters of system prompt, about 163,500 of them generated tool SDK, and a skill catalog of about 395,000 characters. These are characters, not tokens. The skill catalog is an appended `user/message` with `source.kind = 'skill-catalog'`, and a changed catalog is appended again, so older ones stay in the history until compaction (`packages/skill/tool-skill/src/index.ts`).

What already works, and must stay unchanged:

- An ordinary API model or effort change applies at the next step. The selection is not a session event: it is the in-memory `picked` value of the Host (`packages/host/apiproxy/src/api-proxy.ts`, `selectionFor`), read once at the start of each step before `system-prompt/assemble` (`packages/core/agent/src/model-selection.ts:85`). A step that has already started is unaffected, and `request/header` is appended only when the configuration changes (`packages/core/agent-loop/src/agent.ts:464-470`).
- Cache reuse is observable: the audited Flash turn read 94.35% of its input from the cache. That does not reduce the text in the request or the context it occupies, and the first request after switching to Pro had zero cache hits. The comparison was not controlled, so the cause is not established.

Guarantee scope: what DSH has recorded (user messages, applicable instructions, corrections, task state, results). Tool steps inside a native product that DSH never received are outside it, and every handoff states that gap. Different providers do not share a KV cache, and no design here assumes they do.

## Proposal

### 1. Ordinary API models: no new state

Keep the current behavior. The user's choice applies at the next step and the commit point is the existing `request/header`. Add only presentation: the model menu distinguishes **selected** from **in effect** (they differ until the next step starts), and each reply shows the configuration that actually served it. A message already records provider and model in its `source`; for an API reply the effort exists only in the `request/header` before it, so the UI derives it from there and the log does not change. A native reply carries the router as its source and the router's configuration in that header; the model and effort it actually ran with are in the `residentProfile` of its `physical-operator/dispatch`, and the UI reads them there.

Known limit: `picked` lives in Host memory (`selectionFor` reads `picked`, else the last `request/header`, else the default). A selection made after the last step and before the next one is lost if the Host restarts in between, and the menu then shows the previous value. The window ends when the next step starts.

The earlier proposal of persisted requested, waiting, preparing and committed states is not adopted for this path. The selection is already deferred to a step boundary, so the states would only cover the restart window above, and a durable pending-selection event would add a log vocabulary for it. The `llm-fallbacks` plugin dropped its logged switch events for the same reason. The cost of not logging is that window.

### 2. Native models: one lane per configuration

The Resident store keys a session by `(operator, workspace, lane)` (`store.ts:352`) and locks the profile per row. The lane id is `residentLaneId ?? parent.id` (`packages/physical-operator/physical-operator-resident/src/index.ts:206`), and the routed path passes none. A configuration change therefore needs a different lane, not a different lock rule.

- The first lane of an existing session keeps `laneId = parent.id`, so no stored session is migrated or reset. A different profile uses `<parent.id>~<profileKey>`, where `profileKey` is a normalized short key of model and effort. The explicit tool path keeps `explicit-tool:<id>` with the same suffix.
- `physical-operator/dispatch` (`packages/physical-operator/tool-physical-operator/src/index.ts:105-118`) gains an optional `laneId`. It is a durable host decision, so the lane is fixed before the command is sent and a recovery reuses it. `residentLaneProfile` (`:1569`) becomes a table from lane to its last accepted profile, read from these events.
- Selection rule: an explicitly named native model uses the lane whose profile matches, or creates one. With no explicit choice the most recent lane is used, which keeps the profile reuse that already shipped.
- A `dispatch` without `laneId` (every log written before this change) means lane `parent.id`. The explicit tool path records `physical-operator/tool-dispatch`, not `dispatch`, and passes no profile today; phase 1 does not cover it, so its lane stays `explicit-tool:<id>` with the profile it first used.
- `commandId` is `resident-` plus a hash of agent id and message id (`:1644`). It does not depend on the lane, and the daemon hashes the lane into its request hash. A retry of an unaccepted dispatch therefore must reuse the recorded lane, never pick another one under the same command id.
- Mutual exclusion: at most one lane of a DSH session has an unfinished dispatch (`recoverableDispatch`, `:1796`). The daemon's busy check is per lane, so this cross-lane guard is new. An unknown result stays unknown: the existing indeterminate rule applies and nothing is replayed on another lane.

No change to the Resident store: state schema 6 and protocol 14 stay, so there is no one-way migration and no rollback boundary. Old lanes stay for inspection and for a switch back.

In-thread switching (changing model or effort on the same native thread) is not in the first phase. The wire accepts `model` and `effort` on `turn/start` (`packages/subagent/subagent-codex/src/wire.ts`), but nobody has verified that Codex or Claude honor it on a resumed thread, and there is no capability descriptor for it. It stays a later option behind a real qualification test.

### 3. The handoff is a derived context in the existing envelope

The handoff reuses `OperatorContextEnvelopeV1`: exact `systemText`, `task`, named `contexts`, a `source` with durable provenance, a `digest`, and accepted or rejected receipts (`envelope.ts:84-130`). The complete envelope is already appended to the session as `physical-operator/context-envelope` (`index.ts:868`, `:1030`). The handoff is one more named context in `contexts`. It is a derived view with source references, not raw history, so the envelope's rule that prior history never enters it still holds, and the envelope version stays 1 because a new context name is not a structural change.

- **Rebuilt from a frozen interval.** The dispatch records the interval of raw session events (`handoff`: `afterSeq`, `beforeSeq`, `maxChars`) before the command is sent. The text is a function of the raw events inside that interval only, not of the current surface or of the configuration, so a recovery after a crash or a compaction rebuilds the same text and the same envelope digest.
- **Confirmed position, no new store.** A lane's confirmed position is derived from the log: the last dispatch of that lane whose result was delivered to the session (the delivery check in `recoverableDispatch`). `dispatch-terminal` is a failure marker, not a success marker, and must not be used as one. The handoff carries what happened after that position.
- **Content, in priority order.** The latest checkpoint (a compaction summary) for a lane that has never run. The user's own words, then the replies of other models, since the lane's confirmed position. Tool results, skill catalogs, runtime context and plugin messages are not part of it. A gap above `handoffMaxChars` keeps the newest messages and says how many earlier ones were left out; failing the dispatch instead would lock the lane out for good, because its confirmed position only moves after a delivered reply.
- **Trust levels are kept.** The user's own words keep their authority and are marked as such; assistant replies, summaries and tool or file content are quoted material, never promoted to an instruction.
- **A lane used for the first time** gets the checkpoint, a recent window and the required constraints.
- **Acknowledgement** comes from the envelope receipt of the adapter, never from the model saying it has read the text. When acknowledgement is unclear the lane is reconciled before anything is sent.

The builder is a private module of `tool-physical-operator`, which already owns routing and the envelope. A shared service waits for a second independent consumer.

### 4. Initial context size: measure first

The code limits what can be done:

- `tools:sdk` is regenerated on every assembly from all visible tools (`packages/core/tools/src/index.ts`, section `tools:sdk`). Visibility is set per scope, not per step.
- A different system text or tool set produces a new `request/header` (`agent.ts:466-469`) and breaks the prefix. Changing the tool set on every step would trade tokens for cache misses.
- Surface replace needs a contiguous range with source provenance (`packages/core/session/src/surface.ts`). Skill catalog messages are not contiguous, so replace cannot simply be applied to them.
- There is a four-characters-per-token estimate (`packages/llm/token-meter/src/estimate.ts`) and compaction thresholds (0.8 and 0.16 of the window), but no exact tokenizer and no hard request budget.

Phase 2 therefore starts by freezing a baseline on a fixed task set: measured tokens per section (base instructions, tool SDK, skill catalog, memory, conversation, tool results). Candidates, to be chosen from the measurement: a session-stable bridge with a discovery tool instead of a per-step tool set; a compact skill index with bodies loaded on demand (the skill tool already loads bodies); moving the catalog out of the persistent history. Stable content stays first and dynamic content after it; time is already a trailing per-step `user/message` (`packages/context/time-context`). Budgets become deployment configuration, with estimated and measured values labeled apart.

The first target is a median reduction of at least 50% in tokens for base instructions plus catalog plus SDK on the fixed set, with the needed capabilities still discoverable. It is a target, not an achieved result.

### 5. Usage and evidence

Show per-message input, cache read, output and whether the metering is complete. DeepSeek reports no cache write (`packages/llm/llm-deepseek/src/translate.ts`), so it is shown as not available, never as zero. Summaries, tool discovery, failed switches and retries count toward cost. Claims about speed, cost or quality come only from paired runs of the same task, with fixed-model and staged-switch arms, cold and warm cache recorded apart. Ten pairs is a pilot and supports only sample-level statements. Without a stable improvement the result is reported as "efficiency not shown" and the default strategy stays.

## Alternatives considered

**Persist requested and committed selection events.** The selection is already applied at a step boundary and logged by `request/header`. A new event type needs a catalog entry and a compatibility decision, and its only reader would be the restart window described in section 1. Not logging accepts that loss.

**Relax the Resident profile lock and switch inside the thread.** It needs a changed lock, a store migration, and an unverified native behavior. It also gives no way back to the previous profile's thread.

**Add a generation counter for execution authority.** The lane id and the order of dispatch events already say which lane acts, and the daemon's lease and receipts already serialize a lane. A second counter would be a second source of truth.

**Replay the whole conversation into the native thread.** It repeats history the thread may already hold, and it ignores compaction. The delta since the lane's confirmed position is smaller and has the same meaning.

**Reset the lane and start over.** It loses the native thread link and still needs a handoff.

**A shared memory service for handoffs.** There is one consumer today.

## Acceptance criteria

Phase 1, switching:

- A session that ran Codex Sol with low effort, then DeepSeek, then Codex Astra with medium effort, returns no `EXECUTION_PROFILE_CONFLICT`. The second Codex configuration runs on its own lane and the first lane is kept.
- Codex A, then DeepSeek changing the requirement to B, then Codex "continue": the native turn works to B and the artifact confirms it, and an action that was already completed is not repeated.
- A switch back to a lane uses that lane's confirmed position and sends only what came after it.
- A dispatch with an unknown result is reconciled with its original command id and the recorded lane. No second business command is sent and no other lane is used.
- Two lanes of one session never run at once.
- A handoff that does not fit keeps the newest messages and says how many it left out; it never fails the dispatch. A tool result that contains instructions stays quoted material after summarization.
- A test first proves whether the envelope digest is stable on resume. If it is not, the request hash conflicts on replay and the design changes before any code is written.
- A real Loader composition with keyless snapshots covers the paths above, plus one small real-provider qualification of the native parameter.

Phase 2, context size: baseline measured and frozen; the chosen method keeps a stable prefix; tool discovery coverage tests pass; a request over the hard budget is refused with the offending section named.

Phase 3, evidence: per-message usage shown with missing values marked; the paired comparison reports success, total usage, time and omissions together.

Documentation: README, JSDoc and an implemented Agent Note accompany each phase. The new optional `laneId` and the new context name are additive and need the session-log compatibility check from the [log version mechanism](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md).

## Risks

- Rolling back to 3.42.x keeps the data intact but loses the feature: the older program ignores `laneId`, reads the profile of the newest dispatch (a new lane's) and sends it to the `parent.id` lane, which brings `EXECUTION_PROFILE_CONFLICT` back.
- The handoff reaches the native thread as a text block of runtime context, so the weight of a user correction can be lower than in a normal user message. Receipt of the text does not prove it was followed; the acceptance cases check the result.
- The envelope digest or request hash may change on resume, which would make a replay conflict. The first test answers it.
- Each configuration costs a cold native thread, so switching back and forth is not free. The cost is shown, and the user's explicit choice is never downgraded to save it.
- A lane per configuration can leave many idle native threads. A retention rule is needed once usage data exists.
- Handoff text can still leave out something the native thread needed. The coverage field states what was omitted, and the acceptance cases above are the check.
- Phase 2 may find that the largest cost is not where this note assumes. The note keeps the method open until the baseline exists.
