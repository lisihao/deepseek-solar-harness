# Storage and the Three-Layer Memory Model

[简体中文](../zh-CN/storage-model.md) | **English** | [Documentation Center](./README.md)

## Why Three Layers

No single storage form can simultaneously be visible on every turn, preserve complete narratives, and support long-term graph-enhanced recall:

| Question | Corresponding layer | Reason |
|---|---|---|
| What must be known directly on the next turn? | Runtime Memory | Tiny and injected directly into the prompt |
| Which design or procedure needs to be read quickly and in full? | active Documents | Preserves Markdown structure without deep recall |
| Which historical facts and relationships should persist across sessions? | Memory Spaces | Independent databases, graph relationships, and on-demand recall |
| What happens when a long document is rarely used but must remain traceable? | archived Documents | Mnemon retains an index while the cold layer retains the original text |

Recommended query gradient:

```text
current request and repository facts
             |
             v
Runtime Memory already in prompt
             |
             v
search active Documents
             |
             v
recall active Memory Spaces
             |
             v
follow an exact cold reference when full text is required
```

## Unified Root Directory

```text
<storageRoot>/
+-- runtime/
|   +-- memories.json
|   +-- USER.md
|   +-- MEMORY.md
+-- documents/
|   +-- index.json
|   +-- active/
|   +-- archived/
+-- data/
|   +-- .dsh-memory-bodies.json
|   +-- <memory-space-id>/
|       +-- mnemon.db
+-- state/
    +-- memory-providers.json     # third-party connection control plane; 0600; excluded from Mnemon Packs
```

`storageScope` determines the entire root, not just the Mnemon databases. The `workspace` scope resolves an independent `<workspace>/.mnemon` for every registered DSH workspace. The Web inspection target and current-session execution target are independent; only the latter drives agents, tools, and lifecycle hooks. `state/memory-providers.json` stores third-party endpoints, target URIs, identities, and an optional API key. Its mode is `0600`; the Host returns only whether a key is configured, never the key itself.

## Runtime Memory

### Semantics

- `target=user`: identity, role, long-term preferences, habits, communication style, and explicit collaboration requirements.
- `target=memory`: projects, environment, decisions, conventions, tool characteristics, and reusable experience.
- `importance=critical|normal|low`: retention priority during maintenance.

There is currently no `daily` target.

### Source of Truth and Projections

`runtime/memories.json` is the sole source of truth. Each record contains:

```text
content
created_at
updated_at
target
importance
```

`USER.md` and `MEMORY.md` are deterministic derived files. Each item is normalized to one line, and items are separated by a line containing only `§`; `§` is a reserved character. During startup and prompt assembly, the control layer repairs missing or manually modified projections from the JSON source.

### Operations

- `add` writes an independent new fact; exactly identical content is not added twice.
- `replace` uses a unique substring match on `old_text` to locate and replace an entire item.
- `remove` uses a unique substring to remove an entire item.
- Zero or multiple matches are rejected; no fuzzy mutation is performed.

### Capacity

| Target | Limit | Maintenance method |
|---|---:|---|
| `USER.md` | 4 KiB | A local no-tool worker merges conservatively; content never enters a Memory Space |
| `MEMORY.md` | 10 KiB | A worker archives committed content first, then returns compaction candidates |

Capacity is measured from the actual UTF-8 bytes of the projection body. A single item is limited to 8 KiB. Automatic capacity maintenance is triggered only by an overflowing `add`; an overflowing `replace` fails directly, and the caller should perform explicit maintenance first.

## Project Documents

### Purpose

Documents preserve project knowledge that is more complete than a single memory item but should still be quick to read, such as:

- architecture designs and rationale;
- evidence-backed investigation findings;
- operating procedures, release checklists, and incident reviews;
- implementation handoffs and long-term maintenance notes.

User profiles, ordinary conversation, temporary progress, raw large logs, and secrets should not be stored in Documents.

### Control Plane

`documents/index.json` is the metadata source of truth. It manages IDs, titles, descriptions, status, filenames, source paths, sessions, timestamps, revisions, SHA-256 values, sizes, and Memory Space references. Managed Markdown copies include generated frontmatter.

`sourcePaths`:

- may point only inside the current session workspace;
- are source references only and are never modified by the plugin;
- are not required to exist by the current implementation;
- may not point into the managed `documents/` directory itself.

### Scope

The physical sharing scope of Documents is determined by `storageScope`:

- `workspace`: normally isolated with the project;
- `global` / `custom`: multiple workspaces may share the same `documents/index.json`.

Therefore, “Project Documents” describes the content type and does not guarantee physical isolation by workspace. The current session workspace constrains only `sourcePaths` on new writes.

### Capacity and Hot/Cold Tiering

| Item | Limit |
|---|---:|
| One body | 2 MiB maximum |
| Total active content | 10 MiB maximum, including generated frontmatter |
| Total archived content | Does not count toward the active limit |

