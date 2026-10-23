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

## Installed-App acceptance

The production package from source `211726f5f32c8a5c88503869081916d3525f96a0` was installed through the official bundled CLI. Archive SHA-256: `718490e9b6ddcfd0a7e4f49e1dd5d83c69e714e3a2f1c1a13ca89fa1533c3b3a`. All 12 installed files matched the archive; the observed installed `lib/index.js` SHA-256 was `cfdf8c54bfce899faa522af1361d84b23a2ed8fd911655adbbf1b3df20242940`. Exact source CI [39875184776](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39875184776) passed.

After a normal App/Host quit and an idle Resident shutdown, the latest profile/lock files and affected plugin-owned data were backed up. The official App Host registered both helpers and ran the packed production import in a separate Context: four fake adapter responses, normal PTC search/load/one fake business dispatch, zero real provider calls and zero user-session writes from the isolated probe. Both temporary acceptance bundles were then removed through the official CLI, production bytes/configuration were rechecked, and the official App/Host reopened.

The same installation included the necessary `skill-context` step-order correction from source `5ea10c7`, separately verified. Original compressed-log prefixes were preserved. App relaunches appended lifecycle/inbox records in one existing log; no new turn, request or tool event appeared in that delta. Unrelated plugin JSON, dependency manifests, profile configuration, credential configuration and App/CLI files matched the installation baseline. Private logs and account data are not included in the repository.

The current public inventory includes local-only installed bundles whose reproducible public source is not identified; their names/versions are recorded without invented download commands. No unrelated bundle was disabled or repackaged.

## Manual request finding and repair, 2026-10-22 (America/Toronto)

The user initiated one native metadata-only test. It did **not** discover or load a tool: the request header had no tools, the log explicitly removed `run_code`, and the effective system prompt was empty. The provider reported 11,922 input tokens versus 53,619 in the earlier skill-context test on the same provider/model/effort. That measured decrease is not a successful optimization or a representative savings claim: the required capabilities and instructions were missing. No request was submitted or retried by the implementation agent.

Read-only inspection found that an installed prompt rewriter collapses repeated horizontal spaces in all non-owned sections, including `tools:sdk`. The recorded old SDK was already rewritten, so reapplying the rewrite to that old text cannot identify the original mismatch. Applying the installed pure rewrite to a **fresh synthetic declaration from the published renderer** changed 1,921 to 1,907 UTF-8 bytes: two/four-space indentation became one space. Boundary trimming alone did not make the texts equal. The initial implementation required exact renderer-text equality. The same installed plugin wraps assembly and returns empty sections/contexts/tools when an inner assembly throws. Isolated regressions reproduce that mismatch-to-empty-request mechanism without a new real provider request. No third-party plugin or official runtime is modified by this repair.

The repair accepts only leading horizontal indentation and outer whitespace differences when identifying and verifying the published SDK. Text within each line remains exact, including string literal values: `"a  b"` may not become `"a b"`. Every PTC pre-step rechecks the public composition, selected SDK and unchanged wire declarations rather than caching a prior successful check. Own assembly failures are retained per Agent and rethrown outside the assembly wrapper before request admission. Successful assembly clears that Agent's error, permitting a later corrected attempt without changing permissions or replaying an earlier operation.

Public-seam boundary: the verification assembly is separate from the first assembly used by AgentLoop. It detects stable composition changes and the observed swallowed inner failure, not every possible non-deterministic external wrapper that returns an empty first value and a valid second value. The plugin does not intercept or patch the official loop to claim such a guarantee.

Original session events, historical tool results and memory messages remain intact. Real discovery/loading acceptance is still pending a new user-initiated request after the repaired package is installed. The prior passing isolated checks cover only their stated fixture boundaries; they did not prove compatibility with this installed prompt rewriter.

Source verification for this repair: 110 distinct tests in 13 files passed, including six new composition regressions (indentation compatibility, swallowed mismatch, stable empty composition, Native preservation, same-Agent recovery, and rejection of an altered string literal). Build/declarations and TypeScript passed. The initial sandbox blocked eight local socket tests with `EPERM`; only the three affected files were rerun with local socket permission and passed, without rebuilding or repeating unaffected tests. Both official-CLI scratch probes and homepage/package checks passed. The tool-context probe now reads real caller-visible catalog metadata through the public preset lease and tool registry, then uses inert tool bodies only in a separate fake-adapter Context; the CLI fixture covered 25 metadata-only tools and the repeated-horizontal-space rewrite. No original user request or business tool was executed by that probe.

## Repaired package installation, 2026-10-22 (America/Toronto)

Runtime source `9e207cdcdf30106a1e6cd5e58440b97919270b89` passed exact-source CI [39884914328](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39884914328). Its stable tarball SHA-256 is `e5a79b125b7fe44c58f23f197396e6533518fba4177d4381480241f628224ce6`. The official bundled CLI installed it after a coordinated normal App/Host quit, a fresh six-file profile/lock backup, and an idle Resident shutdown. All 12 production files matched the archive both before and after temporary-probe removal.

The installed rc.2 Host acquired the public PTC preset and read 132 caller-visible tools, whose full SDK was 139,083 UTF-8 bytes. An isolated Context copied that metadata with inert execution bodies, reproduced the repeated-horizontal-space rewrite, and passed discovery/loading/subsequent-use checks with four fake adapter responses. Non-SDK prompt sections remained present. These are installed-Host composition checks, not a real user-session/provider run or a test of the user's complete permission configuration.

The temporary probe was removed through the official CLI and the App/Host reopened. Unrelated dependency specifications/manifests, four profile configuration files, credential configuration, plugin JSON and Resident graphs matched the fresh baseline. The 354 existing compressed logs were neither added nor removed; 353 matched byte-for-byte. In the remaining log, the entire original compressed-byte prefix matched its earlier SHA-256; only six App lifecycle/inbox events were appended, with no new user turn, request or tool event. Official App/CLI files were unchanged. The coordinated installation preserved the other development chat's latest settings and returned its shared App/profile window.

Real provider acceptance remains pending one user-initiated metadata-only request. Token savings will be assessed from that request's recorded provider usage only after both discovery and loading are confirmed; the earlier invalid 11,922-token request is not a successful baseline.
