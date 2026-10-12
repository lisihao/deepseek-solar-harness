# Agent Note: Remove ChatGPT Web tool coordination

Status: implemented

English | [中文](2026-09-26-remove-chatgpt-web-tool-coordination.zh.md)

## Problem

ChatGPT Web tool coordination let the website model call DSH tools through a ChatGPT Custom MCP connector. It was the most complex ChatGPT Web path: an MCP bridge, tool owners, send receipts, and a `web_session` handoff tool. It never completed an account-backed tool call. The connector reaches DSH from OpenAI's service, so the local endpoint had to be exposed through a tunnel, and automating the ChatGPT website is outside OpenAI's supported interfaces. Codex 0.156.1 offers the GPT-6 models on the same subscription with native, supported tools, which covers the mode's purpose. Desktop 3.20.0 froze the mode behind a default-off `coordinatorEnabled` switch; the frozen code, tests, and fixtures still had to be maintained, and the panel still explained a mode nobody could use.

## Decision

The mode is deleted. `physical-operator-chatgpt-web` registers one operator whose only execution mode is `ephemeral`; it has no MCP bridge, tool owners, coordinated browser session, `web_session` tool, or `@modelcontextprotocol/sdk` dependency. Its `/api/chatgpt-web` route serves only `{ active, catalog?, profile? }` and the `action=profile` selection; every other POST returns `INVALID_WEB_ACTION`. `ChatGptWebModelControls` owns catalog discovery, Session Web preferences, and `model-catalog.json`. The routing panel shows only the Web model and reasoning controls, and a ChatGPT Web primary always disables downstream collaboration and TaskGraph controls. `tool-physical-operator` no longer forwards `chatgpt-web-handoff` messages or Web steering as context.

Released state stays readable. Desktop 3.17.1 through 3.20.x could write the required `chatgpt-web/intent`, `accepted`, and `completed` events and the ignorable `rejected`, `submission-pending`, and `terminal` events; `receipt-events.ts` still declares all six so those Session logs load, and nothing writes them. A pending `resident` Web dispatch in such a log fails through the physical-operator Service's unsupported-mode check. The removed config keys are ignored because the Config schema accepts unknown keys, and a leftover `coordination.json` is never read.

## Alternatives considered

**Keep the mode frozen behind `coordinatorEnabled`.** This is what 3.20.0 shipped. It preserved the bridge and receipt work in case OpenAI offers a supported connector path, but kept roughly six thousand lines of source and tests, a snapshot fixture, and panel text for a mode with no user. A future supported connector would need a new design against its own contract rather than this website-automation bridge.

**Keep it available and finish account acceptance.** This keeps the tunnel exposure and the account risk for a capability Codex already provides.

**Delete the receipt event declarations too.** The persistence read path refuses a log with an unknown required event type, so logs written by released coordinator builds would stop loading.

## Consequences

- Owners who configured tool coordination get direct Web questions; there is no switch that restores the mode.
- ChatGPT Web remains a bounded, text-only direct advisor for website-only models and features.
- The package keeps six Session event declarations that no code writes; they can be dropped only together with an explicit versioned failure for older logs.
- The [ChatGPT Web advisor and coordinator paths](../../rejected/feature/2026-09-23-chatgpt-web-coordination.md) proposal is rejected; its advisor route and catalog refresh remain.
