# DSH Archify plugin

[中文](README.md)

This isolated managed DSH plugin exposes [Archify v2.16.0](https://github.com/tt-a1i/archify/tree/v2.16.0) as the model-facing `archify` tool. The upstream five typed JSON IR contracts, renderers, strict validators, geometry diagnostics, Architecture Delta runtime, migration tool, guides, examples, and tests are vendored unchanged. DSH adds only an adapter; Archify business code is not placed in Core, TaskGraph, or Scheduler.

Pinned source:

```text
repository https://github.com/tt-a1i/archify
tag        v2.16.0
commit     c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de
license    MIT
```

## Actions

| action | purpose |
| --- | --- |
| `render` | Render a typed JSON IR object to HTML for architecture/workflow/sequence/dataflow/lifecycle |
| `validate` | Run the upstream schema, render, artifact, and composition checks with structured diagnostics |
| `deliver` | Atomically create final HTML and write a content-addressed artifact, named delivery, and receipt |
| `compare` | Run Architecture Delta over two architecture IR objects and produce HTML plus the upstream receipt |
| `inspect` | Return architecture layout JSON |
| `migrate` | Migrate workflow schema v1 to v2 using the upstream migration runtime |
| `guide` / `doctor` | Return upstream authoring guidance or validate the vendored runtime |
| `visual-check` | Run the upstream visual checker against an HTML file inside the artifact root |
| `examples` / `brands` | Query upstream examples or the brand catalog; `brands capture` requires an explicit user URL |

The tool accepts JSON IR through `input`, `baseInput`, and `headInput`; the model does not need to create temporary files. The adapter writes temporary inputs and invokes the exact pinned `vendor/archify/bin/archify.mjs`, preserving IR semantics.

## Execution boundary

The adapter receives DSH's `ctx.subprocess` seam and starts Node with an explicit argv, `stdin: ignore`, and bounded stdout/stderr collection. It never invokes a shell or imports the host `child_process` module. Tool cancellation terminates the DSH-managed process tree; timeouts and non-zero exits remain failures. The profile must provide `@deepseek-ai/dsh-subprocess`; the plugin does not rely on an accidental host hoist. Archify's `ajv`, `parse5`, `saxes`, and `simple-icons` runtime dependencies are declared in the plugin manifest.

## Artifacts and receipts

The default per-workspace root is `.dsh-archify/`; `artifactRoot` may override it. Directories are `0700` and files are `0600`:

```text
.dsh-archify/
├── artifacts/sha256/<digest>   # HTML, migrated JSON, or adapter receipt
└── deliveries/<name>.html      # named projection from deliver
```

Results are bounded: they return summaries, limited diagnostics, `artifactRef`, `deliveryPath`, compare's `upstreamReceiptRef`, and `receiptRef`. A receipt records action/type, upstream commit, input hashes, exit status, bounded stdout/stderr, artifact hashes, and diagnostics. Raw prompts and full HTML are not copied into session events, and the adapter does not duplicate DSH orchestration state.

## Installation

Install a prebuilt tarball into a DSH profile:

```sh
npm pack
dsh plugin --profile <profile> add ./deepseek-ai-dsh-archify-2.16.0-dsh.1.tgz
dsh --profile <profile> --dump-config | grep archify
```

`cordis.patch.yml` adds the `archify` row to the profile. A local mount is suitable for development; release distribution should use a fixed tarball. See [SOURCE-LOCK.json](SOURCE-LOCK.json) for provenance and tree digest, and [ARCHIFY-FIDELITY.en.md](ARCHIFY-FIDELITY.en.md) for the itemized fidelity matrix.

## Model usage policy

The plugin adds system-prompt guidance for architecture, design, requirements, and review agents: when a diagram materially helps, author typed IR, validate it, then deliver it. It does not force diagrams for ordinary conversation and never treats a tool invocation as a successful delivery without checking `ok`, diagnostics, and the receipt.

## Verification

```sh
npm run typecheck
npm test
npm run build
node vendor/archify/bin/archify.mjs doctor
```

The [fidelity matrix](ARCHIFY-FIDELITY.en.md) also requires a real `validate --json` run for one example of each diagram type and clearly separates the exact vendored runtime from DSH adapter behavior.

## License

The adapter and upstream Archify are MIT licensed. Upstream notices and brand-mark disclosures are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
