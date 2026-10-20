# Extension-point limits

## Unified parent-session native-tool trace

The published rc.2 `ToolRuntime.execute()` runs the ordinary guards/policies and emits `tools/result`, but it does not itself append a complete native call/result pair to the parent Session. Those standard events require Agent-loop-owned turn/step/source identities. External plugins must not call the experimental-only `appendPluginRecord()` or invent loop identities.

The supported implementation keeps the native tool catalog and exact call inputs/results in the Resident native-session journal, with durable effect receipts, and routes execution through the actual parent Agent's Tool Runtime. Parent submit/inspect calls retain their normal logs. This does not claim a complete native trace in the DSH parent transcript. A unified parent projection would need a public external-execution logging seam. No issue or PR has been submitted.

## Third-party automatic search composition

The reviewed subscription plugin replaces a private search registry. A new Solar wrapper cannot repair that by mutating the same private field. The integration plan describes a public registration plus explicit selection correction, or a future supported composition seam. Current installed third-party software is untouched by the two-plugin development.

## Tools after Host shutdown

Native-only tasks can be independent of a disposable Host connection. DSH tool callbacks still need their owning live Agent and Host. A missing bridge prevents admission or returns an explicit transport failure; an uncertain tool effect is fenced. Keeping the daemon alive is not proof that stopped Host tools remain available.

## V3 ChatGPT Web host integration

The official rc.2 browser-use registry does not provide V3 `ctx.browser.runProgram()`, named workspaces, physical-operator/model-worker registries, or the V3 primary-model menu hooks. The independent ChatGPT Web bundle therefore owns a thin Ego Lite public TaskSpace/Page adapter, its public subagent provider/tool, and conversation/settings entries. It does not reintroduce these private host services or patch the main model menu. The text-task path is being extracted; a faithful V3 main-Agent model route is not claimed. Explicit model/effort selection belongs to the plugin's webpage adapter and is verified against current visible controls.
