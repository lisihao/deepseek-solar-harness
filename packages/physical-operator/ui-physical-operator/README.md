# UI Physical Operator

English | [中文](README.zh.md)

This dual-face plugin exposes the daemon-owned Resident physical-operator projection at `/api/resident-operators` and registers the matching browser controls. The Host face accepts loopback owner requests and paired remote-device bearers, serves GET only, and never writes Resident state. The Client face adds the Resident status panel and the session-scoped collaboration/model/effort selector to any DSH browser shell.

## Authority

- `dsh-resident-operatord` remains the only Session, Receipt, Lease, and Event writer.
- The Host route reads `ctx.residentOperators`; it does not copy prompts, native transcripts, or durable state.
- The Client depends on capability seams and same-origin authenticated HTTP, not on Electron or DSH Desktop.
- Routing changes use logged host commands; the browser panel cannot call the daemon control socket directly.

## Model Experience

The selector changes the host-owned execution policy for subsequent turns. The bounded dashboard projection is not copied into model history.

#### KV Cache effect

None from the dashboard. A selected execution policy affects later dispatch only.