The actual rendered size is calculated before creation or update. If capacity is insufficient, the least recently accessed active Document is selected by `lastAccessedAt` and then `updatedAt`; a Mnemon cold reference is written and verified first, and the original text is moved only if its revision remains unchanged.

Default search covers only active Documents. Search updates `lastAccessedAt` for matching Documents, so it is read-only with respect to bodies but writes index metadata.

## Memory Spaces

A Memory Space is the third tier's uniform semantic and routing unit; its provider chooses the data plane:

```text
id            generated by the Host or inherited from a discovered Mnemon Store
name          human-readable name
description   routing boundary: what belongs here and when to recall it
active        whether it participates in DSH reads and routing
provider      mnemon-native or one of the registered third-party engines
location      local store/CLI scope, or remote endpoint + provider scope
```

### Read and Write Boundaries

- After initialization, Mnemon's native layer retains at least one Store and selects one default through `<storageRoot>/active`; ordinary Mnemon agents continue to use this single-Store model.
- dsh-mnemon activation is an independent control plane: any 0..N Memory Spaces may be active, and making all inactive changes neither Mnemon's default Store nor remote data.
- Recall and browse use active spaces only; graph, entity, related, link, and delete behavior follows provider capabilities.
- Reads explicitly targeting an inactive Memory Space are rejected.
- Writes may target any registered space with `remember`; the receipt reflects the provider's exact or asynchronous extraction semantics.
- After a successful write to an inactive target, the plugin activates it automatically.
- Without an explicit target, if the number of active Memory Spaces is not exactly one, the deterministic service requires the caller to choose a target first.

### Creation, Discovery, and Merge

- An uninitialized root may remain at zero Stores. The first explicit Memory Space creation uses Mnemon's native `default` ID while retaining the user-supplied name and routing description; later creations use Host-generated UUIDs.
- The last native Store cannot be deleted after initialization, but its Memory Space may remain inactive. Before deleting Mnemon's default Store, the plugin switches to another existing Store.
- An existing `<storageRoot>/data/<store>/mnemon.db` is discovered and registered without moving the database.
- Merge imports source content into the target through Mnemon; the source database remains in place, and by default only the source is marked inactive.
- Pack replacement cannot empty an initialized Store set. If replacement removes the former default Store, the plugin repairs the native default pointer to an existing Store.
- `forget` is a soft delete by exact ID, not deletion of a database file.
- Users create Mnemon Native spaces directly. Enabling or saving a third-party service discovers all visible provider-native namespaces, atomically maps their titles/descriptions and scope into the directory, and makes them available as smart-selection candidates. Disabling the provider removes those local mappings and never provider content.
- Smart placement treats the allowlist, data boundary, and required capabilities as Host-enforced rules. Soft preference and prompt guide semantic choice only among multiple eligible candidates and cannot override hard rules. The decision receipt is persisted with Memory Space metadata.
- Merge remains Mnemon Native-specific. Graph, relationships, browsing, exact/async writes, and hard/soft/unsupported deletion follow each provider's declared capabilities; the UI and agents do not pretend missing behavior exists. See the [provider matrix](./memory-providers.md).

### Cross-Agent Visibility

`mnemon.db` is Mnemon's native data plane, not a private dsh-mnemon format. Another Mnemon-enabled agent can access the same durable memory when it uses the same `storageRoot` and Store. dsh-mnemon also discovers compatible Stores already present on disk; DSH-specific names, descriptions, and activation state remain managed by `.dsh-memory-bodies.json`.

Third-party visibility is determined by its provider scope, such as service plus URI, workspace/peers, bank, project/user, knowledge directory, or container. No provider extends sharing to `runtime/` or `documents/`; “shared third-tier memory” must not be presented as automatic sharing of the complete DSH context.

## Four Relationship Types

Mnemon Native preserves `temporal`, `semantic`, `causal`, and `entity` relationships. Hindsight projects its provider graph, and Holographic derives local entity/semantic relationships. Providers without graph edges contribute bounded disconnected nodes; adapters never invent unsupported relationships. The UI hides Related, Link, Browse, and Forget where the selected provider does not support them.

## Data Authority Table

| Data | Authoritative source | Derived/cache |
|---|---|---|
| Hot memory | `runtime/memories.json` | `USER.md`, `MEMORY.md` |
| Documents | `documents/index.json` + managed Markdown | excerpts, search ranking, status aggregation |
| Mnemon Native catalog | `data/.dsh-memory-bodies.json` + on-disk Stores | Web status aggregation |
| Third-party connections | `state/memory-providers.json` | redacted provider capabilities and status |
| Long-term memory | Mnemon `mnemon.db` or remote provider | graph projection and cross-provider rank fusion |
| Review watermark | Host process memory | status-page snapshot; not yet persisted |
