# Hindsight automatic chat recall repair

The user authorized repair, timeout/cached-topic handling and installed-App model-input acceptance on 2026-10-23. Screen operations are forbidden. Real model calls require a concrete budget and explicit cost approval before dispatch. No real calls are authorized by this document.

## Observed problem

Installed Hindsight coding-agents 0.8.1 uses `autoInject=pages`: twelve original chat prompts returned five unchanged page snippets for the eight DSH cases and no pages for the four other-project cases. The twelve target rules were not in those first-request projections. Mnemon 0.5.32's default-three-tier is guided, with long-term memory routed on demand; ordinary page search 12/12 is separate evidence. Hindsight's independent injection timeout defaults to 7000 ms; Mnemon's 60000 ms does not configure it. Its native goal injection also caches a first result across a session.

## Bounded implementation

An independent unreleased bundle at `incubator/hindsight-chat-recall` uses official rc.2 `agent/pre-step` and Mnemon's existing read-only service. It resolves the current Agent's exact registered workspace, checks active Hindsight spaces, then executes an ordinary project search with query/limit/workspace parameters. It adds bounded, quoted Hindsight evidence as a standard logged plugin user message before the request. It never uses memory-page clicks, reflect, retain, credentials, new sessions, background generation or a second Hindsight client. Existing scoring/Native thresholds and bank data remain unchanged.

Each new user input is read afresh: no result cache survives a turn or topic change. Tool-only continuation steps do not trigger another search. The read is bound by a validated timeout, caller cancellation and plugin disposal; a late result cannot be appended. Retrieval failure/timeout is explicit and prevents that request from being dispatched rather than silently claiming memory was consulted. Workspaces without active Hindsight remain unaffected.

The supported project-isolated deployment requires live Mnemon `storageScope=workspaces`; acceptance refuses to submit test inputs under global storage. This adapter follows the installed Mnemon routing policy rather than redefining global storage. Its pre-step listener preserves every decision field it receives. Mnemon 0.5.32 and Hindsight 0.8.1 can independently reconstruct pre-step decisions without request-series metadata, so this repair does not claim general model-handoff compatibility or patch those dependencies.

Installation also sets only the supported Hindsight `harnesses.dsh.autoInject=none` override, preserving its tools and other harnesses while avoiding a second stale automatic block. Existing writeback behavior is not changed incidentally. Acceptance sessions must separately prevent background writeback from spending unapproved model budget. This is a thin adapter over existing installed Mnemon/Hindsight services, not a vendored or patched dependency.

## Paths and acceptance

Only this package, its standalone lock/build/test tooling, a dedicated CI workflow and this document change. No App build or upstream modification. Local/fake tests must demonstrate the defect without the hook, topic refresh, same-text next-turn refresh, timeout, ignored abort/late result, cancellation, disposal, missing workspace, inactive Hindsight and Native score preservation. Built plain-Node official-CLI plugin testing is required.

Installed acceptance must preserve an identified artifact and fresh backup, wait for explicit App ownership handback, then use actual normal AgentLoop and inspect model-bound messages. A temporary observer/fake provider can measure input first without generation. Only after user approves the concrete cost plan may the twelve real requests be sent. Inspect exact fact provenance and source text in the actual request, not the final answer. Keep all private queries/receipts outside Git. Commit/push and open a personal-repository PR; no merge, release, tag or market publication.
