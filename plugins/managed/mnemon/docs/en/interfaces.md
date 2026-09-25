# Web, Headless, Tools, Commands, and RPC

[简体中文](../zh-CN/interfaces.md) | **English** | [Documentation hub](./README.md)

This page is an integration reference. For daily use, start with the [Sidebar and conversation UI guide](./ui-guide.md).

## User-facing entry points

| Entry | Default | Description |
|---|---:|---|
| Sidebar | Yes | Dedicated Memory System workbench with Status, Runtime, Documents, and Memory Spaces |
| Buildin | No | Original `conversation.view` tab with established visuals |
| Turn memory | Yes | Memory-tool summary for a completed turn, with exact page links |
| Save to memory | Yes | Action beside finalized assistant replies; confirmation invokes supervised writing |
| `/mnemon` | — | Conversation command entry |
| Model tools | — | Structured Root Agent read/write entry |

Sidebar and Buildin are live, mutually exclusive mounts that share functionality, data, and Host services. The two conversation entries can be disabled independently through `mnemon-ui` settings.

## Profile surfaces

| Capability | Web | Headless |
|---|---:|---:|
| Runtime context and lifecycle guidance | Yes | Yes |
| Model tools and independent task Agents | Yes | Yes |
| Agent-cwd routing for `workspace` scope | Yes | Yes |
| Sidebar / Buildin / conversation actions | Yes | No |
| Host-to-client RPC | Yes | No |
| Delayed score-based review after Agent idle | While the Host remains alive | Cancelled when the one-shot process exits |

Headless receives the full model-tool surface. Its task argument is submitted as an ordinary user message, so it does not provide an interactive slash-command dispatcher. Explicit and model-guided writes that finish before the Agent becomes idle are durable.

## Model tools

### Read-only tools

| Tool | Purpose | Root Agent path |
|---|---|---|
| `mnemon_status` | Aggregated CLI, configuration, storage, and directory status | Direct service |
| `mnemon_memory_bodies` | Read catalog, provider capabilities, health, and available statistics | Direct service |
| `mnemon_recall` | Recall from active providers with heterogeneous rank fusion | `spawn` recall worker |
| `mnemon_related` | Traverse only when `capabilities.related=true` | `spawn` related worker; Root defaults to two hops |
| `mnemon_document_search` | Deterministically search managed Documents | Documents control layer |

“Read only” means managed bodies and durable semantics do not change. `mnemon_document_search` still updates `lastAccessedAt` for LRU ordering, so feature read-only is not disk read-only.

### Tools available with `writeEnabled=true`

| Tool | Purpose | Root Agent path |
|---|---|---|
| `mnemon_runtime_memory` | `add` / `replace` / `remove` hot memory | Deterministic control; add overflow may start a worker |
| `mnemon_document_manage` | Create, update, or archive a Document | Create/update deterministic; archive uses a worker |
| `mnemon_remember` | Retain one insight under provider semantics and wait for a settled receipt | `spawn` write worker |
| `mnemon_link` | Create a typed relationship where the provider supports it | `spawn` write worker |
| `mnemon_forget` | Delete an exact ID where the provider supports it | `spawn` write worker |
| `mnemon_memory_body_create` | Let an Agent create a Mnemon Native space; third-party connections remain user-managed in WebUI | `spawn` write worker |
| `mnemon_memory_body_update` | Update name, description, or active state | `spawn` write worker |
| `mnemon_memory_body_merge` | Non-destructively merge Mnemon Native spaces | `spawn` write worker |

When a worker invokes the same tool name, it reaches the service directly and is not delegated recursively.

## Tool admission

- **Runtime**: explicit preferences, stable project conventions, environment facts, and high-frequency lessons.
- **Documents**: designs, investigations, procedures, postmortems, or handoffs with complete structure and rationale.
- **Memory Spaces**: stable facts, decisions, and insights that must survive across tasks or benefit from graph relationships.
- **Skip**: questions, guesses, temporary progress, completion logs, raw output, secrets, and ordinary repository facts that are easy to rediscover.

`mnemon_forget` is a destructive semantic action. Use it only on explicit request or after confirming that content is wrong or obsolete.

## `/mnemon` commands

```text
/mnemon
/mnemon status
/mnemon recall <query>
/mnemon related <full memory ID>
/mnemon remember <content>
/mnemon forget <exact ID>
```

- Empty `/mnemon` equals `status`.
- `status` is deterministic and starts no model.
- `recall`, `related`, `remember`, and `forget` use the live Agent containing the command as worker parent.
- Command recall returns at most 10 results.
- `forget` requires one exact ID without spaces.

## In-conversation contracts

| DSH slot | Registration | Behavior |
|---|---|---|
| `conversation.chat.turnTail` | chain | `turn-activity` summarizes `mnemon_*` calls from completed turns; open turns and turns without activity render nothing |
| `conversation.chat.assistant-actions` | list, `id=mnemon-save` | `assistant-message` reads finalized text; `supervise` runs only after confirmation |

Both are additive and replace no official DSH rendering. The assistant-message candidate is editable and long replies are bounded by the UI preview limit. Confirmation starts an independent task Agent, and persistence is complete only after its settled receipt.

