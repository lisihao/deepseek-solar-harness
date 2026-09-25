# Agent Note: DSH Desktop 3.14.0 collaboration observability checkpoint

Status: proposed

English | [中文](2026-09-04-dsh-desktop-3-14-0-collaboration-observability.zh.md)

## Problem

The 3.14.0 delivery changes several user-visible collaboration surfaces at once: Debate, physical-operator traces, governance evidence, billing classification, private memory, Synapse navigation, and Agent Team boundaries. These surfaces share events and model routes, so a projection can appear complete while it is still missing a provider result, charging the wrong ledger, or confusing execution with governance. The existing Debate transcript, Synapse session map, native-subscription route, and Prime/RLM notes remain the authority for their individual decisions; this checkpoint records the release acceptance boundary and current delivery state without superseding them.

## Proposal

The release uses explicit, bounded projections with one authority per fact.

- Debate has one logical Desktop instance. Starting or inspecting a run must not launch an extra visible DSH Desktop application or expose a helper as a second Dock item.
- The roster is a semantic HTML table with human-facing role names, duties, operator, model, and status. Internal role ids, raw tags, and technical details stay in an optional details view.
- Standard Debate has a multi-round budget that admits a later round before dispatch and reports the actual stopping reason. An explicit concise request may intentionally use one compact round, but it is not labelled as an accidental budget failure.
- Provider identity distinguishes a native model variant such as `claude-fable-5[1m]` from a real fallback. A fallback is shown only when the selected provider changes, with the reason available in technical details.
- Debate is an execution route and must not overwrite the persistent main-model picker. When the run ends, the user's selected model and collaboration preference remain unchanged.
- Subscription-backed Codex and Claude Code Debate calls are classified outside the DeepSeek API billing ledger. DeepSeek API calls remain billable and historical false charges are removed by the ledger's explicit reprice rule.
- Governance Trace shows admission, routing, scope, approval, lease, receipt, retry, evidence, and delivery decisions. Ordinary trajectory shows execution progress, tool calls, public outputs, Debate floors, and usage; the two projections link to each other without duplicating the same event stream.
- DSH Mnemon stores only stable user preferences and project rules locally. Seeded memories exclude credentials, network identifiers, raw sessions, temporary progress, and source-controlled private data; no private memory file enters the GitHub source or release artifact.
- Synapse's session-map control is registered in the DSH conversation action area beside orchestration and Debate controls. The upstream visual map remains a removable projection and does not become an execution authority.
- The Debate panel follows a BBS-like reading order: topic, status, participant table, round floors, claims and evidence, moderator summary, dissent, and usage. Long content uses readable cards and bounded scrolling rather than raw Markdown table text or unstructured strings.
- Agent Team remains a user-facing role and mailbox experience, while the single TaskGraph Scheduler remains authoritative for DAG readiness, parallelism, scope conflicts, retry, quota, and evidence. The release records the effective limits instead of claiming unlimited clustering.
- Physical-operator output includes bounded public progress, native provider/model identity, tool-call/result summaries, usage, artifacts, and errors. It never exposes private reasoning or treats a summary placeholder as a complete native trace.

The implementation is currently in progress. The 3.14.0 source worktree has not completed its L3 Desktop gate, has not been installed as the accepted release, and must not be described as published until source, package, running version, and remote commit evidence agree.

## Alternatives considered

**Put every collaboration event into the ordinary trajectory.** Rejected because governance decisions answer why work was admitted or blocked, while trajectory answers what execution did; combining them makes both views redundant and obscures the authority boundary.

**Render provider ids and Markdown tables directly in the browser.** Rejected because raw ids, fallback internals, tags, and pipe-delimited tables are implementation output rather than a usable participant or discussion view. Semantic elements keep the same facts inspectable and accessible.

**Run exhaustive real subscription and API tests after every contributing change.** Rejected because it burns quota without adding evidence when the affected contract and inputs are unchanged. Offline fixtures and affected focused checks cover development; one minimal final real-subscription acceptance follows the stable L3 build.

**Make Agent Team or Debate its own global scheduler.** Rejected because a second authority could race TaskGraph state, leases, retries, quota, and completion evidence. They remain consumers of the shared Scheduler and physical-operator seams.

## Acceptance criteria

- A Debate start and inspect flow leaves one visible Desktop application, and no orchestration or resident helper appears as a second Dock application.
- A fresh Debate renders the user topic verbatim, a real semantic roster table, readable round cards, and a moderator summary without raw tags or pipe-table text.
- A standard run can start its configured later round when budget admission permits; a concise run records its intentional one-round policy; every terminal result names the actual stop reason.
- Fable and other native aliases do not display a false fallback, while a real Opus-to-Codex fallback displays the changed provider and reason.
- The main model picker retains the user's selection before, during, and after a Debate run.
- A Codex-only or Claude-only subscription Debate does not increase DeepSeek API usage or cost, while a DeepSeek API call remains visible in the API ledger.
- Governance Trace contains governance-only decisions and evidence, and ordinary trajectory contains execution details; neither view is merely a relabelled copy of the other.
- Mnemon rereads the seeded stable preferences after restart, private paths remain untracked, and credentials or raw session material are absent from the stored entries and release tree.
- Synapse's session-map control is placed beside orchestration and Debate controls at supported widths without overlap, and removing Synapse leaves ordinary sessions usable.
- Debate details remain readable at desktop and narrow widths, preserve round and floor order, keep technical fields secondary, and provide accessible labels for status and controls.
- Agent Team, Debate, and TaskGraph report the configured participant, member, provider, and parallel-capacity limits; only TaskGraph owns cross-run scheduling and scope conflict resolution.
- A physical-operator Debate or direct turn shows every available bounded public provider event, native identity, tool result, usage, artifact, and error in the trace after reload, without private reasoning.
- The final L3 delivery assigns a new stable version, builds that exact source commit, installs the accepted app on the MacBook, verifies displayed/runtime/package identity and HTTP health, and verifies the pushed remote SHA before claiming completion.

## Risks

- Native subscription qualification can fail because of product authentication or network state. The UI must show the actual provider error and must not silently substitute a DeepSeek API route.
- Public trace enrichment can leak more data than intended or inflate session logs. The projection stays bounded, content-addressed where needed, and excludes private prompts, hidden reasoning, credentials, and full terminal text.
- Budget admission and provider capacity can stop a Debate before the requested maximum rounds. The result must distinguish deliberate compact policy, quota exhaustion, provider failure, and convergence rather than collapsing them into one label.
- Private Mnemon data can be accidentally copied by packaging or broad repository commands. Local storage and release checks must keep it outside tracked source and generated artifacts.
- The release still depends on reconciling all parallel worktree changes before the single final gate. Until that reconciliation and the L3 runtime evidence complete, this note remains a proposed in-progress checkpoint.
