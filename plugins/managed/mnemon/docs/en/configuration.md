# Configuration Reference

[简体中文](../zh-CN/configuration.md) | **English** | [Documentation Center](./README.md)

## Configuration Location and Activation

The plugin registers the `mnemon` namespace with the DSH settings service. User configuration is stored in:

```text
$DSH_HOME/settings.yaml
```

The default is commonly `~/.dsh/settings.yaml`. All current settings are marked `live`; after Save, the Host initializes a candidate runtime graph and then switches to it atomically.

The Web settings page edits `displayMode`, `storageScope`, `dataDir`, the background task Agent model route, and the Turn memory and Save-to-memory switches under `mnemon-ui`. Global and Workspace define the scope of the complete three-tier system. Mnemon Native owns its Custom data location and ZIP backup/migration controls. Each external provider has a collapsible service configuration for reusable endpoints, credentials, or executables. Enabling or saving it discovers the provider's existing namespaces and maps them into Memory Spaces → Overview; disabling it removes those local mappings without deleting provider data. Other advanced settings must be changed directly in YAML.

## Complete Example

```yaml
mnemon:
  displayMode: sidebar # sidebar | buildin
  storageScope: global # global | workspace | custom
  # dataDir: ~/mnemon-data       # required for custom
  # cliPath: /opt/homebrew/bin/mnemon
  # store: legacy-store          # compatibility discovery hint, not a regular routing target
  timeoutMs: 10000
  defaultRecallLimit: 10
  recallQuality:
    policy: strict-v1
    lowScoreThreshold: 0.25
    highScoreThreshold: 0.6
    candidateMultiplier: 3
    maxMediumResults: 4
    maxUnknownResults: 2
  routingGuidance: true
  lifecycleEnabled: true
  recallMode: guided
  writebackMode: guided
  idleReviewMs: 30000
  tabEnabled: true
  writeEnabled: true
  taskAgentModel:
    mode: inherit # inherit | fixed
    # provider: deepseek # required for fixed
    # model: deepseek-chat # required for fixed
  remoteAccess: read-only # read-only | trusted-host
```

## Options

| Setting | Default | Range | Implementation Semantics |
|---|---:|---|---|
| `displayMode` | `sidebar` | `sidebar` / `buildin` | `sidebar` mounts the dedicated sidebar workbench; `buildin` restores the native DSH conversation-area tab; saving switches live and never mounts both entries together |
| `storageScope` | `global` | `global` / `workspace` / `custom` | Controls the root for Runtime, Documents, Memory Spaces, and reserved state as one unit |
| `dataDir` | unset | absolute path, `~`, or `~/...` | Required for `custom`; legacy configurations that set only this option automatically resolve to `custom` |
| `cliPath` | auto-discovered | executable path | Explicitly selects the Mnemon CLI |
| `store` | unset | `[A-Za-z0-9][A-Za-z0-9_-]*` | Compatibility discovery/preference hint for legacy Stores; semantic operations are routed through Memory Spaces |
| `timeoutMs` | `10000` | 100–120000 ms | Hard timeout for a single CLI call |
| `defaultRecallLimit` | `10` | 1–50 | Default recall count for the service and UI; individual entry points may impose a lower limit |
| `recallQuality.policy` | `strict-v1` | registered policy id | Deterministic policy applied before recall content is serialized to an Agent or client |
| `recallQuality.lowScoreThreshold` | `0.25` | 0–1, below high threshold | Normalized scores below this boundary are removed by `strict-v1` |
| `recallQuality.highScoreThreshold` | `0.6` | 0–1, above low threshold | Retained normalized scores at or above this boundary are labeled high relevance |
| `recallQuality.candidateMultiplier` | `3` | 1–5 | Expands each Provider request before filtering, capped by the service limit of 50 candidates |
| `recallQuality.maxMediumResults` | `4` | 0–50 | Maximum medium-relevance rows admitted by `strict-v1` after all high-relevance rows |
| `recallQuality.maxUnknownResults` | `2` | 0–50 | Maximum unscored or unknown-scale rows admitted by `strict-v1` after scored evidence |
| `routingGuidance` | `true` | boolean | Whether to register an additional tiered-routing system section |
| `lifecycleEnabled` | `true` | boolean | Whether to enable the pre-step cue and score-based background review |
| `recallMode` | `guided` | `guided` / `off` | Whether to inject an on-demand recall cue; does not remove explicit recall |
| `writebackMode` | `guided` | `guided` / `off` | Whether to inject the hot-memory cue and enable score-based background review; does not remove explicit writes |
| `idleReviewMs` | `30000` | 5000–600000 ms | Required continuous idle time after the threshold is reached |
| `tabEnabled` | `true` | boolean | Whether to mount the Web entry selected by `displayMode`; Host RPC, commands, and Agent tools remain registered when off |
| `writeEnabled` | `true` | boolean | Whether to expose semantic write tools, write RPC, and write commands |
| `taskAgentModel` | `{ mode: inherit }` | `inherit` / `fixed` | Model route for independent task Agents used by AI metadata, Agent Query, memory distillation, document archiving, and the idle checkpoint review subagent; `fixed` requires both `provider` and `model` and also pins every Mnemon subagent delegation (recall, write, answer, provider placement, migration, compaction, document archive, metadata maintenance) to the same route |
| `remoteAccess` | `read-only` | `read-only` / `trusted-host` | Whether non-loopback Web pages stay read-only or may use every Mnemon management RPC; this startup authority must be changed locally and requires a Host restart |
| `mnemon-ui.turnBar` | `true` | boolean | Turn-tail memory activity bar; on by default, **applies live after saving** |
| `mnemon-ui.saveAction` | `true` | boolean | “Save to memory” icon and confirmation on finalized assistant replies; on by default, **applies live after saving** |