## Workspace routing

Web workbench requests carry `sessionId` and an optional `workspaceId`. The Host accepts only IDs registered in `workspaceRegistry`:

- deterministic reads and manual maintenance may route to the inspected root selected by `workspaceId`;
- Agents, tools, commands, and lifecycle hooks still route by the Agent cwd associated with `sessionId`;
- `status.workspaceContext` returns selected / effective roots and `aligned`;
- Agent-backed operations are rejected while misaligned.

Profiles without a Web workspace registry, including Headless, have no arbitrary inspection target. Agent execution still routes `workspace` scope directly from the session cwd.

## RPC channels

RPC is an internal Host-to-client bridge, not a stable external HTTP API.

### Read channel

```text
channel:   /dsh-mnemon-read
authority: trusted-host
```

| Endpoint | Behavior |
|---|---|
| `status` | Aggregated service, version, lifecycle, Documents, and workspace/storage context |
| `versions` | Check installed/latest Mnemon and dsh-mnemon versions and installation sources |
| `runtime-memory` | Runtime snapshot |
| `documents` / `document` / `document-search` | Directory, body, and deterministic search |
| `graph` / `bodies` / `body-directory` | Active multi-space graph projection, provider-capability catalog, and fast directory projection |
| `body-reconnect` | Invalidate transient health state and refresh one Memory Space without changing persistent data |
| `provider-services` | Redacted Provider service catalog; configured-secret names may be present, secret values never are |
| `list` / `entities` | Durable content list and entity aggregation |
| `search` / `agent-search` / `related` | Direct retrieval, evidence answer, and relation traversal |
| `turn-activities` / `turn-activity` | Session-wide or single-turn memory-tool activity |
| `assistant-message` | Finalized assistant text by messageId |

### Write channel

Memory Space activation has a narrower `trusted-host` control plane:

```text
channel:   /dsh-mnemon-activation
authority: trusted-host
endpoint:  body
```

`body` accepts only `memoryBodyId`, a Boolean `active`, and the normal session/workspace routing fields. It controls participation in DSH reads and routing without accepting metadata, Provider connection, credential, deletion, or durable-memory mutations. Read-only mode rejects it at the Host boundary.

All broader mutations remain on the write channel:

```text
channel:   /dsh-mnemon-write
authority: loopback (`trusted-host` when `remoteAccess=trusted-host`)
```

| Endpoint | Behavior |
|---|---|
| `runtime-memory` | Hot-memory mutation |
| `supervise` | Process a candidate under an independent task Agent and return a settled receipt |
| `document` | create / update / archive |
| `remember` / `link` / `forget` | Durable semantic write, relation, and soft deletion |
| `body-create` / `body-update` / `body-delete` | Create/connect, edit, or confirm Native deletion / remote disconnection |
| `body-reconnect` | Legacy compatibility route for clients released before reconnect moved to the read channel |
| `provider-services` / `provider-service-update` | Read private Provider settings for the local settings UI, or update one service |
| `version-update` | Update a named component with Host-fixed commands and arguments |

The private `provider-services` response, including saved credential values needed by the local editor, is available only over this loopback channel. The trusted-host read endpoint always returns a redacted catalog.

With `writeEnabled=false`, both activation control and the write channel remain registered but mutations are rejected at the Host boundary. A remote trusted-host client also disables every loopback-only control before transport while leaving activation available.

### Backup channel

```text
channel:   /dsh-mnemon-pack
authority: loopback (`trusted-host` when `remoteAccess=trusted-host`)
```

| Endpoint | Behavior |
|---|---|
| `target` | Effective root and scope |
| `export` | Export a complete ZIP with manifest and SHA-256 checksums |
| `inspect` | Parse and verify an import ZIP, returning component and occupancy preview |
| `import` | Safely merge into the effective root; rejected in read-only mode |

Backups contain private memory, so the channel is loopback-only by default; deployment authentication must protect remote management mode.

### Settings channel

```text
channel:   /dsh-mnemon-settings
authority: loopback (`trusted-host` when `remoteAccess=trusted-host`)
namespaces: mnemon, mnemon-ui
endpoints: get, mutate
```

Mutations use settings revisions to prevent overwriting concurrent edits. `mnemon` owns Host/storage settings; `mnemon-ui` owns `turnBar` and `saveAction`.

## npm exports

The root package exposes Host composition and core classes:

```text
apply
Config / resolveConfig
createRunner
MnemonService
RuntimeMemoryController
DocumentManager
StorageScopeInspector
MnemonSubagentCoordinator
MnemonLifecycle
```

`dsh-mnemon/client` exports `apply` and `inject` for the DSH client bundle. Client implementation classes and RPC endpoints are internal and should not be treated as a stable public SDK.

## Internationalization

The main Sidebar / Buildin workbench, settings, and conversation entries support Chinese and English and follow DSH locale live. Brand names, tool names, and configuration keys are not translated. `/mnemon` commands, model-tool cards, some Host errors, and compatibility metadata remain partially untranslated.
