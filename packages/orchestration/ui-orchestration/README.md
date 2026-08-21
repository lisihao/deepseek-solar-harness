# UI Orchestration

English | [中文](README.zh.md)

This trusted Host Consumer exposes the daemon-owned bounded run projection at `/api/orchestrations`. GET reads run/DAG/event state and marks local acceptance fixtures whose normalized workspace is under `/tmp/dsh-orchestration-*` or `/private/tmp/dsh-orchestration-*` as `diagnostic`. The list includes those retained runs by default; `include_diagnostics=0` hides them without changing storage. A selected `run_id` keeps the complete list while adding its bounded event projection. POST accepts pause, resume, cancel, approval, rejection, and explicit indeterminate resolution only with the same-origin control header used by the Desktop panel.

## Model Experience

None, as this package serves the human status and control plane.

#### KV Cache effect

None. The browser projection does not enter model history.

## Known Limitations and Deferred Work

- The package owns the Host projection; DSH Desktop owns the current React presentation. A reusable browser Client may be extracted when another product consumes the same view.