Both the `mnemon` Host/storage namespace and the `mnemon-ui` browser-presentation namespace apply live. The storage root switches atomically only after the new runtime graph initializes successfully. Legacy `mnemon.conversationInteraction` values remain a migration default, but new saves write only to `mnemon-ui`.

### Recall quality policies

`strict-v1` is the Agent-safe default: for Providers that explicitly declare a normalized 0–1 relevance score, non-positive and below-threshold rows are removed before their content reaches an Agent. It then returns every high-relevance row up to the requested limit, at most four medium-relevance rows, and at most two unscored or unknown-scale rows by default; it does not fill the result limit with weaker evidence. `balanced-v1` retains low-score rows only after primary evidence, and `exhaustive-v1` preserves finite scored rows for direct inspection. An out-of-range score is treated as unknown-scale instead of being fabricated into a confidence value. Cross-provider ordering continues to use reciprocal-rank fusion.

Policies are pure, bounded host extensions. A plugin may call `registerRecallQualityPolicy(policy)` before the runtime graph is constructed, then select that policy id in configuration. Invalid limits, decisions, or selections fall back to `strict-v1`; an unknown configured id rejects the candidate runtime graph. Filtering counts are returned as structured `source.quality` statistics and are not appended to Agent hints.

`remoteAccess` is the sole startup-time security boundary and cannot be changed through the Web settings bridge. With the default `read-only` mode, a trusted remote authority can read and use the narrow Memory Space activation channel; settings, ZIP backups, provider connections, and all broader mutations remain loopback-only. If the deployment already has reliable authentication at its reverse proxy, opt in from the Host's local configuration:

```yaml
mnemon:
  remoteAccess: trusted-host
```

Then restart the DSH Host. DSH Connection must also list the serving authority (for example, `rsi.griv.dev`) in `trustedHosts`, and the page must remain same-origin. `trustedHosts` verifies that a request targets an expected Host; it is not user authentication. Never enable this mode on an unauthenticated public endpoint. When enabled, `/dsh-mnemon-write`, `/dsh-mnemon-settings`, and `/dsh-mnemon-pack` are promoted together so the remote management UI does not fail partially with 403 responses.

## Storage Scopes

### `global`

