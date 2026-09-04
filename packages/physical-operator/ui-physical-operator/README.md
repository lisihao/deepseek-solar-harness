# UI Physical Operator

English | [中文](README.zh.md)

This dual-face plugin exposes the daemon-owned Resident physical-operator projection at `/api/resident-operators` and registers the matching browser controls. The Host face accepts read-only GET from loopback owners and paired remote devices. A POST can start native product authentication only from a loopback owner request; remote Frontends receive guidance to authenticate on the Server itself. Claude failures preserve `auth_required`, `network_unavailable`, or `callback_listener_missing` in the browser response. The Client explains that outcome beside the provider and offers an explicit retry button; dashboard refresh never starts a login. The Client face also adds the session-scoped collaboration/model/effort selector to any DSH browser shell. The collaboration popover is positioned against the current viewport and separates frequent controls from TaskGraph advanced scheduling, so a new-session composer does not hide options above the window. Codex and Claude Code render their own live model catalogs, effort wording, and planning/execution strategies. `ChatGPT Web` is shown as an explicit browser-subscription route only: Smart Auto never selects it, and the panel intentionally hides model and effort controls because those choices remain on the ChatGPT website.

The Resident dashboard keeps a compact activity summary and lets the user select a turn to inspect its structured, bounded public trace. It renders public output summaries, tool lifecycle labels, approvals, usage, phase, and terminal status, while excluding prompts, arguments, tool results, stderr, environments, and credentials.

## Authority

- `dsh-resident-operatord` remains the only Session, Receipt, Lease, and Event writer.
- The Host route reads `ctx.residentOperators`; its owner-local authentication action invokes the product flow without copying credentials, prompts, native transcripts, or durable state.
- The Client depends on capability seams and same-origin authenticated HTTP, not on Electron or DSH Desktop.
- Routing changes use logged host commands; the browser panel cannot call the daemon control socket directly.

## Model Experience

None, as the browser projection and execution-policy controls register no model-facing context.

#### KV Cache effect

None from the dashboard. A selected execution policy affects later dispatch only.

## Known Limitations and Deferred Work

- Remote devices expose read-only Resident status; authentication, interrupt, and reset remain trusted owner-local management operations.
