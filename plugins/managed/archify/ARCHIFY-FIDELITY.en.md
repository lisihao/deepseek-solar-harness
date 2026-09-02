# Archify v2.16.0 → DSH fidelity matrix

## Pinned source

The adapter uses `https://github.com/tt-a1i/archify` tag `v2.16.0`, commit `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`. The user-provided `citrolabs/archify` URL is not an available GitHub source at implementation time; it was not invented as provenance. The exact upstream directory is `vendor/archify/`; its 190-file tree digest and license are in [SOURCE-LOCK.json](SOURCE-LOCK.json).

## Matrix

| Upstream capability/contract | Upstream evidence at v2.16.0 | DSH implementation | Status |
| --- | --- | --- | --- |
| Five diagram types | `schemas/`, `renderers/`, and `examples/`: architecture/workflow/sequence/dataflow/lifecycle | `types.ts` mirrors only the enum; the exact vendored CLI performs the work | faithful |
| Typed JSON IR and strict validation | Five schemas, `schemas/common.schema.json`, generated validators, strict additional properties | `input` is written to a temporary file; upstream validators remain authoritative | faithful |
| Architecture renderer | `renderers/architecture/render-architecture.mjs` | `render architecture`; returns an artifact hash | faithful |
| Workflow renderer | `renderers/workflow/render-workflow.mjs` | `render workflow`; returns an artifact hash | faithful |
| Sequence renderer | `renderers/sequence/render-sequence.mjs` | `render sequence`; returns an artifact hash | faithful |
| Dataflow renderer | `renderers/dataflow/render-dataflow.mjs` | `render dataflow`; returns an artifact hash | faithful |
| Lifecycle renderer | `renderers/lifecycle/render-lifecycle.mjs` | `render lifecycle`; returns an artifact hash | faithful |
| `validate` | CLI `validate`: schema, renderer, artifact/composition checks, JSON and layout JSON | Passes type/quality/repoRoot and returns bounded response/diagnostics | faithful |
| `deliver` | CLI freezes spec, atomically commits HTML, checks artifact, and emits upstream receipt | Adapter owns a temporary target; successful HTML is written to DSH CAS and a named workspace projection | compatible adapter |
| `compare` | `delta/architecture-delta.mjs`, architecture only, HTML plus sidecar receipt | Two IR objects are temporary files; exact `compare --json` runs and both HTML/upstream receipt are retained in CAS | faithful |
| Workflow v1→v2 migration | CLI `migrate workflow ... --to-schema 2 --json` | `migrate`; migrated JSON is a CAS `json` artifact | faithful |
| `inspect` | Architecture `--layout-json` command | `inspect` action | faithful |
| `guide` | Scenario guide with JSON and language options | `guide` action | faithful |
| `doctor` | Runtime completeness check | `doctor` action | faithful |
| `visual-check` | Visual checker over an existing HTML file | `htmlPath` is constrained to the artifact root | compatible adapter |
| `brands` / explicit capture | Catalog query and `brands capture <url>` | `query`; `captureUrl` executes only when explicitly supplied | compatible adapter |
| `preview` / `--open` | Interactive preview/open behavior | Not exposed as a model tool; DSH returns refs and a UI/CLI may call the vendored runtime separately | deliberate omission |
| `check` | Upstream final artifact checker | Upstream command path is used by the render/deliver workflow; `visual-check` remains available | compatible adapter |
| Source evidence | Architecture `--repo-root` with commit-pinned evidence | `repoRoot` is explicit and never inferred | faithful boundary |
| Receipts | Upstream deliver/compare receipts | Adapter adds a content-addressed receipt for input hashes, command status, artifact refs, and bounded diagnostics | compatible extension |
| Process boundary | The upstream CLI requires a Node process and no shell semantics | Starts explicit argv through injected `ctx.subprocess`, propagating cancellation/timeouts and collecting bounded output | compatible adapter |
| Runtime dependencies | Upstream manifest's `ajv`, `parse5`, `saxes`, and `simple-icons` | Plugin `dependencies` declare them so an independent tarball does not depend on host hoisting | faithful packaging |
| Skill authoring policy | Exact source `vendor/archify/SKILL.md` | Root `SKILL.md` is a DSH-facing adapter with validate→deliver and ref rules; exact source remains vendored | compatible adapter |
| License/notices | Upstream `LICENSE` and `skill-release.json`, plus brand notices | Plugin includes MIT license/notice and the exact upstream license | faithful |

## DSH boundaries

| Constraint | Verification |
| --- | --- |
| No TaskGraph/Scheduler/Core coupling | Adapter imports only Cordis, `dsh-tools`, `dsh-session`, `systemPrompt`, and the `ctx.subprocess` seam; `src` has no orchestration/TaskGraph import |
| No copied renderer/validator implementation | `runner.ts` only starts `vendor/archify/bin/archify.mjs`; the upstream runtime renders all five types |
| Large results stay out of the model response | Return values are bounded summaries, CAS `artifactRef`, and `receiptRef`; HTML is not inlined |
| No raw prompts/secrets persisted | Receipts contain canonical input hashes and bounded process output; temporary input directories are removed in `finally` |
| Controlled paths | `outputName` is one safe filename; `visual-check` `htmlPath` must be inside the artifact root |
| Cancellation propagation | Injected `ctx.subprocess` receives `ToolRunContext.signal` and owns tree termination; there is no automatic retry or silent downgrade |

## Conclusion

For the five-diagram CLI/runtime/schema core of Archify v2.16.0 this is a **faithful vendored runtime + compatible DSH adapter**. `preview/--open` is an explicit omission from the first model-tool surface, not a claim that every upstream interactive interface is already wired into DSH.