```text
MNEMON_DATA_DIR when non-empty
  otherwise ~/.mnemon
```

Suitable for users who want Runtime, Documents, and Memory Spaces shared across multiple workspaces. Other Mnemon-enabled agents can also share the Mnemon Memory Spaces when they use the same root.

### `workspace`

```text
Agent / tool / lifecycle: resolve(currentSession.header.cwd, ".mnemon")
Web workbench inspection: resolve(workspaceRegistry.get(selectedWorkspaceId).path, ".mnemon")
```

Each DSH workspace owns an independent three-tier memory root. Conversation Agents, model tools, commands, and lifecycle hooks route by the current session cwd. Independent task Agents launched from the Web workbench instead use the selected Host-registered workspace explicitly; the browser can never submit an arbitrary path. AI metadata, Agent Query, memory distillation, and document archiving therefore target the workspace selected at the top left even when no main session is selected.

Headless has no `workspaceRegistry`; its fresh session cwd is the directory from which `dsh --profile headless ...` was launched, so `workspace` resolves directly to `<invocation cwd>/.mnemon`.

### `custom`

```yaml
mnemon:
  storageScope: custom
  dataDir: /absolute/path/to/mnemon-data
```

`~` and `~/...` are also allowed. Relative paths are rejected.

### Choose a Cross-Agent Sharing Scope

| Goal | Recommended scope | Notes |
|---|---|---|
| Share durable memory among local agents | `global` | Every participant uses `~/.mnemon` or the same `MNEMON_DATA_DIR` |
| Share one explicit data root | `custom` | Every participant configures the same absolute directory for isolation and backup |
| Share only inside one project | `workspace` | Every participant aligns its Mnemon root to that project's `<workspace>/.mnemon` |

Mnemon Native interoperates with other Mnemon-enabled agents through `data/<store>/mnemon.db`; third-party engines interoperate through their configured provider scope. Runtime, Documents, DSH activation state, and UI metadata remain managed by dsh-mnemon. See [Long-term memory providers](./memory-providers.md).

External service settings, Memory Space scope settings, and secrets are stored in `state/memory-providers.json` under the selected scope root, not in `settings.yaml`. Multiple Memory Spaces reuse one provider service configuration; the Host merges both layers only at runtime. The Mnemon Native ZIP contains only Runtime, Documents, and native Memory Spaces; external service data, credentials, and local third-party stores are excluded.

## CLI Discovery Precedence

```text
config.cliPath
  -> executable MNEMON_CLI_PATH
  -> each PATH directory
  -> Windows: GOBIN/mnemon.exe
              first GOPATH/bin/mnemon.exe, or ~/go/bin/mnemon.exe
              %LOCALAPPDATA%/Programs/mnemon/mnemon.exe
              %ProgramFiles%/mnemon/mnemon.exe
  -> Unix: ~/.local/bin/mnemon
           /opt/homebrew/bin/mnemon
           /usr/local/bin/mnemon
           /usr/bin/mnemon
```

An explicit `cliPath` is accepted as configured; if it is not executable, actual calls return a launch error. Automatically discovered Windows commands must be regular `.exe` files. `.cmd` and `.bat` wrappers are intentionally excluded because process execution does not use a shell.

## Compatibility Store Hint Precedence

```text
config.store
  -> MNEMON_STORE
  -> <storageRoot>/active
  -> default
```

After the Memory Space directory has been established, long-term semantic operations use explicit Memory Space IDs and do not rely on the global active Store for routing.

## Background Task Agent Model Route

AI metadata, Agent Query, workbench/conversation memory distillation, and document archiving create a clean independent top-level task Agent. It uses the selected workspace as its cwd, works even when no main Agent session is selected, and is disposed after the task finishes.

The default `inherit` mode first uses the DSH Provider / Model selected for new sessions, then falls back to a complete route from the current available main Agent. Choosing **Choose model provider** in Settings stores a complete Provider + Model and overrides only Mnemon background tasks; it does not change the conversation Agent. When semantic judgment requires a bounded worker inside that task Agent, the worker inherits the task Agent route.

