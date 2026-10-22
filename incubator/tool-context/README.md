# Solar on-demand tool context

This preview plugin changes the descriptions presented to a TypeScript PTC agent in official DeepSeek Harness `0.2.1-rc.2`. It does not remove registered tools, change caller restrictions, replace dispatch, disable plugins, or process historical tool results/memory injections.

## How it works

The initial `tools:sdk` contains two helpers and a short discovery instruction, rather than every installed tool's complete declaration:

1. `solar_tool_search({ query, offset? })` searches the caller-visible names and descriptions. Results include exact names, short descriptions, declaration hashes, and `nextOffset` when another page exists.
2. `solar_tool_load({ names })` selects complete declarations for the next request. It never runs the selected business tools or grants permission. A known exact name can be loaded without searching.
3. The agent reads the complete argument/output schemas and calls the original `tools.<name>` binding through `run_code`. Existing guards, approvals, cancellation, and logging still apply. A permitted tool remains callable even when its declaration is not selected.

Loading keeps the most recently requested declarations within the configured count/byte budgets. Evictions remove descriptions only and are reported in the receipt. Request fewer declarations, or adjust the plugin budget, if a requested group cannot fit; schemas are never truncated.

Selection receipts use standard successful `tool/ptc-dispatch` records. Recovery uses the public session query service. Invalid, error, foreign-session, or changed-registry receipts cannot select stale declarations. A failed durability confirmation stops request admission. The official loop logs the assembled system prompt and normalizes previous system-prompt nodes when the SDK changes; original log records remain available.

Native tool presentation is unchanged. Python/custom SDK renderers, non-agent scoped PTC assemblies, hidden discovery helpers, and complete-system-prompt compositions are unsupported and produce named diagnostics. No private registry or runtime mutation is used. Disable this plugin to restore ordinary tool presentation.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `maxResults` | 8 | Search matches per page; range 1–20. |
| `maxDescriptionChars` | 240 | Unicode characters per search description; range 40–500. |
| `maxSearchBytes` | 8192 | Maximum UTF-8 JSON search response; range 1024–32768. |
| `maxLoadedTools` | 16 | Selected business-tool declarations; range 1–64. |
| `maxLoadedBytes` | 32768 | Complete selected SDK including discovery helpers; range 8192–262144. |

The bootstrap is independently limited to 8192 UTF-8 bytes. These are byte/description bounds, not provider token measurements.

## Data and verification

The plugin has no authoritative private data store. Selection and the model-visible prompt are reconstructable from normal session logs. In-memory state is disposable. It does not delete or rewrite historical tool results, memory messages, credentials, or plugin settings.

The phase-1 contract and verification boundary are in [the task contract](../../docs/tool-context-contract.md). Tests use published AgentLoop/ToolRuntime with synthetic tools and fake adapters; no real provider requests are needed. Source checks, scratch-profile acceptance, installed file verification, and installed-Host acceptance are recorded separately at delivery. Fake-adapter results do not establish real-model tool-choice accuracy or representative-task savings.
