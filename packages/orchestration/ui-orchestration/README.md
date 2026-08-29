# UI Orchestration

English | [中文](README.zh.md)

This dual-face plugin exposes the daemon-owned bounded run projection at `/api/orchestrations` and ships the matching browser panel. GET reads run/DAG/event state and marks local acceptance fixtures whose normalized workspace is under `/tmp/dsh-orchestration-*` or `/private/tmp/dsh-orchestration-*` as `diagnostic`. The list includes those retained runs by default; `include_diagnostics=0` hides them without changing storage. A selected `run_id` keeps the complete list while adding its bounded event projection. Supplying that `run_id` with one of its node `evidence_ref` values returns the complete digest-verified Evidence only on demand. POST accepts pause, resume, cancel, approval, rejection, and explicit indeterminate resolution only with the control header and a loopback owner or paired remote-device bearer.

`/api/orchestrations/rlm-agents` is the versioned v1 projection for the Prime RLM Agents View. It lists session and child lifecycle plus message-delivery metadata; task text, message bodies, command ids, lease ids, artifact references, and delivery errors remain in the Host. A trusted loopback owner or paired `admin`/`cockpit` device may POST `attach`, `input`, or `detach`. The Host keeps the opaque Runtime lease and calls `ctx.rlmRuntime`, so the browser neither receives a lease credential nor decides ownership. The Trace renders planning/verification and execution preferences independently: users can choose adaptive Codex Luna/Terra with Sol gates, Claude Sonnet with Opus/Fable gates, or provider-neutral scoring.

## Authority

The orchestration daemon remains the only run writer. This package owns only an authenticated projection and revision-checked human controls; Desktop, browser, and phone clients load the same Client face without importing Electron code.

## Model Experience

None, as this package serves the human status and control plane.

#### KV Cache effect

None. The browser projection does not enter model history.

## Known Limitations and Deferred Work

- The first release refreshes bounded snapshots over authenticated HTTP; cursor-based live event streaming remains deferred.
