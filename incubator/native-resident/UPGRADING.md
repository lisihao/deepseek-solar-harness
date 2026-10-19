# Upgrading native dependencies

## Pins and adapter boundary

`package.json` pins `@openai/codex` to `0.153.4`, `@anthropic-ai/claude-agent-sdk` to `0.3.263`, and the SDK's Zod peer to `4.6.7`. Harness imports are peer/test dependencies pinned to the recorded `upstream.json` baseline. No official Harness or product source is copied, vendored or patched.

- `src/drivers/codex.ts`: published executable entry, app-server initialize, persistent thread start/resume, turn start/interrupt, model catalog and dynamic tool calls.
- `src/drivers/claude.ts`: SDK query/resume/persistSession, supportedModels over an idle input stream, SDK MCP server/tool APIs, cancellation and terminal results.
- `src/bridge.ts`: the owning Agent's public Tool Runtime schemas/execute and scoped policy path.
- `src/index.ts`: public Cordis Service/effect, tool registration and Harness home resolver.
- `src/client.ts`, `src/daemon.ts`, `src/core/engine.ts`: Solar-owned protocol, state, scheduler, lifecycle and recovery. Native-driver compatibility is separate from the daemon protocol and SQLite format versions.

## Upgrade procedure

1. Read the exact candidate product schema/types and changelog before changing a pin. Verify model/effort fields, cancellation terminals, SDK MCP call identity and native permission semantics.
2. Update pins and lockfiles. Build plain-Node output and check that peer dependencies still share the host's modules.
3. Run affected keyless protocol/real SDK MCP/bridge tests and persistence/cancellation regression tests. Test schema mismatch and unknown-outcome paths, not only successful final text.
4. Run the stable full source/plugin gate once. Scratch-profile install must resolve the normal published native payloads; do not copy binaries from an installed app.
5. With separately authorized real-provider and GUI acceptance, test the user-facing installed path in isolated V4 data. Record source tests and live-provider results separately.
6. Change daemon/state protocol versions only for a specified format change with compatible migration or an explicit refusal path. Stop the identified old daemon before switching builds; never force-kill an unverified PID.

## Carried patches

None. The native adapters implement Solar behavior over public product APIs. The unavailable unified-parent-trace seam is documented; it is not implemented through a private upstream patch.
