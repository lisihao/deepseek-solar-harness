# Agent Note: Session-scoped kennel room and confirmed task recipients

Status: implemented

English | [中文](2026-10-06-kennel-session-room.zh.md)

## Problem

A long-lived member roster does not prove that a member has an available executor, and a shared workspace does not identify the chat that admitted a task. A room that attributes stale outputs or changes executors after an addressed request can misrepresent both ownership and completion.

## Decision

The [Gouzi room](../../../../packages/orchestration/ui-gouzi/README.md) keeps the user/steward transcript alongside a persistent right-side member and task panel. The message area owns only transcript rendering and its independent scrollport; a separate `conversation.room.composer` shares the room’s draft and recipient store. The conversation Root retains the sole mandatory `conversation.composer` chain for Question, PlanReview, Approval, and Readonly. Inert or model-blocked sessions make the room composer decline so the existing InputBar preserves unblock controls. A TaskGraph `awaiting_approval` projection does not manufacture a pending session interaction. Display filters and composer recipients are independent. Only an explicit member selection records a stable member id, generation, and standard execution mode in the durable user message; typed display names do not select recipients. Recipient lookup uses only the newest human `user/message` with `source.kind === 'user'` before the current turn boundary. An ordinary human message can clear the target; plugin, context, and tool messages in the user role cannot clear or replace it. The Host checks that identity against registry membership and the actual execution directory again at TaskGraph start. Standard addressed graphs pin each node to qualified entries without fallback and disable RLM and Autonomous Mode. Direct delegation cannot bypass the addressed route.

Room message and older-history actions resolve the conversation service through `sessions.scope(id).get('conversation')`. The strict lookup retains the caller’s session tag without requiring service property injection on the runtime-owned scope. The owning plugin still declares `conversation` as a required service, and missing sessions or services fail explicitly. Real Cordis service-tracker tests distinguish this lookup from a plain-object fixture and preserve the explicit target when global selection changes.

The provider-neutral [execution query](../../../../packages/orchestration/orchestration/README.md) obtains actual registrations through [local protocol 7](../../../../packages/orchestration/orchestration-local/README.md). Registration matching includes member generation and identity, host, owner, and endpoint; fresh catalogs determine availability and models. Online connection state is insufficient. These reads do not create members, grants, or tasks. The Host includes its validated polling interval in each room reply; the browser schedules from the last successful reply rather than assuming that BootGraph forwards Host configuration to client modules. A first-read failure has no confirmed interval and waits for the explicit reread action; later failures retain the last successful interval and mark the snapshot stale.

Room tasks belong only to the exact `admission.sourceSessionId`. A result requires a retained evidence reference and a terminal event for the current node attempt and capability generation, with an operator matching the current sealed execution plan. When the sealed operator belongs to the run’s durable `admission.gouziRecipient.operatorIds`, result attribution preserves the original admitted `gouziId` across member generation changes or retirement. Without that durable binding, only a unique actual registration permits member attribution. Neither path invents a sealed member generation, which the execution plan does not contain. The authoritative result event time merges results with session messages in recorded time order; polling time does not reorder history. Missing fields, mismatched sources, or ambiguous registration leave the corresponding attribution or result absent. Evidence reads require the same admitted run and a retained node reference. Outputs are task results, not invented autonomous member messages.

## Alternatives considered

**Inferring execution from an online roster or constructed provider id.** Connection and presentation metadata do not prove a current registration, authentication, or model availability, so the room consumes the actual execution directory.

**Grouping tasks by workspace or reusing older attempt output.** Several sessions share a workspace, and attempts can replace earlier outcomes. Exact admission and current-attempt checks preserve the room’s ownership and result meaning.

**Combining display filtering with sending or switching an unavailable recipient.** Reading one member’s records does not authorize sending it work. Separate controls preserve the chosen target, and refusal keeps the user’s intended executor explicit.

**Treating task output as automatic member conversation.** Terminal task evidence proves an execution outcome rather than an independently authored chat turn. The room labels the output as a task result and adds no dog-to-dog conversation.

## Consequences

Members remain discoverable beside the transcript without changing the single TaskGraph authority. Empty execution entries, offline or stale members, and generation changes refuse addressed starts rather than selecting another executor. An indeterminate outcome requires reconciliation of the original run; the room performs no automatic redispatch. Missing admission or incomplete terminal events can produce an empty task list or absent result even when other scheduler data exists.

Host and room tests cover exact-session filtering, legacy runs without admission, stale attempts and generations, sealed-source mismatches, failed results, unknown states, retained-evidence authorization, read-only routing, and route disposal. Recipient and client tests cover durable target identity, qualification, separate filtering and sending, and preserving failed-send state. Loader composition and replay cover plugin-injected ordinary text and another recipient marker without changing the original human-selected member. These source checks do not establish installed-app behavior or CI acceptance; release and installation remain separate operations.
