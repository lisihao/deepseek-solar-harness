# Native collaboration

`@lisihao/dsh-solar-native-collaboration` adds two model-visible tools. `solar_delegate` sends a self-contained handoff to an explicitly chosen official Codex or Claude Code subagent, or submits one node to the optional `solarNativeResident` service. `solar_coordinate` validates a bounded TaskGraph, applies an explicit or advertised native executor/model allocation, and submits the graph to Resident, which remains the only scheduler.

The handoff contains the executor, mode, working directory, declared read/write scope, task, expected result, and requested verification. Resident-only handoffs may also declare a stable `session_key`, a native `profile` (model/reasoning effort), and an explicit non-empty `dsh_tools` allowlist. Single mode rejects those fields because official one-shot providers do not accept arbitrary per-call model or tool overrides. The single-task route calls the published `ctx.subagents.startActivation()` API with the actual parent Agent, the caller's cancellation signal, and `delivery: "parent"`. Its immediate result is an acceptance acknowledgement with the child reference; the official child runtime owns execution, cleanup, and the terminal completion notice. Resident mode does not start a second scheduler or fall back to a one-shot child: it requires the Resident service, submits one `TaskGraph` node, and returns the graph reference for later Resident status/result queries. Submission is not a final success claim.

`solar_coordinate` accepts graph JSON plus optional allocation hints (direct executor/model/effort, named profiles, role mappings, or per-node hints). Node selections take precedence over node profile hints, graph role/profile hints, configured role mappings/profiles, and finally deterministic selection from the Resident model catalog. Automatic assignment fails when the catalog is absent, unavailable, or cannot match the requested executor/model. An explicit executor/model may use that native selection without guessing; an explicit executor alone may use the executor's native default; an explicit reasoning effort must be advertised for the selected model. The policy never changes the DSH main model, account, quota, or provider and does not invent quota signals.

Allocation is a rule-based supported-selection policy. It is not a performance optimizer and does not claim that one advertised executor or model is faster, better, or more effective than another.

## Installed UI entry and acceptance

When the client contribution is installed with this bundle, the normal user entry is the Chinese `智能协同` conversation tab and the matching `智能协同` settings section. The status view reads Resident/tool/provider registration and existing graph state; it does not call a model or discover models. It offers the explicit buttons `测试 Codex（使用订阅额度）` and `测试 Claude Code（使用订阅额度）`. Each button submits one text-only canary in the plugin-owned `$DSH_HOME/solar/native-collaboration/check-workspace`, expects `SOLAR_CODEX_OK` or `SOLAR_CLAUDE_OK`, and supplies no bridged DSH tools. A submission acknowledgement is not a terminal result.

The panel uses the official `--dsw-alias-*` theme tokens for readable text and surfaces in both host themes; it does not define or change the application theme. Machine wait reasons are translated in the ordinary task view.

Use the [Chinese manual acceptance guide](../../docs/native-plugins-acceptance.zh.md) for the entry check, quota boundary, canaries, task inspection, revision-aware controls, and keyless fixture cases. It records the distinction between a UI run and source fixtures; this development bundle has no installed-app acceptance claim until those steps are run and recorded. Do not invent shell commands or treat loading the bundle, a task-list row, or a canary submission receipt as execution success.

When `dsh_tools` is supplied, the Resident service's public `bindBridge` capability receives a stable internal bridge id, the actual calling Agent owner, and exactly that allowlist before graph submission. The bridge id or any endpoint/token is never put in model arguments. Without `dsh_tools`, no DSH tools are exposed to the native graph. RLM and automatic account/model switching are outside this plugin.

The tools do not change the DSH main model, account, reasoning setting, provider selection, or standard subagent configuration. Single-mode per-call model and continuation overrides are rejected; Resident graph allocation is explicit and bounded by the rules above. A scope declaration documents intended paths but is not filesystem isolation; conflicting writes still require a prepared worktree. Missing providers and a missing or incompatible Resident service are surfaced as errors.

## Configuration

The profile patch mounts the bundle with defaults:

```yaml
- id: native-collaboration
  name: '@lisihao/dsh-solar-native-collaboration'
```

The validated `Config` fields are `codexProvider`, `claudeCodeProvider`, `toolName`, `coordinateToolName`, `allocationProfiles`, and `roleMapping`. Defaults are `codex`, `claude-code`, `solar_delegate`, and `solar_coordinate`; allocation maps default to empty. Provider ids identify already registered public services; this package does not register the official providers itself.

The Resident service is optional for loading and for single mode. Resident mode requires a service with protocol version `1` under `solarNativeResident`; it fails explicitly when that service is absent.

## Data and lifecycle

This plugin does not copy credentials, native transcripts, or session history. The official subagent service owns one-shot records and result delivery. The Resident plugin owns its graph records under its own Solar directory. Live activations created by this plugin are tracked so disabling the bundle disposes only those activations; unrelated child work is not interrupted.

## Verification boundary

The source tests cover deterministic validation, handoff, allocation, official activation call doubles, cancellation, missing-service and lifecycle cleanup. The cross-plugin integration tests use the real Resident engine, loopback bridge and published DSH Tool Runtime with fake native execution; they verify the complete calling context and a single tool effect. They do not log in, call a model, install into the official Desktop app, or establish installed-app acceptance. Build and scratch-profile checks use the published DSH `0.2.1-rc.2` packages and the built `lib/` entry.
