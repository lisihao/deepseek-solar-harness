# Agent Note: A child starts with its own context, and a parent reads a child's result in checked segments

Status: implemented

English | [中文](2026-10-16-rlm-child-context-and-result-retrieval.zh.md)

## Problem

A child's REPL `context` was a clone of its parent's `context`. The parent's `task` in it is the parent's whole task, which can hold the whole input and the tasks of other children. Captured requests showed the effect: a marker that appeared only in the root's task came back to the root in the result of the child's cell `JSON.stringify(context)` (child rounds 1 and 2 of the API path), and the Resident child's REPL printed the root's task. The child's own prompt already held only the child's task, so the model request was not affected; the REPL view was. That is a visibility leak between agents, not a measured cost.

A parent had no bounded way to read a child's stored result. `listSubagents()` dropped `outputPreview`, and the full result existed only as an artifact the model could not name. The only text a parent saw was what the child chose to message. Nothing here measures how often a larger result mattered; this note records the contract, not a gain.

## Decision

**A new child's `context` is the protocol keys of its parent plus `task` set to the child's own whole task.** The protocol keys are `runId`, `nodeId`, `contextPacketRef`, `capabilityPlanRef`, `graphCertificateHash`, `defaultChildOperatorId`, `defaultChildModel`, `defaultChildTier`. Nothing else is copied: not the parent's task and not values its cells stored. Trusted child selection (model, policy) is read from the persisted session snapshot, not from `context`, so no decision depends on the dropped fields; a child that needs material gets it in the task its parent writes. The task is never shortened. Children admitted earlier keep the `context` they were persisted with.

**`rlm.childSummaries()`** returns id, name, depth, lifecycle, `resultRef`, `error`, and the first 200 UTF-16 code units of the preview, without the task or session directory. `listSubagents()` is unchanged.

**`rlm.readChildResult(child, { offset, limit, resultRef })`** reads one segment of a direct child's stored result. Authorization comes first and from the caller's persisted record: the child must be one of the calling session's children (`RLM_FAMILY_VIOLATION` otherwise), a given `resultRef` must be the one recorded for that child (same error), and a deleted or closed child is `RLM_UNAVAILABLE`. A child that is accepted or running is `not_settled`, an indeterminate child is `indeterminate`, a child without a result or whose result the host does not hold is `not_found`; none of these is returned as an empty success. The host then returns the stored content for the recorded reference only if it is a `prime-rlm-child-result` of the same run, node and child session. The rendering is the text blocks joined by one newline; blocks that are not text are counted in `omittedBlocks` and not rendered. Units are UTF-16 code units; a segment never ends inside a surrogate pair, and an offset past the end or inside a pair is `RLM_INVALID`. The result carries `segmentSha256` (the segment), `fullSha256` (the whole rendering), `resultRef` (the artifact reference, which is a different hash), `totalUnits`, `complete`, `truncated`, `nextOffset`, `stopReason`, `commandId`, `isData: true` and the text. The object is kept within one third of `limits.maxOutputBytes` because the cell's recorded output counts both the value and its rendering. Each read appends `rlm.child.result.read`. `readResult` is an optional host binding; without it the helper fails with `RLM_UNAVAILABLE`.

**The generic strategy text changed in its own commit** (strategy `1.5.0`): children only for independent parts worth their cost, a small or strictly sequential task solved directly. It adds no field to the plan and no `delegation` setting.

## Alternatives considered

**Keep the parent's `context` and hide `task`.** Rejected: values stored by cells would still go with it, and a field-by-field deny list fails open for new keys. An allow list fails closed.

**Truncate a child's task to a tail.** Rejected: the child's own last lines carry its output rules; the task stays whole.

**Authorize by the reference alone.** Rejected: the artifact store is shared by every run. The record in the caller's session names the reference, and the daemon checks what the store returns.

**Return the whole result with a truncation flag.** Rejected: a result can exceed the output limit; segments with two hashes let a parent verify reassembly.

## Consequences

The model-visible `typescript_repl` description gained two sentences, so a prompt prefix that contained the old text is not reused for it; the effect on cache hits and tokens is not measured. A cell that printed `context` in a child sees fewer keys. Nothing measures whether children cost less or answers improve. The state file format did not change: the new helper reads the existing `resultRef` of the persisted children, state stays at version 6, and old sessions are neither rewritten nor migrated. One persisted record type is new: each read appends an `rlm.child.result.read` event (child, command, reference, offset, length, flags, both hashes, status; no text) to the `events` list of `state.json`. State loading checks that `events` is an array and does not check event types, and 35 event types already exist there, so a build without this change loads such a file; this was read in the code and not tried on an older build. An auto-refine turn puts the last 128 events of the session into its prompt, so these small records can appear there. The sealed `rlm-runtime`, `rlm-runtime-local`, `rlm-strategy-local` and `orchestration-local` packages change, so a Desktop release containing this needs them resealed.

## Tests

`child-context.spec.ts` covers the allowed keys, the whole task including its last line, none of the parent's task or stored values, grandchildren, and a persisted session. `child-result.spec.ts` covers reassembly with both hashes over text with surrogate pairs and multi-byte characters, the output limit, every refusal (another session, a guessed reference, deleted child, host without a reader), the status of unsettled, indeterminate, failed and result-less children, ranges, rendering of mixed blocks, summaries, the event, and the same authorization after a restart. `rlm-continuation.spec.ts` covers a stored item of another run, node, child session or kind. `prime-rlm-e2e.spec.ts` captures the Resident root and child requests, reads a stored result through the real daemon, and completes a root that creates no child. The `prime-rlm-terminal` snapshot gained a `captured` scenario through the production Loader and daemons with only the model provider replaced; its before and after captures are in the evaluation report directory. Forty mutation definitions under thirty-six ids were run, each breaking one rule, on the runtime, the daemon reader, the strategy, the Resident end-to-end seam and the API seam (the production Loader snapshot, in source mode). Not detected on the first run: the newline join of rendered blocks and the prime-strict strategy wording (each closed by a test added in this change); a clone-of-the-parent mutation at the Resident seam, a `complete` mutation and a dropped child-session condition (replaced, because the first two are equivalent at that seam or the seam only takes the authorized path, and covered by the runtime and continuation unit controls); and a segment-hash mutation that survived once and was closed by checking each segment's hash and offset in the end-to-end test. The superseded definitions and their logs are kept in the evaluation report directory.
