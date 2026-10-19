# Upgrade notes

This package does not vendor or patch an external open-source project. Its execution boundary is the published DeepSeek Harness `0.2.1-rc.2` API surface.

## Pinned host APIs

- `@deepseek-ai/cordis` `4.0.5` supplies `Context`, `ctx.effect()`, and tool lifecycle ownership.
- `@deepseek-ai/dsh-tools` `0.2.1-rc.2` supplies `defineTool` and the public tool execution context.
- `@deepseek-ai/dsh-subagent` `0.2.1-rc.2` supplies `ctx.subagents.startActivation()` and `SubagentActivation.dispose()`.
- `@deepseek-ai/dsh-agent` `0.2.1-rc.2` supplies the type-only parent Agent contract.
- `@deepseek-ai/schemastery` `3.18.5` validates the profile configuration.
- `@lisihao/dsh-solar-native-resident/contracts` protocol `1` is imported type-only. The Resident package is an optional peer and is not a runtime dependency of single mode.

`src/index.ts` is the Cordis bundle entry. `src/dispatch.ts` calls only the public subagent activation seam or `ResidentApi.submit()` and binds an explicit DSH tool allowlist through Resident's public `bindBridge` capability. `src/coordinate.ts` validates TaskGraph DAGs, applies deterministic catalog/profile allocation, materializes prompts, and preserves session/profile/dependency fields. `src/validation.ts` is the input and deterministic handoff boundary. No private provider registry, native credential store, upstream session event, quota ledger, RLM path, or app file is used.

## Upgrade procedure

1. Pin the new published DSH release in `package.json` peer and development dependencies and update the exact tested `engines.dsh` bound.
2. Re-read the published `SubagentActivationSpec` and `ToolRunContext` types. Confirm that the actual parent Agent, caller signal, `delivery: "parent"`, and activation disposal semantics remain available.
3. Re-read the Resident contract and bump its protocol version only with an explicit compatibility decision.
4. Confirm `ResidentApi.models(cwd)` and `bindBridge(bridgeId, owner, allowedTools)` semantics, including the pre-submit bridge binding boundary and the absence of endpoint/token data in graph records.
5. Run the built-bundle scratch-profile test, focused allocation/DAG/bridge/lifecycle tests, strict type check, and the package's lifecycle tests without credentials or model calls.
6. Record any public API change here before changing the adapter. There are no carried patches to reapply.

The official Desktop install path and real provider behavior are separate acceptance checks and are not implied by the source tests.
