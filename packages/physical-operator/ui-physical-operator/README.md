# UI Physical Operator

English | [中文](README.zh.md)

This dual-face plugin exposes the daemon-owned Resident physical-operator projection at `/api/resident-operators` and registers the matching browser controls. The Host face accepts read-only GET from loopback owners and paired remote devices. A POST can start native product authentication only from a loopback owner request; remote Frontends receive guidance to authenticate on the Server itself. Claude failures preserve `auth_required`, `network_unavailable`, or `callback_listener_missing` in the browser response. The Client explains that outcome beside the provider and offers an explicit login action only for `AUTH_MODE_MISMATCH`; version, quota, invalid-result, and runtime failures remain visible without suggesting another login. Dashboard refresh never starts a login. Closed Resident and collaboration controls do not poll provider qualification; opening a panel reads the full projection. The Client face also adds the session-scoped collaboration/model/effort selector to any DSH browser shell. The collaboration popover is positioned against the current viewport and separates frequent controls from TaskGraph advanced scheduling, so a new-session composer does not hide options above the window. Codex and Claude Code render their own live model catalogs, effort wording, and planning/execution strategies. The chip identifies the selected physical primary model or ordinary-model collaboration policy; an RLM preference never claims ownership of a direct message. A selected Codex, Claude Code, or ChatGPT Web model takes precedence over saved collaboration preferences, which guide downstream delegation when the selected primary supports DSH tools. Direct text-only Web mode keeps unsupported coordination controls inactive. Native model and effort controls belong to the selected native product, or to the preferred native collaborator when the primary model is an ordinary provider. Removed model ids and unsupported efforts remain visibly marked until the user chooses a supported value or automatic selection. Browser routes expose no native model or effort control. Debate owns direct messages while enabled, disables inactive collaboration and native profile controls, and offers an explicit exit that restores session routing without promising a particular provider. Only applicable, open native profile panels poll qualification. Command-handler rejection remains a save failure even when transport succeeds, and stops a multi-step mode transition before the next command. Open controls obey the same input lock as their trigger.

TaskGraph strategy controls describe node execution rather than the next chat message. Standard disables RLM and explicit autonomous execution; autonomous execution requires RLM. Debate uses its own fixed strategy, so the saved TaskGraph controls are inactive during Debate. Browser-only primary models cannot invoke TaskGraph tools. Active Plan disables direct Debate selection because that route does not provide the Plan review and exit cycle; the backend also rejects the reverse selection order.

The Resident dashboard keeps a compact activity summary and lets the user select a turn to inspect its structured, bounded public trace. It renders public output summaries, tool lifecycle labels, approvals, usage, phase, and terminal status, while excluding prompts, arguments, tool results, stderr, environments, and credentials.

The panel's CLI versions section reads `/api/resident-operators/cli` when the panel opens and on each explicit update check, showing each native CLI's running and newest published version and whether it is a DSH-managed copy. A newer version offers a verify-and-update action to the loopback owner only; remote Frontends receive guidance to update on the Server. The action reports either activation, effective from the next task without restarting DSH, or a failed DSH qualification that keeps the running version and waits for DSH adaptation. The Codex row states that its update interrupts running Codex work.

When the Host reports tool coordination unavailable (`coordinatorAvailable: false`), the ChatGPT Web section offers only direct questions: it hides the tool-coordination choice, connector status, MCP verification, and connection setup, and points GPT tool work to Codex.

The `Refresh models and operators` button requests fresh API model directories, bypasses the Resident qualification cache, and discovers account-visible Web models and reasoning controls. Each source reports its own success or failure; a failed source retains its last successful list. Refresh never changes the selected primary model, starts authentication, or sends a model prompt. An active Web task makes Web refresh unavailable without preventing the other sources from refreshing. Web model and reasoning preferences use their own verified controls rather than native CLI effort labels. The same native and Web catalogs register as model-menu refresh sources, so the model menu's refresh action refreshes them too; the Host caches keep the fresh values for this panel.

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
