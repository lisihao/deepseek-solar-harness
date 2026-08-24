# UI Orchestration

English | [中文](README.zh.md)

This dual-face plugin exposes the daemon-owned bounded run projection at `/api/orchestrations` and ships the matching browser panel. GET reads run/DAG/event state and marks local acceptance fixtures whose normalized workspace is under `/tmp/dsh-orchestration-*` or `/private/tmp/dsh-orchestration-*` as `diagnostic`. The list includes those retained runs by default; `include_diagnostics=0` hides them without changing storage. A selected `run_id` keeps the complete list while adding its bounded event projection. POST accepts pause, resume, cancel, approval, rejection, and explicit indeterminate resolution only with the control header and a loopback owner or paired remote-device bearer.

## Model Experience

None, as this package serves the human status and control plane.

#### KV Cache effect

None. The browser projection does not enter model history.

## Authority

The orchestration daemon remains the only run writer. This package owns only an authenticated projection and revision-checked human controls; Desktop, browser, and phone clients load the same Client face without importing Electron code.
