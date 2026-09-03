---
name: archify
description: Use the Archify DSH tool to create strict typed-JSON architecture, workflow, sequence, dataflow, and lifecycle diagrams, validate their geometry, deliver standalone HTML, and compare architecture revisions. Use for architecture, system design, API sequence, workflow, data lineage, state-machine, requirements, and review work when a diagram materially improves understanding.
license: MIT
metadata:
  version: "2.16.0"
  dsh_adapter: "2.16.0-dsh.1"
  upstream: "https://github.com/tt-a1i/archify@c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de"
---

# Archify for DSH

Archify is an isolated DSH skill and model tool backed by the exact upstream
v2.16.0 runtime. It supports five diagram types: `architecture`, `workflow`,
`sequence`, `dataflow`, and `lifecycle`. The upstream schemas, renderers,
validators, examples, delta runtime, guides, and tests are vendored unchanged
under `vendor/archify/`.

## When to use it

Use `archify` when a user asks for an architecture/topology, technical
workflow or runbook, API call sequence, data pipeline/lineage, lifecycle/state
machine, requirements map, design review, or architecture comparison. Do not
invoke it for greetings, short factual answers, or prose that is clearer
without a diagram.

## Required authoring sequence

1. Choose one of the five diagram types and author a typed JSON IR object.
2. Call `archify` with `action: "validate"` before delivery. Prefer
   `quality: "showcase"` unless the user explicitly asks for `standard`.
3. Repair only the diagnosed subject when validation reports geometry or
   composition errors. Do not invent repository facts.
4. Call `action: "deliver"` for the final standalone HTML. Return the bounded
   `artifactRef`, `deliveryPath`, and `receiptRef`; do not inline a large HTML
   document.
5. Use `action: "compare"` with `baseInput` and `headInput` only for two
   architecture IR objects. Use `action: "migrate"` for workflow schema v1 to
   v2 when preserving an existing workflow.

## Evidence and safety

`repoRoot` is optional and is only for architecture diagrams that must be
grounded in a real repository. It is never inferred. Tool arguments are
recorded in DSH session logs, so do not include secrets, credentials, or raw
private transcripts in the IR. The DSH adapter runs the pinned local CLI in a
temporary directory, retains only hashes, bounded diagnostics, content-
addressed artifacts, and receipts under `.dsh-archify/`, and never imports or
modifies TaskGraph, Scheduler, Core, or another plugin's state.

For the complete upstream authoring rules and public contract, read the exact
source copy at `vendor/archify/SKILL.md` and the matching schema/example only
when the current diagram requires them. `ARCHIFY-FIDELITY.md` records the
source-to-adapter mapping and every deliberate DSH adaptation.
