# Agent Note: Native Jev decisions and engineering collaboration in DSH

Status: proposed

English | [中文](2026-10-01-jev-engineering-native-decisions.zh.md)

## Problem

Codex Jev Engineering (the private Codex plugin source, version 0.2.1 when read) gives a coordinating model bounded semantic judgment: pick one of several candidate files, filter a large log, pick a tool, and ask a read-only architect for review. It works only because Codex calls it. DSH has no equivalent, and installing the plugin's MCP server beside DSH would leave the model to remember to call it, create a second task state, and let a Codex-shaped gateway govern DSH actions.

The earlier proposal ([configurable decision-driven harness](https://github.com/lisihao/deepseek-solar-harness/blob/d663978325/.agents/notes/proposed/architecture/2026-09-24-configurable-decision-driven-harness.md), commit `d663978325` on `codex/jev-engineering-design`, never merged into `solar`) describes the full target. It predates the scheduling-evidence work now in `solar` and treats several runtime facts as open. This note replaces it as the design owner: it keeps its obligations, fixes the baseline at `solar` `117ec4ee37` (3.29.0), and splits delivery so that a native core (P1–P3) can be accepted without claiming the full context, tool-disclosure, and cache target (P4–P6).

Reading `solar` at that baseline found these gaps that the design depends on. Each needs a counterexample test in P0 before the matching phase starts.

- **File reads are not sandbox-checked.** `tool-fs` `read` resolves through `resolveRegularReadTarget` and `ctx.fs.resolve`; the sandbox plugin checks only write and edit. The only generic check on a read is the `tools` registry pre-execute and guard path. A decision-driven reader must enforce its allowed roots in the operation itself.
- **A rejected `agent/pre-step` drops the claimed input.** `Agent.preStep` claims the inbox before `system-prompt/assemble` and `agent/pre-step` run, and a rejection ends the turn as blocked without re-queueing. A consumer that waits for a judgment must return the original messages on failure, timeout, or abstention, never reject.
- **Completion is `stopReason === 'completed'`.** The TaskGraph daemon marks a node passed from the operator stop reason. Acceptance kinds are `operator-completed`, `artifact-present`, and `human-review`; no verification receipt matches a declared check to a command, exit code, and artifact.
- **`approvalRef` binds nothing.** It is a caller string or `approval:<uuid>`, checked for presence and copied into the sealed plan.
- **A Resident reviewer is not read-only.** A node with read scopes only gets `nativeToolPolicy: inherit`; only the Codex `dsh-tools-authoritative` policy seals `nativeEffects: 'read-only'`. In-process child agents get tool filtering and a guard through `tools.restrict`, while out-of-process providers declare `toolFilter: false`.
- **No review record exists.** No session or orchestration event records a review, its executor, or its input digest, so deduplication has nothing to key on.
- **Role routing can collide with the adaptive policy.** `adaptiveExecutionPreference` still prefers Luna and Terra for text that looks like coding execution; an explicit pin (`preferredOperatorIds` plus `preferredModel`) is applied first, so engineering roles must resolve to explicit allocator constraints.
- **The allocator already receives public evidence.** `ModelAllocationRequest.evidence`, `ctx.schedulingEvidence.evidenceFor`, and `publicEvidence: off | shadow | apply` exist; the Smart Collaboration path calls them and the TaskGraph `selectOperator` does not.

## Proposal

**One rule for every judgment.** Deterministic code decides known cases. A Decision service asks a judgment provider only when several legal candidates remain ambiguous. The consumer that owns the action re-checks permission, scope, budget, and freshness, then applies or discards the answer. A provider never reads files, runs tools, or changes task state, and it cannot override a user-pinned model, the quota floor, or an approval.

**Ownership stays where it is.** Radar and AI Frontier supply evidence, OpenSquilla estimates demand, `modelAllocation` owns the model choice, and the Scheduler owns execution. Jev adds bounded semantic suggestions after the allocator's hard gates and comparable-evidence ranking cannot decide, never as a second ranking pass after the allocator has sealed a plan.

```text
user goal / mode / pinned model
   → DSH session, TaskGraph, permissions, cancellation (unchanged)
   → Decision service: resolve → decide
        0 candidates → no-eligible
        1 candidate  → deterministic pass-through (no provider call)
        2+ ambiguous → configured provider
   → typed answer or abstention, never an action
   → consumer re-checks dependency, permission, budget, freshness
        ├ restricted read → ContextPacket / projection artifact
        ├ role offer → modelAllocation → sealed plan
        ├ review request → existing Scheduler work
        └ full phase: context, schema, and prefix plan
   → existing Native Agent / Resident / Web execution
   → real result, acceptance record, whether the decision was applied
```

**Packages.** `packages/decision/decision` (service definition and pure functions), `packages/decision/decision-jev` (provider over the vendored `jev-use` transport), `packages/decision/engineering` (consumers and review). Split further only when a role evolves independently. Names are provisional until P1.

**Decision service.** Purposes are `file.select`, `context.filter`, `tool.select`, `role.offer`, `next.ready`, `retry.advise`, and `stop.advise`. Results carry one status of `selected`, `no-eligible`, `abstained`, `unavailable`, `timeout`, `cancelled`, `invalid`, `stale`, or `policy-denied`, plus origin (`deterministic`, `provider`, or `cache`), usage, input digest, and fallback reason. `cancelled` is terminal: no escalation or retry follows it, and a late answer is recorded as not applied. Unknown, duplicate, or missing answers, non-finite numbers, malformed distributions, and a provider identity that differs from the configured deployment return `invalid` or `policy-denied`, never a default pick. Confidence kinds (category label, self-reported score, native distribution, calibrated estimate) are distinct, and a threshold is configured per purpose and provider. Initial evaluation values inherited from the plugin are a 3 s timeout, 8 KiB compact state, 8 questions per batch, 12 candidates per question, confidence 0.8, margin 0.2, and a 5-minute decision cache; each is a `Config` field recorded in the receipt, not a product default.

**Configuration and user control.** The `engineering-decisions` Settings namespace adds Jev interfaces and switches without code changes. The listing below is the intended schema, not runnable configuration today.

```yaml
engineering-decisions:
  enabled: false
  providers:
    local-judgment:
      adapter: jev-use-typesafe
      endpoint: http://127.0.0.1:PORT
      expectedModel: PINNED_DEPLOYMENT_MODEL
      credentialRef: decision/local
      residency: trusted-private
      enabled: true
  purposes:
    file.select: { mode: shadow, providers: [local-judgment] }
    context.filter: { mode: shadow, providers: [local-judgment] }
    tool.select: { mode: off }
    role.offer: { mode: off }
    next.ready: { mode: off }
    retry.advise: { mode: off }
    stop.advise: { mode: off }
  fallback:
    externalProviders: []
    onUncertainty: current-qualified-coordinator
```

- **Adding a Jev interface is a configuration edit.** Each entry under `providers` is one interface with its own endpoint, pinned model, `credentialRef` (Settings holds the reference, never the secret), `residency` (`local-device`, `trusted-private`, or `external`), and `enabled`. A purpose lists the provider ids it may use, in fallback order. Duplicate ids, an unknown provider or purpose, a missing credential reference, and an `external` provider that is not allowed by `fallback.externalProviders` fail at load. A redirect, a changed deployment identity, or a loopback address that is not the configured residency blocks application.
- **The user turns it on and off at three levels:** the namespace `enabled`, each provider's `enabled`, and each purpose's `mode` (`off`, `shadow`, `active`). The default is everything off, and off means no provider call, no decision record, and behavior identical to a build without the plugin. A change applies to the next decision without a restart through the Settings watcher; decisions already requested finish or cancel under their original configuration. Shadow mode still spends resources and may send content to the provider, so it needs the same residency authorization as active mode.
- **The settings page** shows enabled state, provider type and deployment identity, data residency, per-purpose mode, calibration status, budgets, role rules, fallback rules, and the last health check. A health check sends synthetic content only, and credentials show as configured or missing.
- **Session and task views** show one of: deterministic direct choice, Jev applied, shadow only, abstained, stale, awaiting review, each linked to the real read, execution, and test evidence.

**Consumers (P2).** Restricted file read: build legal path candidates with file identity first; one candidate reads directly; several candidates go through the Decision service, and the selected exact file is read through the DSH file service and the registry guard, then its bytes are hashed against the candidate identity. A mismatch returns `stale`. A file the agent may not read is never sent to the provider to decide. Log and search filtering: input is an approved immutable text artifact; stable line ranges index the original; mandatory instructions, unresolved user requests, current failures, acceptance output, and call/result pairs are pinned by code, not by a keyword list. On abstention, timeout, or invalid output the original artifact stays chunk-readable and the report counts retained bytes, bytes read, candidates, re-reads, and the bytes that finally reach the request. Tool selection chooses among registered read-only tools (the `dev_tool_search` unlock path and its logged `toolNames` stay), never generates shell arguments, and rechecks permission and fingerprint at call time. Native Agent wiring handles persisted tool results and retrieval material only; it does not wait for a judgment between the destructive inbox claim and the persisted input.

**Roles and review (P3).** Roles are coordinator, explorer, worker, researcher, and architect. A role resolves to an exact `operator/provider/model/effort` through the existing allocator as explicit constraints, and the conflicting `adaptiveExecutionPreference` is disabled for that request. Editable presets may follow the current Codex arrangement, but they never override a model the user chose. A sealed attempt keeps its identity across catalog refresh; only a safe handoff point replans. The role matrix is filtered by capability: ChatGPT Web has no local write tools, so it is offered planning, research, and read-only review only, and a reviewer without an enforceable read-only limit is not reported as an independent review. Review work is durable Scheduler work keyed by parent run, node, attempt, review kind, and dependency fingerprint; the executor role comes from the sealed plan, not a caller-supplied `actorRole`. The parent seals a review snapshot at a safe point and yields its slot so `maxParallel=1` completes; cancelling a pending review prevents dispatch. A review is valid only when its executor id, model and effort, input hash, and output hash match, and the coordinator records adopt-or-reject with a reason for each finding. Required-but-not-dispatched is a pending state, never a second reviewer.

**Acceptance before automation.** `stop.advise` and `retry.advise` stay advisory and never write a task as accepted until a deterministic acceptance checker matches each declared check to the actual command, exit code, and artifact in an immutable verification receipt (P4). Side-effecting operations whose result is unknown are reconciled against the original execution receipt, not replayed on a Jev suggestion.

**Records and caches.** Facts reuse session events, TaskGraph events, and the artifact store: `decision/requested`, `decision/resolved`, `decision/applied`, plus review and context events named by the event rules. Each applied record carries parent session, run, node, attempt, input and instruction digests, catalog and tool-registry revisions, policy, configuration, provider, and calibration revisions, the origin, chosen and rejected reasons, and the id of the real read or execution. Model-visible judgment input and filtered output are reconstructable from persisted bytes, not from hashes. A new required-on-read session event follows the session-format version rules; it is never marked `ignorable` to avoid a migration. Three caches are accounted separately: decision results, retrieval or representation artifacts, and provider prefix/KV. A cache key includes scope, purpose, normalized ordered candidates, input digest, policy and instruction revisions, actual model identity, and calibration revision; a read hit still re-checks current permission and artifact hash. `SpillRef` carries no content hash today, so immutable projections use the artifact store or a new hash field decided in P2.

**Execution paths.** Native Agent through `ctx.llm` gets bounded observation, selection, role suggestion, and recorded judgment first, and is the only path where full context rebuilding and cache targets can be controlled. Codex and Claude Code Resident operators get sealed tasks, exact model and effort, input packages, read-only reviewers, and receipts only to the extent the adapter exposes the limit. ChatGPT Web follows the capability rule above. All three share one parent task and one Scheduler.

**Full phase (P4–P6)** is kept as binding obligations, not implied by the core: an addressable chunk store over events and artifacts, hide/short/long/full representations with independently generated summaries, a per-attempt reconstructable context plan, durable inbox reserve/commit/return/revoke, tiered tool disclosure, prefix/KV strategy with measured provider cache usage, joint model/context/prefix routing, resolved no-generation actions through the existing tool runtime, and shared read-only background observation. It may need agent-loop and inbox changes; `agent/request` changes call configuration only, so P4 first proves whether the existing extension points suffice, and one owner holds context generation so compaction and the context plan never trim history independently.

**Source reuse.** Nothing is copied without a license check. `jev-use` 0.8.0 is declared MIT (upstream snapshot `541c86caabf1eeb0af929256649d460f2708cb42`, npm shasum `fc74e00faacccce122a1b98f8e90ed7e26562394`); the Codex plugin project itself has no LICENSE file, so its own files are reference and behavior-case sources to be rewritten against DSH interfaces, unless the owner confirms the terms. A public source manifest (upstream address, pinned version, relative path, SHA-256, license, original tests, behavior differences) is a P0 output and must exclude user settings, authorization receipts, conversations, work logs, and absolute local paths.

| Source file (SHA-256 at read time) | Treatment | DSH destination |
|---|---|---|
| `src/provider.mjs` (`6a345700…22ec`) and `vendor/jev-use-0.8.0.tgz` (`553128c9…4a67`) | Reuse transport and validation approach | `decision-jev`; use existing credentials, child-request cancellation, configuration, telemetry; do not hand-write a second network client |
| `src/decisions.mjs` (`245097fb…3ea1`) | Extract normalization, strict answer checks, confidence filtering, fingerprints, conservative-filter tests | `decision` pure functions; drop user-directory and host-state coupling |
| `src/readonly-tools.mjs` (`0b4973c7…3e9d`) | Port candidate application and tests | restricted-read consumer over DSH `fs` and tools; keep single-candidate zero-call and post-read hash check |
| `src/workflow.mjs` (`e1d6b4c6…3aa9`) | Keep trigger and dedup cases, not the JSON fact store | review records and Scheduler binding in DSH events |
| `src/gateway.mjs` (`f0e536d9…b07c`) | Source-only prototype reference | action identity, exact args and cwd, one-time claim, and unknown-result reconciliation move into the existing lifecycle; no second gateway state machine |
| `src/gateway-hook.mjs`, `hooks/*`, `src/install.mjs`, Codex TOML management | Not brought into the DSH runtime | use Cordis and the tool runtime; never edit a user's Codex or Claude Code configuration to imitate DSH capability |
| `test/*.test.mjs` | Reuse behavior cases as DSH Vitest and real-Loader tests | real services, Loader, events, and restart scenarios replace host mocks |

The source tree was still changing while this note was written: the plugin version read as 0.2.1, `gateway.mjs` differs from the installed 0.2.0 copy, and `provider`, `decisions`, `readonly-tools`, and `workflow` matched the installed copy byte for byte. P0 re-freezes the hashes before any extraction.

**Phases.**

| Phase | Scope | Exit condition |
|---|---|---|
| P0 | Source manifest and hashes; gap matrix with counterexample tests; this note | Implementation baseline frozen against current `solar`; every gap above confirmed or refuted by a test; replay fixtures |
| P1 | `decision`, `decision-jev`; configuration and credentials; protocol tests | Off makes zero calls; single candidate passes through; strict output and real identity checks; cancel, timeout, budget, and residency tests |
| P2 | Restricted-read and filtering consumers; projection artifacts; minimal checker | One real-Loader example reduces actual reading or context; pinned evidence survives; files that changed are refused; full text stays chunk-readable |
| P3 | Role resolution; durable review; UI; physical-operator adapters | Real worker and reviewer dispatch; identity and read-only limit; dedup; recovery at the three crash windows; explicit model lock wins |
| P4 | Native context and inbox lifecycle; schema disclosure; request rebuilder; deterministic acceptance checker | Per-attempt rebuild; cancel does not lose input; permissions not weakened; resolved actions leave real receipts |
| P5 | Evidence and cache joint optimization | Comparable evidence changes legal choices as designed; incomparable data abstains; measured cache usage |
| P6 | Product enablement and examples | Support matrix, enable/disable/fallback, reproducible evidence |

P1–P3 is named "DSH Jev Engineering native core". It is not the full Jev Engineering until P4–P6 are accepted against the full-phase obligations. Parallel work is limited to files that cannot conflict (the provider protocol tests and an empty-state UI, for example); schema, generated catalogs, seal dependencies, Git, and release are integrated serially by the coordinator. The P3 review dispatch and the P4 acceptance checker both change `orchestration-local/src/daemon.ts` and run in sequence. TaskGraph `selectOperator` is wired to the same allocator and the same evidence snapshot reference, never a second ranker.

**Benefit evaluation.** Three whole tasks (locating a failure in a large log, multi-file navigation, a bounded code change) are run against baseline, shadow, and active with fixed source, task, acceptance tests, and allowed tools, in interleaved order, with cold and warm cache separated. The sample size, the quality floor, and the allowed latency and cost regression are fixed before the first result is read. Reports list judgment calls and latency, foreground and child generation usage, re-reads after filtering, summaries, reviews, waits, retries, completion time, rework, and required-evidence recall; subscription quota and local compute stay separate and are never converted to dollars. A purpose becomes `active` only after its A-series correctness scenarios pass, quality does not regress against the predeclared floor, no required evidence or permission is lost, and a whole-task net gain is shown; otherwise it stays `off` or `shadow`.

**Rollback.** A purpose can be turned off first, which stops new judgments and keeps all history. A change to required model-visible events, SQLite, or inbox semantics follows the repository schema and session-version rules, with a recoverable snapshot per phase and a measured migration edge. Delivery reports list separately what was extracted, adapted, tested, wired into real execution, enabled, merged, installed, and shown to have a benefit, with source and remote SHAs, commands and exit codes, and uncovered items.

## Alternatives considered

**Install the Codex plugin's MCP server beside DSH.** It would work today, but it relies on the model remembering to call it, keeps a second task and approval state, and matches Codex tool names such as `Bash` and `spawn_agent`. Rejected: stable triggering has to come from program wiring.

**Copy the plugin's JSON state machine and Hooks.** Fast, but it creates a second control plane for actions and reviews that DSH's Scheduler and tool runtime already own. Rejected; behavior cases and pure algorithms are reused instead.

**A separate ranker for Jev-based model choice.** It would give modelAllocation, Radar evidence, and Jev three opinions about the same model. Rejected: Jev only adds a bounded suggestion inside the allocator's ordering, after hard gates and comparable evidence.

**Trust a confidence number to auto-approve.** A structured JSON answer with a high score is not a calibrated probability. Rejected; thresholds are per purpose and provider, calibration is separate evidence, and acceptance comes only from the deterministic checker.

**Ship one switch for "smart collaboration".** One toggle hides which capability is active and where content goes. Rejected for three levels (namespace, provider, purpose) with a visible mode.

**Build the full context and cache architecture first.** It carries the most risk (agent-loop and inbox changes) and delays any user-visible result. Rejected; the native core ships first and the full obligations stay binding.

## Acceptance criteria

The matrix below is the product acceptance for the phases listed; document review and source reading do not satisfy any row. A24 requires a keyless snapshot from a real runnable example in each phase that changes user-visible behavior. Real provider protocol tests use synthetic data; a paid or subscription call needs current authorization, and a missing credential is recorded as uncovered, not replaced by a mock.

| ID | Scenario and assertion | Phase |
|---|---|---|
| A01 | With the feature off, provider call count is 0 and the original task runs normally | P1 |
| A02 | 0 candidates return `no-eligible`; 1 legal candidate passes through deterministically with 0 Jev calls | P1/P2 |
| A03 | A multi-candidate decision changes the file or range actually read; unselected files are not fully read by the same consumer first | P2 |
| A04 | Unknown candidates, missing or repeated answers, malformed JSON, non-finite numbers, and wrong distributions are not applied | P1 |
| A05 | Timeout, low confidence, or identity mismatch while the task is active returns an explicit fallback; cancel stops with 0 further escalation calls and a late result does not overwrite newer state | P1/P2 |
| A06 | `local-device` and `trusted-private` requests never silently go to a cloud provider; `off`, `shadow`, and `active` are distinguishable | P1/P6 |
| A07 | A change to hash, instruction, policy, catalog, or scope invalidates caches and plans; a cache hit does not call the provider again | P1/P2 |
| A08 | Chinese assertions, decisive evidence without an error keyword, mandatory instructions, and user requests are not dropped | P2 |
| A09 | UTF-8, empty files, trailing newline, non-contiguous ranges, and an over-budget pinned region all give explicit output with a replayable source; cancel during a P2 wait loses no unconsumed input | P2 |
| A10 | The original-text fallback stays fully retrievable; downstream budgeting cannot silently remove a pin | P2 |
| A11 | A user-pinned model is not overridden by Jev, a role preset, or a second allocator pass; unsupported combinations are refused with an explanation before the run | P3/P6 |
| A12 | After a catalog refresh a new model can join the next legal allocation while a sealed attempt keeps its identity | P3 |
| A13 | Conflicting file scopes, full capacity, and insufficient shared quota wait or fail correctly without model polling | P3 |
| A14 | A reviewer has a real execution id, a read-only limit, and input and output hashes; a forged role, `agentId`, or cross-task file is invalid | P3 |
| A15 | A pending review is not dispatched twice; a repeated error event does not increment the count; the same valid fingerprint is not reviewed again; `maxParallel=1` does not deadlock; cancelling a pending review prevents dispatch | P3 |
| A16 | The three restart windows reconcile correctly; an old attempt or a post-cancel late receipt cannot revive a task | P3/P4 |
| A17a | When Jev returns every favorable answer, an action without approval still cannot run, and a Jev stop suggestion does not change task completion | P3 |
| A17b | The deterministic checker matches each real check; a missing required test or artifact is not accepted; `operator-completed` does not substitute | P4 |
| A18 | A request manifest is recorded per attempt and an independent rebuilder compares messages, system prompt, schema, model, and effort | P4 |
| A19 | Steering, cancel, or restart during a judgment loses no input and repeats no tool effect; an unknown effect is reconciled first | P4 |
| A20 | Only resolved, legal, recorded actions bypass a generation request; arbitrary shell text gets no authorization | P4 |
| A21 | A provider without KV shows `unsupported`; with KV, measured cache usage is compared, not self-reported hits | P5 |
| A22 | Comparable same-cohort evidence changes the choice as designed; incomparable, stale, conflicting, or small-sample evidence abstains | P5 |
| A23 | Native, Resident, and Web are each tested on their declared paths; a combination without capability is refused in UI and API alike | P3/P6 |
| A24 | A real-Loader keyless snapshot shows refresh or read, judgment, apply, execution, and evidence end to end | every user-visible phase |
| A25 | Disabling or rolling back keeps history readable and the ordinary DSH path; a configuration problem does not block unrelated disabled capabilities | P6 |
| A26 | Adding a provider entry in configuration makes it selectable for the listed purposes with no code change; a duplicate id, unknown provider or purpose, missing credential reference, or disallowed `external` provider fails at load | P1/P6 |
| A27 | Turning the namespace, a provider, or a purpose off yields 0 provider requests, 0 decision records, and behavior identical to a disabled build; the change takes effect on the next decision without a restart and does not alter a decision already requested | P1/P6 |

P0 also confirms, with tests, whether the current scheduler's approval binding, actual acceptance, and cross-run scope admission meet P3 and P4. Where they do not, the shortfall becomes an explicit prerequisite slice; a bare `approvalRef` string, operator completion, an in-process lock, or a job id is not treated as the corresponding guarantee.

## Risks

- **License.** The Codex plugin project has no LICENSE file. Until the owner confirms the terms, only behavior cases and algorithms are reused, rewritten rather than copied.
- **Moving source.** The plugin source changed during this work (0.1.2 in the request, 0.2.1 when read, 0.2.0 installed). A hash recorded here describes only the file at read time.
- **Missing start document.** The request names `CLAUDE_START.md`, `evidence.json`, and `REVIEW-before-plan.md`; the design worktree contains none of them, so this note does not cite their contents. P0 locates them or records them as not reviewed.
- **Residency.** A loopback endpoint can tunnel to another machine, and shadow mode still sends content. Residency is configured and checked at application time, not inferred from the address.
- **Cost of judgment.** A judgment call can cost more than it saves on small tasks. The single-candidate fast path and the net-gain requirement before `active` guard this; a purpose with no measured gain stays off.
- **Review cost.** Reviews on every state update would consume the benefit. Triggers are limited to large plans, repeated same-class errors at the policy threshold, and long-task completion, deduplicated by fingerprint and unique error event.
- **Resident limits.** The Codex and Claude Code adapters expose only some model, input, and tool limits. A capability without a proven enforcement stays inactive, and the matrix hides combinations that cannot hold.
- **Not validated.** This note was reviewed against source but ran no DSH functional test, Jev model call, or performance experiment. Every A-series row and the benefit evaluation are unverified until implemented.
