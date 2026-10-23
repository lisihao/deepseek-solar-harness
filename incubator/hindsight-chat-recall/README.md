# Hindsight chat recall

Unreleased plugin for official Harness rc.2 and the installed Mnemon 0.5.32 service. Before a normal root Agent request, search its registered workspace's active Hindsight memory and append bounded quoted evidence as a standard logged message. No cross-turn result cache; a changed topic or repeated question in another turn gets a fresh read. Tool-only continuations do not search again.

Project isolation requires Mnemon `storageScope=workspaces`; installation acceptance checks that live setting. The plugin follows the existing Mnemon routing policy and does not turn global storage into isolated storage. This repair covers ordinary chat; independent third-party hooks that discard request-series metadata are outside this plugin's control.

Configuration: `timeoutMs` (default 60000), `resultLimit` (default 2), `maxContextCharacters` (default 12000). Timeout, cancellation and disposal reject late evidence. Retrieval errors are explicit and prevent dispatch of that request; the plugin does not silently claim memory was read. Workspaces with no active Hindsight remain unchanged. Only Hindsight results are injected; Native thresholds and original scores are not changed.

The plugin writes no files or custom session events and calls no generation or mutation API. Existing project connections, scoring adapter and localhost Hindsight service remain separately installed. Normal search is the existing `mnemonRemote.read` path. No new credentials or endpoint configuration.

Use `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:plugin`. The source checks passed with 11 tests. The official-CLI scratch-profile test installed the packed built plugin under plain Node and drove a real AgentLoop against a fake adapter: absent before install, alpha evidence on the first request, fresh beta evidence after the topic changed, no dispatch after a search that ignored abort timed out, and absent again after removal. It also checked preservation of request-series metadata received by this plugin. No live model was called.

Source/scratch, installed fake-provider and actual provider acceptance are separate stages. Real model probes require cost approval. No installed acceptance is claimed yet.
