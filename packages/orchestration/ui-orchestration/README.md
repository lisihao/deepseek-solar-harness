# UI Orchestration

English | [中文](README.zh.md)

This trusted Host Consumer exposes the daemon-owned bounded run projection at `/api/orchestrations`. GET reads run/DAG/event state. POST accepts pause, resume, cancel, approval, rejection, and explicit indeterminate resolution only with the same-origin control header used by the Desktop panel.

## Model Experience

None, as this package serves the human status and control plane.

#### KV Cache effect

None. The browser projection does not enter model history.

## Known Limitations and Deferred Work

- The package owns the Host projection; DSH Desktop owns the current React presentation. A reusable browser Client may be extracted when another product consumes the same view.
