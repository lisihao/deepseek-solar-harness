# On-demand tool context: phase 1

Status: implementation authorized on 2026-10-22. This contract covers tool description discovery/loading only. Historical tool results, memory injections, skill discovery, model configuration and unrelated plugins are unchanged.

## Acceptance boundary

The official rc.2 Host retains every caller-visible tool and its original execution pipeline. Under TypeScript PTC presentation, the model initially receives only the discovery/loading SDK. Search pages expose real caller-scoped names and bounded descriptions; loading adds complete selected declarations to the next assembly without executing a business tool. Loaded descriptions may be evicted, but callable capabilities are not restricted. Native presentation is unchanged.

No real provider requests, browser submissions, canaries or unknown-effect replays are authorized. Verification uses published AgentLoop/ToolRuntime with fake adapters/tools, scratch CLI profiles, and an isolated fixture inside the installed official App Host. No official App/runtime edits are permitted.

## Public seams

- `system-prompt/assemble`: replace the one `tools:sdk` section after normal providers finish, preserve all other sections, contexts, variables and wire schemas.
- `ToolRuntime.schemas(scope)` and `get(name, scope)`: resolve the caller's complete allowed catalog and output contracts. Never use `restrict()`, private registry fields, alternate privileged dispatch or a model capability override.
- `renderToolsSdk`: render exact selected argument/output schemas with the official TypeScript renderer.
- Every search/load/assembly resolves the live caller-scoped registry; no cached global catalog can bypass a changed restriction or declaration.
- Standard `tool/ptc-dispatch` events activate successful loader receipts only after normal execution/policy/logging. A finalized `tools/result` is staged solely to serialize sibling loads in the same `run_code`, and the next load waits for its matching accepted log record. Public `sessionQuery` restores the last receipt from the logical session. No custom session event type.
- `agent/pre-step`: confirm receipt durability and start a new request series when SDK content changes, preventing in-history prompt accumulation.

## Scope, persistence and failure

Search/load are caller-scoped. The loader selects descriptions, not permissions. Unsupported presentation/complete-prompt composition and hidden discovery tools must surface a named diagnostic rather than stripping capabilities or guessing a private layout. Selection is represented by compact versioned receipts in standard logs; no authoritative separate database or executable cache is introduced. Receipt/schema changes, scope changes, cancellation and policy replacement are checked before admission. Originals are append-only and never rewritten.

The bootstrap SDK target is at most 8192 UTF-8 bytes. Search defaults: eight matches, 240 Unicode description characters, 8192 UTF-8 bytes per JSON page. Selected SDK defaults: sixteen tool descriptions and 32768 UTF-8 bytes. Exact schema fields are never truncated. A single tool that exceeds the selected budget returns a named error; the underlying capability stays callable. Repeated selection evicts oldest description entries and reports that eviction.

## Required evidence

1. Preserve a large fake catalog, child-scoped registrations and inherited restrictions; compare pre-existing names/schemas before/after.
2. Search/load execute no business operation; an original `run_code` call still traverses guards, approvals, cancellation and logging exactly once.
3. Bootstrap bound; complete loaded schema; repeated loads and resume keep one effective system prompt with no old SDK accumulation.
4. Failed, malformed or stale receipts do not activate a selection; successful receipt state survives cold reconstruction.
5. Original log prefix, historical tool-result content and memory messages remain intact.
6. Built plain-Node/scratch CLI behavior, stable package hash, exact installed file bytes, unrelated profile preservation and installed-Host isolated acceptance.

A fake-adapter success is mechanism evidence, not model tool-choice accuracy or a claim of real provider quality improvement. Live model behavior remains unrun.

## Source and scratch results, 2026-10-22

`pnpm check` passed: build/declarations, TypeScript, 104 tests in 12 files (including 27 new tool-context tests), two official-CLI scratch-profile probes, and homepage/curated-package checks. The new probe installs packed tarballs and imports the installed `lib/index.js` under plain Node; the isolated published AgentLoop captured four fake responses and three ordinary PTC bindings (search, load, one fake business operation). Real provider calls and user-session writes were zero.

Regressions include asynchronous serial load logs, original deny/ask/cancel paths, exact unloaded tool calls, changed registry hashes, failed receipt flush/retry, cold reconstruction, complete-prompt refusal, dynamic section re-evaluation, original historical tool/memory/prefix retention, and replay with the current strict `Session.create()` constructor. Native wire schemas preserve the original tool set; the plugin's PTC-only discovery helpers are not added to Native wire declarations.

Installed-App acceptance is a separate delivery step; these source/scratch results do not by themselves claim it has passed.