```yaml
mnemon:
  taskAgentModel:
    mode: fixed
    provider: deepseek
    model: deepseek-chat
```

DSH 0.1.1-rc.2 includes each model's declared input modalities in the live catalog. dsh-mnemon preserves that metadata and labels image-capable choices as **Image input**; the 0.1.1 prerelease line's first-party image-capable entry is `deepseek-official/deepseek-v4-flash-vision-exp`. Selecting it does not make current Mnemon background jobs ingest images: AI metadata, Agent Query, distillation, smart selection, and Document archive still submit text and bounded evidence. In the main conversation, DSH-owned image blocks keep their durable attachment references when dsh-mnemon appends lifecycle guidance, while activity thresholds count text blocks only. Raw image bytes are not copied into Runtime, Documents, or Memory Spaces.

## Provider Requirements

Regular workers prefer `spawn`. If no provider has that name, another provider with all of the following capabilities can be selected:

```text
outputSchema = true
toolFilter   = true
persona      = true
depthLimit   = true
```

Background review has no fallback: a compatible provider named `fork` must exist and must have:

```text
inheritsParentContext = true
```

A missing `fork` does not block deterministic state or regular UI reads, but a subagent failure is recorded when the review threshold is reached.

## Read-Only Configuration

```yaml
mnemon:
  writeEnabled: false
```

Effects:

- Model write tools are not registered;
- `/dsh-mnemon-write` RPC is not registered;
- `/mnemon remember` and `/mnemon forget` are rejected;
- semantic mutations through `MnemonService` are rejected.

This is feature-level read-only behavior, not a read-only filesystem mode: the Runtime controller may still initialize or repair projections, Document search updates LRU access times, and Mnemon read commands may trigger upstream database migrations. Do not treat `writeEnabled=false` as a safety guarantee for read-only mounts.

## Switch Interactions

```text
writeEnabled=false
  -> overrides all explicit semantic writes

writebackMode=off
  -> no write cue, no scored review
  -> explicit writes remain when writeEnabled=true

recallMode=off
  -> no recall cue
  -> explicit recall remains

lifecycleEnabled=false
  -> no lifecycle cues or review
  -> UI, commands, and explicit tools remain

routingGuidance=false
  -> removes only mnemon:routing
  -> runtime-memory context remains
```

## Display Mode and the `tabEnabled` UI Switch

`displayMode=sidebar` (the default) mounts the “Memory System” sidebar entry and its dedicated center-column workbench with a minimal, logo-free skin aligned with official DSH panels. `displayMode=buildin` instead registers the original DSH `conversation.view` tab and preserves its existing visuals. The modes share the functional workbench while keeping appearance definitions isolated. Saving first disposes the active entry and then mounts the target, so the two modes never appear simultaneously.

`tabEnabled=false` removes the currently selected Web entry live. Host RPC, commands, and tools remain registered across display-mode and enablement changes so an Agent or command already in progress stays valid.

## Profile Patch Overrides

The bundled `cordis.patch.yml` provides the default config row. A DSH profile configuration with the same ID may replace that row as a whole. Do not add only `cliPath` to a final profile patch: use `MNEMON_CLI_PATH` or the `mnemon.cliPath` user setting instead. When a profile patch must be customized for another reason, retain every key that must remain enabled instead of assuming a deep merge.

## Common Configurations

Workspace isolation:

```yaml
mnemon:
  storageScope: workspace
```

An explicit Windows CLI path:

```yaml
mnemon:
  cliPath: 'C:\Users\alice\AppData\Local\Programs\mnemon\mnemon.exe'
```

A custom data volume and a longer CLI timeout:

```yaml
mnemon:
  storageScope: custom
  dataDir: /Volumes/AgentData/mnemon
  timeoutMs: 30000
```

Keep explicit tools while disabling lifecycle behavior:

```yaml
mnemon:
  lifecycleEnabled: false
```

Disable only background writeback decisions:

```yaml
mnemon:
  writebackMode: off
```
