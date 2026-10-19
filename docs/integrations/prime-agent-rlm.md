# Prime Agent RLM operator for DSH V4: detailed design

Status: **design for review, not implemented**. On 2026-10-19 昊哥 commissioned extraction of Prime Agent's RLM-related capabilities as a DSH V4 plugin and requested this detailed design. This is the separately commissioned RLM task anticipated by the native-plugin contract; it does not enlarge the scope of either native plugin. TinyJuice and OpenHuman are not dependencies of this design.

The plugin-construction objective is accepted. The immediate acceptance boundary is a reviewable, source-grounded design covering scope, public interfaces, data, runtime distribution, recovery, implementation order and observable acceptance. [AGENTS.md, Integrating an open-source project](../../AGENTS.md#integrating-an-open-source-project) requires the design to be reviewed before implementation. No implementation/scaffolding, installation, paid probe, merge, release, market publication or recurring automation is performed by this document change.

The latest human-provided D4 instruction selects the existing official home, `~/.dsh`, for a separately authorized installation; development uses disposable homes. An older base-branch document may still describe the superseded separate-home prerequisite. This design records the current instruction without changing another task's installation documents.

Subsequent clarification (2026-10-19): 昊哥 requires extraction/wrapping to preserve Prime's original RLM and Continual Harness mechanisms. The host replacements and behavioral deviations below remain an unapproved proposal; unchanged Python files do not establish full preservation. The [evaluation specification](../testing/prime-rlm-evaluation.md) defines an original-host differential gate before fidelity or efficacy claims. This document is not implementation approval.

## 1. Product outcome and completeness

The deliverable is one independent bundle, `@lisihao/dsh-solar-rlm`, developed under `incubator/rlm/`. It lets a DSH user give a task plus authorized data references to an RLM Agent. That Agent operates through a persistent Python environment, programmatically constructs recursive subtasks, retains intermediate data outside its model context, gathers results, and returns a final artifact with a reconstructable execution tree and honest usage evidence.

The official Desktop app remains unchanged. There is no V4 core, new model provider, second login, Prime Desktop/TUI, or Prime Rust daemon. Model inference uses DSH Agents and their configured adapters, including any already-installed subscription adapter. Native Codex/Claude tasks may be used through the existing permitted DSH tools; they are not silently relabelled as RLM child Agents.

“Complete” means all required rows below pass their acceptance cases, including known failure and recovery behavior. It does not mean importing the entire Prime product, allowing unlimited recursion, preserving every live OS object, or reproducing the paper's performance numbers. Source-ready, usable in the installed app, published, and experimentally beneficial remain separate claims.

| ID | Required capability | Completion condition |
|---|---|---|
| R01 | Input-as-data | The root receives task and metadata; full selected data remains addressable by immutable references and Python values/files. |
| R02 | Persistent REPL | Variables, functions/imports, top-level await, expression results and background activity follow the pinned runtime's actual semantics across cells. |
| R03 | Real programmatic recursion | Code generates child prompts, and children can recursively do the same, subject to explicit limits and the host's existing constraints. |
| R04 | Admission and collection | `spawn` returns admission, not an answer; typed collection distinguishes pending, running, settled, failed and cancelled work. |
| R05 | Family communication | Parent/child/sibling messaging, observation and progress work within a run's authority; message receipts survive retry reconciliation. |
| R06 | Retained children | List, collect, follow-up, rename and delete preserve identity, result and usage semantics; deletion does not manufacture cancellation. |
| R07 | Model selection | Inherit the actual parent route by default; explicit supported model/effort overrides are preserved; unsupported choices fail. |
| R08 | Tool and shell access | Programmatic DSH tools retain guards, approvals and cancellation; direct Python/bash execution has an explicit sandbox/lifecycle boundary. |
| R09 | Bounded output and final artifacts | Large results stay external; visible output remains bounded and labelled; final content can be assembled in variables/files rather than regenerated as one model answer. |
| R10 | Durable state and recovery | Inputs, receipts, model-visible material, checkpoints and outputs persist; uncertain effects are fenced rather than replayed. |
| R11 | Snapshot fidelity | Saved/skipped/pruned/failed names are exposed; missing or incompatible state cannot appear as full recovery. |
| R12 | Whole-tree budgets and accounting | Admission observes run limits; each actual attempt has attributable usage or explicit unknown fields; no duplicate folding. |
| R13 | Factory related capabilities | Include the pinned validator/compiler/executor, state/DAG forms, joins, foreach, guards, budgets, live stop/resume and graph/watch behavior, including its documented cold-restart limitation. |
| R14 | Local Continual Harness | Plugin-local memories/notes/skill and child descriptions, factory specifications, history and explicit refinement controls; no ambient Codex/DSH global-memory edits. |
| R15 | Lifecycle and UI | Normal start/inspect/pause/resume/cancel/read path; readable state and evidence; disable removes contributions and settles owned resources. |
| R16 | Distribution and upgrades | A normal plugin install can provide the complete pinned runtime without pip/Cargo/build scripts on the target machine; upgrade behavior is documented and tested. |

Out of scope: TinyJuice/CCR/compression algorithms, OpenHuman, Jev, autonomous calendar/heartbeat activation, unrelated Prime skills/providers, DSH 3.x data import, native-driver replacement, multi-host scheduling, and modifying official upstream. File slicing and full-data retrieval remain required; removing TinyJuice does not remove R01/R09.

## 2. Source baseline, license and evidence

| Item | Fixed identity | What was inspected |
|---|---|---|
| Integrated project | [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa77b38facd7c87277fa3c82bcadbe816880), commit `7cbffa77b38facd7c87277fa3c82bcadbe816880` | Python runtime/skills, Rust host/lifecycle/ledger/bootstrap, prompts, manifests and test sources. |
| Runtime package | `prime-agent-runtime` manifest version `0.1.0`, at the above commit | Python `>=3.11`; declared runtime dependencies `mcp>=2,<3` and `tyro`; `dill` is development-only in the manifest but required for snapshots. |
| License | [MIT](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/LICENSE) | Retain copyright/permission notices; audit the actual locked Python dependency payload separately. The runtime's `0.1.0` alone is not an adequate source pin. |
| Harness | Published `@deepseek-ai/dsh@0.2.1-rc.2`; source `687f282e8625c6b8d11ff58211a90524be2e4317`; Cordis `4.0.5` | Installed published package README/lib/type contracts. |
| V4 design base | `e7bc78053d6ebf60753ef5892faf1a3a39446ef9` (`origin/v4` at task start) | Existing native-plugin ownership and public contracts; no dependency on unmerged UI/handoff work. |

The actual current Prime host is Rust (`pa-core`, `pa-daemon`); historical TypeScript-host prose does not define this version's behavior. Read-only source evidence is reusable while these inputs remain fixed. No Prime project test, bootstrap, dependency installation, model call or app launch ran during design.

The earlier app resource/ASAR filename inventory did not identify a usable bundled Python interpreter. This is not an executed interpreter-availability test. The design therefore specifies an independent packaged interpreter, subject to distribution acceptance, instead of assuming system Python or uv exists.

## 3. Architectural decisions

| Decision | Selected design | Reason and limit |
|---|---|---|
| A01 | One Solar plugin; unmodified Prime runtime/selected skill distributions plus a TypeScript host adapter | Preserve source/upgrade boundaries without importing Prime's model transports or daemon. |
| A02 | Agent-local ordinary `python_repl` tool | Its outer invocation/result is recorded by the normal DSH Agent loop. Other Agents keep their existing tools/runtime. |
| A03 | Do not replace global `ctx.ptcRuntime` or register reserved `run_code` | Standard PTC resolves its provider from the owning ToolRuntime context, not from an Agent preset. Entry-local service isolation does not automatically affect that lookup. |
| A04 | Actual DSH in-process children for `rlm.spawn` | Gives real model requests, sessions, supported model options, lineage and public lifecycle APIs. No mandatory Native Resident contract change. |
| A05 | Host-bound execution plus durable safe-point recovery | A UI detach may leave its live Host working; a stopped Host does not keep its tools available. Do not imply a new always-on daemon. |
| A06 | Plugin-owned operation journal and artifacts; no custom Session event kind | Exact model-visible projections remain in ordinary session records; nested execution evidence is linked rather than disguised as native PTC events. |
| A07 | Existing native tools are optional callable capabilities | Native execution retains its current admission/lane/scope owner. It is a tool result, not an alternative RLM kernel lifecycle. |
| A08 | Restore state, never automatically replay code | Reconstructing variables by rerunning a cell can repeat model, shell, file or network effects. |
| A09 | Preserve known Prime limits as limits | Factory run objects are kernel-memory-only; restored child dataclasses are selectors, not automatically reattached running processes. |
| A10 | Offline-at-runtime packaged Python closure | Normal install must not run pip, uv bootstrap, Cargo or blocked dependency scripts. |

Proposed structure (names below are design names, not existing code):

```text
Official Harness
  Agent / Subagent / Tool Runtime / Session / LLM / Sandbox
                 |
  @lisihao/dsh-solar-rlm
    entry + scoped python_repl + model-facing control tools
    RlmRunController (admission, budgets, lifecycle)
    PrimeHostBridge (typed requests and family semantics)
    KernelProcessOwner (protocol v3, streams, sandbox, teardown)
    RunStore + ArtifactStore (single-writer durable evidence)
    scoped prompt / optional preset / tool-result UI
                 |
    pinned CPython + unmodified prime-agent-runtime
      REPL / bash handles / Factory / local Harness
      selected unmodified agent-message / agent-observe / refine skills
```

No diagram edge grants access by itself. Live owner identity, scope and cancellation are resolved by the Host, not accepted from Python/model JSON.

## 4. User path and model-visible interfaces

### 4.1 Normal path

1. The user selects an RLM task, working directory and input files/artifacts. The selected DSH model is the default route; a named RLM profile can choose explicitly supported child routes.
2. The plugin checks the actual caller's access, freezes inputs and the selected configuration, then persists a run intent. A failed preparation produces no admitted model work.
3. The plugin creates a dedicated RLM root session and kernel. It sends the task and a compact inventory of stable input references. An ordinary caller receives a readable admission receipt linked to that root.
4. The root writes Python cells. The kernel can inspect data, call permitted tools, construct child prompts, gather typed results and accumulate a final result. Descendants receive the same RLM composition.
5. The user can inspect progress and artifacts or explicitly pause/cancel. Waiting for a result does not cancel its run when a wait timeout expires.
6. Completion requires a root result and settled owned descendants/effects. The UI reports computational completion separately from any requested test/quality evidence.

Pasting a whole corpus into an existing ordinary parent chat already spends that parent's context. Starting RLM afterwards does not undo it. The file/artifact entry path is required for a genuine external-input claim.

### 4.2 Proposed ordinary tools

All tool names and response fields in this section are **proposed Solar API**, not existing DSH/Prime methods.

| Tool | Input | Result contract |
|---|---|---|
| `solar_rlm_run` | `task`, `cwd`, named `inputs`, optional approved `profile`, explicit run `budget` | Receipt with `runId`, `rootSessionId`, `state`, `revision`, `inputManifestRef`, effective limits and missing capabilities. Admission is never labelled a finished answer. |
| `solar_rlm_inspect` | `runId`, optional `afterSequence`, bounded result limit | Run/node status, wait reason, progress, usage coverage, artifact references and journal cursor. |
| `solar_rlm_wait` | `runId`, bounded `timeoutMs`, optional cursor | Current snapshot plus whether a terminal change was observed; a wait timeout is not a task failure. |
| `solar_rlm_control` | `runId`, `action: pause/resume/cancel`, `expectedRevision` | Accepted control and new revision; cancellation remains pending until its effects are settled or classified indeterminate. |
| `solar_rlm_read` | owned `artifactId`, byte/line range, output bound | Exact bounded content, source digest, extent and truncation details. No implicit rerun when missing. |
| `python_repl` | `code`, `description`, optional bounded cell deadline | Visible output, outcome, artifact/trace references and checkpoint summary. Registered only for RLM Agents. |

Human UI shows task/child names and sentences such as “Waiting for 2 child results” or “Cancellation requested; one process is not yet confirmed stopped.” Internal IDs remain correlation data and are not the primary UI labels.

The RLM Agent sees `python_repl` plus the authorized Host tools that its Python bridge may execute. Its owned Agent scope explicitly selects `ctx.tools.presentAs('native')`; otherwise an inherited PTC presentation may collapse those schemas into standard `run_code`. This is a per-scope presentation choice, not a global runtime change. The prompt prefers Python for programmatic work, but the permitted Host tools remain model-visible. This additional schema overhead is an explicit tradeoff of the current public seam.

In rc.2, `ctx.tools.restrict()` affects both lookup and execution: a restricted-away tool cannot be recovered merely by supplying a parent execution token. Apply the same capability allowlist to native schemas and nested bridge execution. Do not claim independent schema hiding, impersonate a more privileged Agent or bypass the registry to reach a hidden tool. Any future separate presentation facade requires its own public-seam proof and design review.

### 4.3 Python data and result helpers

The pinned Prime API remains recognizable. A separately authored `solar` helper module adds only DSH-specific data/result access; it does not modify the `rlm` package. Its proposed operations are:

- `solar.inputs`: named immutable input descriptors, each with media type, byte count, digest and an authorized local path or bounded reader.
- `solar.read(ref, range=...)`: exact bounded retrieval from the run's input/artifact store.
- `solar.write_artifact(value_or_file, media_type=...)`: persist an output and return an owned reference; distinguish copying a confirmed input from executing an effect.
- `solar.finalize(ref_or_json)`: stage this node's explicit result. The Host commits completion only after the node and its required descendants settle.
- `tools.<name>(arguments)`: schema-derived asynchronous DSH tool bindings routed through the exact live Agent and original ToolRuntime policies.

These helpers are additions, not claimed Prime `FINAL` or `llm_query` APIs. A convenience query function, if added, must be visibly implemented as spawn + collect and retain the same accounting and cancellation.

## 5. DSH composition and public-seam proof

### 5.1 Why this is an ordinary tool, not a replacement PTC provider

The published `dsh-tools` implementation retains the owning registry context in its PTC transport; `requirePtcRuntime()` reads that context. Cordis `isolate()` creates a child scope, and `agentPresets.serviceFor()` can explicitly inspect a preset service, but neither changes standard `run_code` lookup. `run_code` is reserved and cannot be registered as an ordinary plugin tool. The internal transport builder is not a public exported integration API.

The selected implementation therefore gives `python_repl` its own KernelProcessOwner. It does not rely on a per-Agent `ptcRuntime` override, import private bridge helpers, or change how unrelated Node PTC Agents run. A future alternative runtime composition is a separate design decision, not a hidden fallback.

### 5.2 Root and descendants

The RLM root is created with a reserved Session identity through public `ctx.agents.create({ sessionId, parentAgent, agentOptions, meta, setup })`. `setup` contributes scoped tools, restrictions, prompt sections and listeners before publication; it never starts inference itself. The root's exact parent is the initiating Agent when one exists. A UI-created root needs its own explicit host authorization context and is not fabricated as another Agent's child.

For descendants, use the configured public in-process spawn provider (the inspected default name is `spawn`) through `ctx.subagents.startActivation`, with a reserved `childId`, actual parent Agent, self-contained prompt, supported model options, depth bound, cancellation and caller delivery. Verify provider capabilities at admission.

Before creation, persist the child reservation and RLM membership. A plugin-owned `agent/created` listener initializes only those reserved identities before the first model request; the public event is awaited while initialization holds input. It applies the same RLM tool/prompt composition and explicitly reapplies restrictions: the official spawn backend does not inherit the parent's Agent-local tool restrictions. Repeated setup must be identity-safe and release only the exact composition it owns. Cold materialization uses the same reservation/membership check.

This is a proposed composition built from inspected public APIs; the keyless integration probe must show that initialization precedes first prompt assembly and that an unrelated child is unaffected. If that probe fails, creation is blocked and the design is revised; no private provider maps are used.

RLM depth is relative to its root; DSH delegation depth is absolute in the session tree. Translate the former into the latter explicitly. Respect the configured host depth/capacity rather than increasing it. If the current host limit cannot support a requested grandchild, report that concrete configuration conflict; never present a depth-1 fallback as full recursive acceptance.

### 5.3 Model calls and token observations

Inference stays in the actual DSH Agent loop. `AgentOptions` carries provider/model/reasoningEffort/maxTokens, not a complete run-budget facility. The plugin adds scoped admission checks around its own child creation and Agent step/request boundaries; it does not claim DSH already supplies a whole-tree call budget.

Reserve logical step/request admission through the public boundaries. Track actual attempt identities when the public assistant-stream event and durable session output expose them; a request-error event alone does not supply an attempt identity. One admitted request can contain adapter retries, and there is no inspected public hook that reserves every internal retry before dispatch. Observed attempts therefore remain a separate accounting dimension and may trigger stopping future admission; they are not a proven hard dispatch cap. Any retry policy used by the existing host remains visible in the run contract. An observer alone cannot enforce a hard monetary cap after dispatch; admission estimates, in-flight reservations, late usage and unknown provider data must be reported separately.

## 6. Prime host bridge: required compatibility surface

All incoming JSON is validated at the process boundary. The Host derives run/node/Agent authority from the kernel binding, not from payload identity fields. The underlying envelope is protocol v3 `host_request {id,data}` with a matching `host_reply {id,data:{status,result/error}}`. Unknown types fail explicitly. No handler can be enabled solely by Python code.

| Prime request/API | Fields and behavior to preserve | DSH/Solar mapping |
|---|---|---|
| `rlm.run` (Python `rlm.spawn`) | `{prompt,kwargs:{name,model?,thinking?}}`; reject unsupported kwargs; return `{rlm_child_id,name,session_dir,model}` after admission | Reserve identity/name/budget durably, start actual DSH child, persist accepted session/message receipt, then return the handle. |
| `rlm.create_session` | `{prompt,kwargs:{name?,model?,thinking?,cwd?}}`; root-only capability; returns live/durable identity, name, session file and resolved model | Create a separately tracked RLM root in the same authorized run group. It shares the initiating authority and budget; it cannot reset depth/call limits by escaping the group. Root-only does not mean unbudgeted. |
| `rlm.find_models` | `{query,limit}`; bounded catalog rows `{provider,id,name,selector}` | Query the effective DSH configured catalog without model inference or testing credentials. Listing is not proof the account has usable quota. |
| `rlm.list_subagents` | Direct child rows with identity, status and optional activity/usage/preview | Use the run's identity mapping and actual public child records; optional missing facts remain absent. |
| `rlm.collect` | Targets by known handle/name/id; timeout >=0; typed snapshots, `settled`, preview/full answer, failure detail | Return exact known results, not synthetic answers. Unknown-effect nodes cause explicit reconciliation status/error rather than being mapped to done. Timeout only ends the waiter. |
| `rlm.progress.note` | Trimmed nonempty message, at most 512 UTF-16 units; accepted/retry-after result; reference throttle about 10 seconds | Durable latest progress plus UI notification; no model request solely to display a status update. |
| `rlm.delete_subagent` | Known direct target; deleted/skipped-running distinction and tombstone result | Keep deletion distinct from cancellation; retain result/usage/effect evidence. Live work is cancelled only through the documented explicit control path. |
| `rlm.rename` | New normalized name; current node or identified direct child; unique sibling names | Change plugin display mapping and record a normal, visible context notice if it affects model-visible identity. Do not require mutation of unrelated session metadata. |
| `agent_message.send` | Direct parent/child/sibling routing or family broadcast; exact delivery/queue receipt | Scope to run-group family. Adjacent messages use public subagent delivery. Sibling/broadcast routing requires a Solar-owned relay, not an existing DSH sibling API: validate the initiating sibling and common parent, persist the original sender and intended recipients, then use authorized parent-to-child public delivery with an explicit relay envelope. Never impersonate the sibling in an adjacent-only call. Per-recipient accepted inbox IDs, partial delivery and cancellation require B4 conformance evidence; no cross-chat/global address lookup. |
| `agent_observe.list/get/recent` | Family-only view; bounded preview; limit 1–50 and max_chars 80–2000 | Read only the mapped family sessions/records. Never load arbitrary private sessions by a supplied path. |
| `bash.completed` / `bash.consumed` | Kernel-owned process notification, exit information and consumption | Persist/withdraw notifications using the kernel's process inventory; claimed PID is not authority to kill an unrelated process. |
| `model.info` | Model identity and actual supported input types | Resolve effective route/capabilities; attach-image support is conditional on real image capability. |
| `factory.progress` | Optional progress notification emitted by pinned Factory code | Support it as an observe-only Solar adapter extension; the inspected default Prime host wiring does not register it, although embedding hosts can add handlers. The operation cannot admit work. |
| `refine.status/run` | Pending state and turn-bound scheduling, local/global flag | Explicit enabled policy; at a quiescent boundary run a separately accounted DSH refinement child, preserve proposed changes/evidence/history and apply only to the allowed plugin-local state. Disabled returns an explicit reason. |
| `compact.status/run` | Retained context information and boundary request | Use a supported official compaction operation if its public seam meets the contract; otherwise report unavailable. Do not emulate compaction by rewriting Session history. It is not a substitute for input externalization. |

Prime path fields are compatibility surfaces with explicit Solar ownership: `session_dir` names the corresponding plugin-owned node directory. `session_file` is a plugin-owned, versioned session-reference file pointing to the real DSH session and its permitted read interface; it is not presented as a Prime transcript or a fabricated private DSH storage path. Consumers that require Prime's file format must fail explicitly. This difference is included in D01 conformance and upgrade notes.

`agent-message`, `agent-observe` and `refine` are separate Python skill packages in the Prime repository; they are not supplied by installing the runtime wheel alone. They must be pinned and included when their APIs are promised. Optional attach-image adds Pillow and uses the public DSH image-content route. General edit/search skills are mapped to existing permitted DSH tools rather than inheriting Prime-specific API keys or auth files.

Prime's direct MCP client normally owns connections and auth refresh. This design instead exports a documented bootstrap facade for programmatic access to the already permitted DSH MCP-backed tools. It must not copy `mcp.config` secrets into the kernel or start duplicate servers. Raw `rlm.mcp` remains unmodified but is not automatically configured; attempts outside the supported facade fail with a named capability error. The mapping and API differences belong in `UPGRADING.md`, and tests must cover false/zero/null tool results. A broader direct-client mode would be a separately reviewed authority/configuration choice.

Prime heartbeat/goal/provider-login requests are not wired into a scheduler or credential store by this plugin. Introspection reports them unavailable rather than pretending a schedule or goal was created. Existing official features can be used through their permitted tools when explicitly requested.

## 7. Runtime ownership, protocol and code execution

One kernel belongs to one exact RLM node/Agent incarnation. A node admits one cell at a time; separate nodes can run independently within actual capacity. Each host launch has a generation identity. Protocol messages from an old generation cannot settle a current cell.

Startup sequence:

1. Verify runtime manifest, file digests, interpreter/platform compatibility and the parent capability binding.
2. Prepare node-owned working/state directories and the selected sandbox policy through public process/sandbox services. Fail if a required enforcement mode cannot be supplied; do not silently retry unconfined.
3. Start the pinned `python -m rlm.repl` as a managed process with a bounded environment and no account credentials.
4. Require the exact protocol-v3 ready handshake, then load the separately authored Solar bootstrap/helper and selected pinned skills.
5. Bind `rlm`, the permitted tool facade, immutable input references, current policy and runtime identity. Validate the callable capabilities before accepting a user cell.
6. Persist startup and bootstrap identities before allowing model-driven effects.

Supply `PRIME_AGENT_CODING_AGENT_DIR`, `RLM_SESSION_DIR`, `RLM_HARNESS_STATE_DIR` and `RLM_GLOBAL_HARNESS_STATE_DIR` explicitly under the plugin namespace. Configure the actual managed owner PID and plugin-owned orphan-process journal for the pinned bash helper; an unconfigured helper does not itself guarantee orphan cleanup. Use an explicit validated shell path. Do not rewrite `HOME` or read/write `~/.prime` by default. Prime's fallback paths must never become the accidental storage location. Global-Harness access remains disabled unless explicitly selected; its directory is outside the kernel's default allowed-write set.

The Solar bootstrap may expose a policy facade around the unmodified runtime object and its helpers. Such adapter overrides are numbered deviations, not silent monkey patches. The actual library files remain byte-for-byte tied to the source pin.

Direct CPython and its bash helper can perform OS operations independently of DSH tool calls. Passing DSH guards on bridged tools is not sufficient confinement for that code. The selected code-execution permission and OS sandbox apply to filesystem/network/subprocess behavior; report their actual enforcement facts separately. The kernel never receives the Host's credential environment. No claim that a Python process alone is a sandbox is permitted.

Protocol handling retains `stdout/stderr/result/display/error/done` attribution. Unattributed raw-fd output stays unattributed. Frame/output caps are enforced before Host allocation grows without bound. Large output is written to an artifact and only a bounded labelled preview is rendered. Prime's protocol/result/snapshot limits are reference facts; operational limits are validated config and must not be silently widened.

Interrupt uses the pinned request semantics, then the managed process owner confirms cleanup if escalation is needed. A completion barrier is separate from stream EOF, a requested interrupt and the task's terminal state.

## 8. Exact input, output and log reconstruction

### 8.1 Input store

Accept explicit file/artifact references and small inline text. Resolve paths against the admitted workspace, apply the real owner's policy, and record size/media type/digest. For reproducibility, copy or materialize a content-addressed immutable input snapshot under the run. A link to a mutable workspace file alone is not a frozen input.

Reject an input changed during snapshotting; do not combine bytes from two versions. Stream large files rather than loading every selected file into Host memory. The first RLM prompt contains names, sizes, media types, digests/handles and access instructions, not the full corpus. User instructions remain visible; external file contents are data, not new authority.

No lossy compression engine is added. Python can slice, parse, search or aggregate exact content. The helper may provide bounded exact reads and deterministic metadata. A model-written summary is an ordinary accounted RLM result and cannot replace its retained original.

### 8.2 Three records, with distinct roles

| Record | Owner | Required content |
|---|---|---|
| DSH Session log | Official Agent loop | Actual prompt sections/schemas, accepted model input, outer `python_repl` call/result and real child requests/results. |
| RLM operation journal | Plugin | Cell/kernel identities, exact bridge arguments/outcomes, admissions/receipts, control changes, checkpoint outcome, result/usage evidence and references to relevant session sequence/attempt identities. |
| Immutable artifacts | Plugin | Full input/output/stream/trace payloads that do not belong inline in the model context. |

The `python_repl` canonical return value is execution-local until its output renderer exposes the required evidence. Always render the visible result and stable trace/artifact references into `content`; UI-only metadata cannot stand in for model-visible logging. The wrapper must persist referenced bytes before returning a pointer.

Nested bridge calls run through `ToolRuntime.execute` with the actual Agent, parent execution token, rootCallId and fused signal. This retains policy but does **not** create official `tool/ptc-dispatch` records. They are represented honestly in the plugin journal, linked from the ordinary outer result. Do not invent official turn/step identifiers, append experimental records, or call private PTC functions.

Child model requests use real DSH Agents, so a child receiving content while the parent cell is still running has its own committed request record. If the parent cell never finishes, its durable start and child links still exist; startup recovery attaches an ordinary recovery notice before any further root model request. No reconstructed record may claim an uncommitted tool result was previously seen.

Acceptance compares a captured test provider's actual request bytes/normalized messages against the official log-derived projection plus the referenced artifact closure. The standard parent transcript alone is not advertised as containing a native PTC event for every nested call.

## 9. Persistent format and one-writer rule

Proposed data layout:

```text
$DSH_HOME/solar/rlm/
  runtimes/<runtimeFingerprint>/          immutable verified runtime payload
  shared-harness/                        opt-in plugin-global state only
  runs/<runId>/
    manifest.json                        RunManifestV1
    journal.jsonl                        ordered OperationEventV1 records
    snapshot.json                        rebuildable journal index + sequence
    inputs/<digest>/...                  immutable input payloads
    artifacts/<digest>/...               full outputs and trace pages
    nodes/<nodeId>/
      kernel-manifest.json
      checkpoints/<generation>/...       payload + Prime manifest + Solar index
      harness/                           run-local retained entries
      agent/settings.json                Prime compatibility switches
```

The first implementation uses a single Host-owned append journal and atomic manifest/index files, not a second graph database or scheduler. One exclusive owner serializes mutations. Each acknowledged effect intent/result is flushed before dependent effects or acknowledgements; indexes are derived from the journal and are replaceable. Artifact temp files are flushed and atomically renamed before journal publication.

| Proposed durable type | Minimum fields |
|---|---|
| `RunManifestV1` | formatVersion, runId/groupId, parent/root Session identity, selected model/profile/config fingerprints, input manifest, source/runtime pins, effective limits, createdAt. |
| `NodeRecordV1` | nodeId, parentNodeId, relativeDepth, DSH Session identity, display name, kernel generation, activity/settlement, resultRef, usage coverage. |
| `OperationEventV1` | formatVersion, monotone sequence, run/node/cell/generation IDs, operation ID, type, inputDigest, attempt identity, intent/admission/settlement stage, exact receipt/payload refs, UTC time. |
| `CheckpointIndexV1` | runtime/interpreter/platform identities, quiescent cell boundary, journal/session positions, payload digests, saved/skipped/pruned/failed names, eligible recovery class. |
| `UsageRowV1` | actual provider/attempt identity, origin node/operation, input/output/cache fields with known/unknown status, pricing source/time if any, measured/estimated distinction. |

Format versions are mandatory. Unknown versions, sequence gaps, corrupt records and partial final records become explicit recovery errors; they are not silently skipped. On a verified dead writer, recovery may acquire the owner lock and classify all unconfirmed effects. A live or ambiguous owner blocks another writer. A stale PID alone is not permission to dispatch again.

Artifacts are capabilities scoped by a server-side run/node ownership map; a digest or path supplied by a model is not authorization. No TTL removes artifacts required by an active run or a reported retained result. Retention of closed runs is an explicit policy; uninstall does not silently delete evidence. Local account data, transcripts outside this plugin's scope and credentials never enter repository artifacts.

## 10. State transitions and unknown effects

Run states: `preparing`, `running`, `paused`, `cancelling`, `completed`, `failed`, `cancelled`, `indeterminate`. “Waiting for model/child/approval/input” is an activity reason, not success. Each accepted control increments a revision; stale controls fail without effects.

- `preparing -> running`: input/runtime/policy verified, root admitted and receipt durable.
- `running -> paused`: stop new cells/children/model-step admission; already-admitted effects are accounted until they settle. A pending pause is shown until the safe boundary is reached.
- `paused -> running`: explicit resume, compatible runtime/config, reconciled receipts and available owner; no implicit restart from a scheduled wakeup.
- any active state `-> cancelling`: stop admission, interrupt owned live work, then wait for confirmed settlement.
- `cancelling -> cancelled`: all effects and process owners are confirmed terminal. Otherwise use `indeterminate`, not an optimistic cancelled label.
- `running -> completed`: root output committed, required descendants/effects settled, final evidence closure intact. Accuracy remains a separate validation claim.
- `-> failed`: a known terminal failure with recorded cause. An unknown external effect remains `indeterminate`.

Operation states: `prepared -> admitted -> settled`, with `rejected-before-admission` or `indeterminate` as explicit alternatives. Stable operation identity is minted and persisted by the Host; Python's host-request UUID is a transport correlation, not sufficient durable idempotency across restart. Repeated identical confirmed operations return their receipt; the same identity with different input fails. A new UUID must not bypass an unresolved earlier cell/effect fence.

When any operation's external effect is unknown, prohibit new effectful work in the affected ownership scope, including Factory retries. Inspection and evidence reconciliation remain available. Ordinary read-only queries may be retried only under their stated idempotency; no whole-cell replay is inferred from that allowance.

## 11. Checkpoints, cold recovery and Factory limits

### 11.1 Quiescent checkpoints

At an eligible cell/turn safe point, request the pinned runtime snapshot, capture its manifest and persist the Solar index. Defaults in the reference runtime are 256 MiB total and 16 MiB per variable; larger or unserializable values may be skipped. Preserve all reported omissions. Never restore pickle/dill inside the Host process; restoration stays inside the same constrained Python runtime class.

On restart, validate exact runtime/interpreter and data versions, load the confirmed journal state, restore an eligible snapshot into a new kernel, reapply the current bootstrap and rebind supported host capabilities. Model-visible recovery information identifies lost variables/handles and any disabled operations. Restoring a saved `RLMSpawnHandle` dataclass does not prove its child is running or its answer exists.

If a snapshot is missing, corrupt, incompatible or incomplete for required computation, return recovery-required evidence; do not replay the earlier cells to “make it work.” The user can authorize a new attempt using confirmed inputs/results after the unresolved effects are settled.

### 11.2 Factory is not cold-durable in the reference

The pinned `FactoryRun` documentation says it is kernel-memory-only. `_DEFAULT_EXECUTOR` holds asyncio tasks, watchers and run state in a module global; the REPL snapshot does not serialize/rebind that executor. Only declarative machine specifications in Harness state are durable. The reference daemon's reseeded child rows are settled ledger projections, not restored live watchers or recovered answers.

Therefore this design supports complete **current Factory behavior**: machine validation/compilation, live execution, joins/foreach/guards, graph/watch and live stop/resume. A cold kernel restart while a Factory run is active yields a visible recovery-required condition and the known child/effect ledger. It never silently resumes that Factory run or invokes its automatic respawn path against uncertain effects. Starting a new Factory run requires reconciled children and an explicit new attempt.

A future durable Factory executor would be an additional implementation beyond the pinned source, with a separate format/upgrade contract. It is not hidden inside the phrase “snapshot support.” Unsupported Prime wait states also remain unsupported and are explicitly rejected.

### 11.3 Host and UI lifetime

UI detachment does not itself cancel a live Host-owned run. A graceful plugin/Host shutdown stops admission, settles/interrupts owned work and records the best confirmed checkpoint. A Host crash fences in-flight operations; an interpreter watchdog/managed process contract must prevent an orphan kernel from indefinitely performing host-dependent work. Machine restart does not imply execution survived.

Re-enabling or reopening a session presents recoverable state and requires a deliberate resume for admitted work. It does not activate a background schedule. Plugin disable awaits owned cleanup; teardown failure is visible and is not converted into successful removal.

## 12. Budgets, model policy and accounting

The run captures model and reasoning choices. Default inheritance uses the actual parent's supported options. Every explicit override is validated against the selected adapter/catalog; no automatic account/model fallback or changes to the user's global model/resource settings.

Configuration separates reference limits from run operating budgets:

| Field family | Proposed rule |
|---|---|
| `maxDepth` | Proposed initial RLM default 2, matching the pinned Prime reference; effective absolute cap must also satisfy the current Host configuration. |
| `maxNodes`, `maxModelRequests`, `maxWallTimeMs` | Required finite values from a named profile or invocation before effectful admission. `maxModelRequests` limits public logical request admission, not hidden adapter retries. No invented performance-optimal defaults. |
| observed model-attempt threshold | Count exposed actual attempts and stop subsequent admission when reached. This is not a hard pre-dispatch cap on adapter retries; a profile requiring such a cap is unsupported until its adapter supplies enforceable evidence. |
| `maxConcurrentModelRequests` | Cannot exceed configured Host capacity; a waiting parent does not reserve an inference permit. Host live-child limits are separate and may reject admission. Adapter-internal concurrency remains governed by the existing adapter. |
| `maxInputBytes`, artifact/storage limits, visible output, cell deadline | Validated finite bounds; complete originals cannot be discarded to conceal exceeding a limit. |
| token limit | Reserve conservatively for in-flight work and record actual usage when supplied; unavailable accounting is explicit. |
| cost limit | Enforce only with a defined pricing/accounting basis; missing price/usage cannot be treated as zero. Reject a claimed hard USD cap that cannot be supported. |
| `factory.enabled` | Default false, as in the source; enabling allows only run-authorized work and does not create periodic automation. |
| local Harness / refine | Local state is a named capability; automatic/model-driven refinement is disabled until selected. Plugin-global writes require explicit selection. |
| MCP/tool exposure | Explicit permitted catalog bound to the live owner; no credentials or unrestricted tool enumeration. |

Differentiate cells, logical model steps, transport attempts, admitted children, actual provider-reported requests, and estimated token counts. Fold usage once by stable provider/attempt identity and preserve cache-read/write fields separately. Account for descendants and any refinement/model-summary call. Unknown billed work remains unknown until reconciled. Neither a stopped waiter nor a root completion message certifies physical quiescence or zero remaining cost.

## 13. Local Harness, prompts and related capabilities

Reuse unmodified `harness.py` for its local data model, history and machine specifications. Store its files inside the run namespace, with explicitly supplied environment paths. Solar adds a policy facade for allowed state locations and global scope. A model-supplied `state_dir` cannot open another Agent's/private application's memory.

Prompt composition is authored for the DSH-hosted capability set and cites the pinned Prime semantics. It names `python_repl`, admission/collect/message behavior, data handles, limits, cancellation and actual unavailable APIs. It must not copy an obsolete instruction claiming only message replies when the selected API also supports typed collection. DSH-owned base rules and user authority remain intact.

Refinement runs only under the explicit capability, at a boundary, as a separately logged/accounted DSH task. Record proposed changes, source evidence, accepted diff, prior snapshot and rollback identity. It may change only the permitted supplemental state, never the immutable base prompt, repository instructions or Codex/global personal memory. No Jev tools, hooks, models or services are enabled.

`rlm.create_session` creates another root only inside an authorized run group and shares its budget/capability ceiling; it cannot be a depth/budget escape. Family broadcast is limited to that group, not every live DSH session. These are explicit rehosting deviations from Prime's global root-family conventions.

## 14. Distribution, dependency closure and package assembly

The target remains macOS arm64. Ubuntu CI can verify TypeScript and platform-independent behavior, but it is not macOS runtime acceptance. No Windows/Linux product support is implied by the upstream runtime's portability.

The package supplies:

- Built ESM `lib/`, `cordis.patch.yml`, icon, English/Chinese locale metadata and UI, README and `UPGRADING.md`.
- The unmodified Prime runtime built from the exact source commit, including `rlm/machines/**/MACHINE.md` package data; selected unmodified skill wheels at the same commit.
- A relocatable pinned macOS arm64 CPython payload and the fully resolved Python dependency closure, including `dill`; no target-machine compiler or resolver is needed.
- A versioned `runtime-manifest.json` with upstream commit, wheel and interpreter digests, dependency versions/hashes/licenses, platform/minimum OS, protocol version and required capabilities.

Assembly happens in the authorized development/build environment, not at plugin install. A market release contains the verified payload as ordinary package files. Activation verifies and atomically extracts a versioned runtime under `$DSH_HOME/solar/rlm/runtimes/<fingerprint>/`; no shell installer, pip/uv resolution, network download or package-manager build hook executes on the user's machine. A corrupt/unsupported capsule is an explicit initialization failure.

Exact CPython patch version, release-asset URL/digest and resolved transitive dependency versions are build-lock outputs still to be selected and verified; this document does not invent them. Implementation task B1 cannot pass until they are fixed and a relocated capsule starts without system Python, uv or user-site packages. Existing app resources are never changed or copied into the plugin.

Prime's Rust bootstrap installs a broader scientific stack and editable skills. That bootstrap is not reused. If NumPy/Pandas/etc. are promised as available capabilities, their exact wheels and licenses must enter the lock and offline acceptance. Otherwise prompts and dependency diagnostics explicitly show they are absent; no automatic installation from a model cell. The pinned MCP helper contains a conditional `httpx2` import that is not declared in the runtime manifest; lock the exercised SDK transport branch and verify its complete closure rather than assuming that the top-level manifest is exhaustive. The direct-client limitation in D04 remains in effect.

Every `@deepseek-ai/*` Host module actually imported by the adapter is a peer dependency plus a test dev dependency. Other JS libraries are ordinary pinned/locked dependencies. Do not bundle a second Cordis/Agent/ToolRuntime instance. Native Resident is optional and is not imported as a runtime dependency for core RLM.

Future source layout (not created by this documentation PR):

```text
incubator/rlm/
  package.json  cordis.patch.yml  README.md  UPGRADING.md
  locale/  icon.svg
  src/index.ts                 registration/lifecycle only
  src/config.ts                validated profiles and limits
  src/tools/                   run/inspect/wait/control/read/python_repl
  src/agents/                  membership, composition, child lifecycle
  src/bridge/                  Prime request validators and handlers
  src/kernel/                  process owner, v3 codec, bootstrap, output
  src/store/                   journal, manifests, artifacts, checkpoints
  src/usage/                   attempt attribution and budget reservations
  src/client/                  public UI extensions and readable result views
  python/solar_rlm/            separately authored thin host/data facade
  runtime-manifest.json        fixed capsule identity
  assets/runtime/              built immutable runtime payload
  tests/                      meaningful unit, process, plugin and recovery cases
```

No copied-and-modified Prime source, workspace patch, installed-package mutation, or official-upstream contribution is part of this plan. A necessary integrated-project override/fork must be explicit, pinned and recorded before it can enter the accepted scope.

## 15. Explicit deviations and unsupported claims

These entries are the initial content requirements for `UPGRADING.md`; review them as part of the design, not after implementation.

| Deviation | Reason | Acceptance requirement |
|---|---|---|
| D01: DSH model/session host replaces Prime Rust host | Official app and existing authentication remain the execution authority | API-by-API spawn/collect/message/lifecycle and real-request logging conformance. |
| D02: Ordinary scoped `python_repl`, visible authorized Host tools and linked journal, not native PTC dispatch records | Public rc.2 lookup/logging/restriction boundaries; native schemas cannot be hidden with execution restrictions while remaining bridge-callable | Request reconstruction test, native/bridge capability parity, nested receipt coverage and no fabricated Session events. |
| D03: Run-group roots/family and bounded global state | Avoid global-session addressing and budget escapes | Cross-run message/state denial, root creation sharing budget, explicit global policy. |
| D04: DSH tool/MCP facade | Reuse live tool authority, authentication and existing server processes | Guards/cancellation/falsy result preservation; no secret transfer or duplicate server. |
| D05: Packaged Python capsule replaces uv/editable bootstrap | Normal plugin installation must be self-contained | Clean target environment/offline relocated execution and payload provenance. |
| D06: Indeterminate effects remain indeterminate after recovery | Prime ledger reseeding can yield settled projections without live answer/watcher recovery | Crash windows never produce a fabricated completed answer or implicit replay. |
| D07: Final artifact helper and immutable input manifests | Required external data/output semantics | Oversized corpus/answer represented without reinserting the whole payload into root context. |
| D08: Factory live resume only; cold interruption explicit | This is the pinned source's actual capability boundary | Restart loses no admitted-effect evidence, but no cold Factory resume is claimed. |
| D09: No calendar/heartbeat/product daemon migration | They are general product capabilities outside this RLM extraction | Disabled capabilities fail clearly; no scheduled or autonomous task is started by enable/install. |

A Node-only rewritten RLM, a simple multi-agent wrapper, or a tool-result compressor does not satisfy this design. If a required public seam cannot meet a row, record the concrete failure and obtain agreement on any material reduction; do not patch Harness.

## 16. Failure vocabulary and UI behavior

The following are **proposed Solar error codes**, not observed errors from an existing plugin:

`RLM_PROTOCOL_UNSUPPORTED`, `RLM_CAPABILITY_UNAVAILABLE`, `RLM_INPUT_CHANGED`, `RLM_BUDGET_EXHAUSTED`, `RLM_ADMISSION_REJECTED`, `RLM_OWNER_UNAVAILABLE`, `RLM_EFFECT_INDETERMINATE`, `RLM_CHECKPOINT_INCOMPLETE`, `RLM_FORMAT_UNSUPPORTED`, `RLM_ARTIFACT_UNAVAILABLE`.

Each error carries a readable explanation, known effect/admission state, related operation/artifact identity and next permitted action. User UI presents the explanation; internal codes remain available in diagnostics. A missing model, exhausted budget or lost Host is not repaired by switching account/model, widening permissions or restarting the task silently.

UI states distinguish preparation, active reasoning, waiting on children/approval, paused, cancelling, confirmed cancelled, completed, failed and outcome unknown. A result page shows source manifest, output references, tree/depth, actual/unknown usage, evidence of requested verification and skipped checks. Tool cards are usable without a custom panel; any panel uses public Client extension points and receives the same versioned view model. Default and narrow widths are required before installed acceptance.

## 17. Acceptance matrix

All rows below are **not run** in this design PR. Source-test inspection is not a passing execution result. The implementation is L3 because it introduces persistent state/effect recovery; its required full gate runs once at the stable fingerprint. This documentation change is checked by source/diff/link consistency only.

| Test ID | Required observable evidence |
|---|---|
| T01 | Built bundle installs through the published rc.2 CLI in a disposable home, registers/disposes its scoped tools once, and leaves unrelated tools/provider state intact. |
| T02 | Source pin/runtime lock/capsule manifest agree; a relocated macOS arm64 payload runs without system Python, uv, pip, user-site packages or dependency network access. |
| T03 | Actual protocol-v3 handshake, cell FIFO, top-level await, functions/imports, output/display limits, malformed frame rejection and per-owner isolation. |
| T04 | Input manifest/digests match frozen data; root request contains metadata rather than full corpus; mutation while snapshotting is rejected. |
| T05 | Model-controlled loop creates distinct children and at least one grandchild. Capture real request tree/receipts/results. A mocked protocol test alone is not the separately authorized real-model evidence. |
| T06 | Spawn receipt is distinct from result; collect timeout returns nonterminal state; empty result/refusal/error/cancelled paths and retained results are explicit. |
| T07 | Parent/child/sibling/broadcast routing, restrictions, progress throttle, rename and delete/tombstone behavior; cross-run identities cannot send/read. |
| T08 | Child composition/restrictions and scoped native tool presentation exist before first request, including after public cold materialization. Inherited PTC/preset settings cannot hide `python_repl` or expose an unintended tool. |
| T09 | Every nested tool passes the actual owner's guards/approval pipeline; native and bridge capability allowlists agree; restricted-away tools fail in both paths; false/0/null/structured/image results retain semantics; no duplicate MCP process or credential copy. |
| T10 | Capture a test provider's requests and reconstruct the same model-visible material from official session records plus durable artifact closure; outer result references survive restart. |
| T11 | Real filesystem/process fault windows around intent, admission, result, checkpoint and manifest writes; partial/corrupt/unknown-version state fails visibly and never duplicates an effect. |
| T12 | Snapshot/restore reports saved/skipped/pruned/failed names; missing state is not called full recovery; restored handle dataclasses are revalidated against the journal. |
| T13 | Factory validation, DAG/state compilation, joins/foreach/guards/limits/graph/watch/live stop-resume; cold interruption becomes recovery-required with reconciled child evidence. |
| T14 | Cancellation before dispatch, during Python sync loop, await, tool approval and background bash; disable/Host shutdown await cleanup or report indeterminate. |
| T15 | Shared node/logical-request/time/token/storage bounds, explicit observed-attempt and internal-retry limitations, no depth escape through create_session, and no parent-waits-for-child capacity deadlock. |
| T16 | Whole-tree usage deduplicates by actual attempt, preserves cache and unknown fields, and does not claim exact cost from estimates or a timed-out waiter. |
| T17 | Final large artifact is assembled from confirmed data, exact readable slices remain available, and computation completion does not imply independent quality acceptance. |
| T18 | Local Harness/refinement scope, history/rollback and explicit disabling; no writes to Codex memories, instructions, unrelated settings or Prime home. |
| T19 | Native tools, if selected, retain their existing ownership/configuration; no RLM claim of native transcript recovery or Native Resident dynamic-node support. |
| T20 | README, UPGRADING, locale metadata and generated homepage guide match actual status; no unpublished plugin is represented as released. |
| T21 | Separately authorized official-app install normal path, enable/disable, readable tool/panel state at default and narrow widths, existing profile backup and data preservation. |
| T22 | Separately authorized release verifies tag/subpackage payload, version, index/homepage and actual installation channel. No app build or distribution artifact. |

Mechanism/efficacy evaluation follows source acceptance, under explicit cost approval. Freeze task inputs, model/effort, prompt, tool access and budgets; compare a direct baseline with Prime-backed RLM using independent grading, quality, wall time/tail, actual complete-tree tokens/cache and available cost. Failed/unknown runs remain visible. No performance claim is derived from the existence of recursion, source tests or Prime's published results.

## 18. Implementation work graph and file ownership

The coordinator records the approved assignment in its chosen shared worklist; this document does not create another task platform or authorize messages to other chats. Loop 1 owns this design and the eventual assigned RLM integration. Each implementation slice uses a dedicated branch/worktree; shared Git, package assembly and acceptance remain serialized.

| Node | Scope / owner boundary | Depends on | Exit evidence |
|---|---|---|---|
| D0 | This design and deviation review | — | Reviewed scope and acceptance; no hidden TinyJuice/native-daemon dependency. |
| B1 | Runtime capsule/manifest and upgrade notes | D0 | Fixed interpreter/dependency hashes, unmodified runtime/skills, offline relocation proof (T02). |
| B2 | `src/kernel/` and `python/solar_rlm/` protocol/data facade | D0, B1 interface | Real local protocol, sandbox/process ownership, streams and interruption (T03/T14). |
| B3 | `src/store/` journal/artifact/checkpoint actor | D0 | Durability/fault/format/ownership fixtures (T04/T11/T12). |
| B4 | `src/agents/` and `src/bridge/` child/family handlers | D0, B2/B3 contracts | Actual keyless DSH root/child composition, API matrix and logged receipts (T06–T10). |
| B5 | Budgets/usage/Factory/local Harness integration | B2–B4 | Limits, no replay, known cold-recovery boundary and complete accounting (T13/T15/T16/T18). |
| B6 | Normal tools/UI/package/docs | B4/B5 views | Usable controls, truthful output, build/package/scratch-profile behavior (T01/T17/T20). |
| V1 | Coordinator integration and independent contract review | B1–B6 | Required L3 source gate once, exact reviewed commit and feature PR. |
| V2 | Real-model mechanism and installed-app acceptance | V1 + separate authority | Real recursive-path evidence; T21; paid budget/accounting recorded. |
| R1 | Plugin release PR/market | Accepted V1/V2 + release authority | T22; separate release-only changes, no behavior fix hidden in release PR. |

B2/B3 and other independent owned slices may proceed concurrently after their input contracts are fixed. Do not split simultaneous writers over the same bridge schema, state format, root lockfile or generated output. A source PR is not an installed or published plugin.

## 19. Decisions and measurable unknowns

The user has selected Prime-only extraction and commissioned plugin construction. This document makes the following concrete design choices for review: ordinary scoped `python_repl`; real DSH-model children; no mandatory Native Resident change; unmodified pinned Prime runtime; plugin-local journal/artifacts; explicit non-replay recovery; offline Python capsule; full required R01–R16 coverage with D01–D09 deviations.

Remaining implementation evidence, not reasons to reopen the whole objective:

1. Prove reserved-child initialization/logging ordering in the actual published Host (B4).
2. Fix the exact interpreter/dependency closure and prove relocation and sandbox enforcement on macOS arm64 (B1/B2).
3. Verify public cold-materialization and message-relay behavior without private manager access (B4).
4. Qualify request-attempt counting/late usage and any configured hard-budget claim against the selected adapters (B5).
5. Confirm UI extension and market tag/subpackage payload behavior at their separately authorized stages (B6/R1).

If any of these requires changing a material accepted behavior, return the exact evidence and options before substituting a reduced implementation. Routine fixes within the reviewed design continue without repeated approval.

## 20. Source map and design verification

Prime permalink base: `https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/`.

| Evidence | Source |
|---|---|
| Runtime protocol and snapshots | [repl.md](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/repl.md), [repl.py](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/repl.py) |
| Python typed host API | [rlm/__init__.py](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/__init__.py) |
| Factory memory-only run state | [factory.py, FactoryRun/FactoryExecutor](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/factory.py#L1453-L1537) |
| Factory gate/library methods | [factory.py](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/factory.py#L3741-L3888) |
| Local/global Harness paths and state | [harness.py](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/harness.py#L127-L191) |
| Rust request handlers and depth | [rlm_host.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/session_engine/rlm_host.rs) |
| Child admission/settlement/reseeding | [host.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_children/host.rs), [lifecycle.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_children/lifecycle.rs), [registry.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_children/registry.rs#L392-L433) |
| Usage/ledger | [rlm_usage.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/session_engine/rlm_usage.rs), [rlm_ledger.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_ledger.rs) |
| Skills and runtime dependencies | [skills](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa77b38facd7c87277fa3c82bcadbe816880/skills), [pyproject.toml](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/pyproject.toml), [bootstrap/venv.rs](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/kernel/bootstrap/venv.rs) |
| Published DSH tools | `@deepseek-ai/dsh-tools@0.2.1-rc.2`: README; `lib/types/index.d.ts` execution/value/policy contract; `lib/index.js` PTC lookup, reserved-name rejection, execute pipeline. |
| Published DSH Agent/subagent | `dsh-agent` create/resume/setup and runtime-types; `dsh-subagent` activation/capabilities/control/child composition; `dsh-subagent-spawn-in-process` README and provider. All at `0.2.1-rc.2`. |
| PTC/preset service boundary | `dsh-agent-preset-registry` README and `serviceFor`; `dsh-ptc-runtime` README; Cordis `4.0.5` isolation/service lookup. |
| Existing project boundaries | [Native contract](../native-plugins-contract.md), [blocked seams](../blocked-seams.md), [development loops](../development-loops.md). |

Design verification: exact source identities and APIs inspected; source test files inspected but not executed; no project implementation modified. The documentation delivery records its actual diff/link/homepage checks and remote PR state separately. Runtime, installation, performance and publication evidence remains explicitly not run.
