# Lifecycle and Core Workflows

[简体中文](../zh-CN/workflows.md) | **English** | [Documentation Center](./README.md)

## Per-Turn Context

The plugin registers stable routing guidance and a dynamic runtime-context contribution:

- `mnemon:routing`: a system prompt section that, when `routingGuidance=true`, provides concise boundaries for tiered queries;
- `mnemon:runtime-memory`: a DSH runtime-context snapshot that reads the latest `USER.md` and `MEMORY.md` whenever model input is assembled and includes admission rules for saving content. Changes are appended at the message tail instead of rewriting the stable system-prompt prefix.

Lifecycle hooks do not unconditionally read the Memory Space catalog or run recall at the start of every turn:

```text
agent/session-start
  -> mark primePending

agent/pre-step(step=1)
  -> cancel pending/running background review for a new turn
  -> mark Prime once
  -> optionally append one short recall/writeback cue
  -> main Agent decides whether to call a memory tool
```

Prime only initializes routing state; it does not run asynchronous CLI status queries.

## Root Agent Recall

```text
Root Agent calls mnemon_recall(query)
          |
          v
MnemonSubagentCoordinator
          |
          | spawn + recall persona
          | allow: memory_bodies, recall, related
          v
Recall worker lists the catalog
          |
          v
select active Memory Space(s) by name + description
          |
          v
call mnemon_recall from the worker
          |
          v
MnemonService searches selected Store(s)
          |
          v
normalize and attach memoryBodyId / memoryBodyName
          |
          v
one-run result tool, Host validates schema and caps results at 12
          |
          v
Root Agent receives evidence, not the raw routing trace
```

If the user has already supplied current facts, or the repository can answer directly, the Agent should not recall merely to “show memory.” When relationship explanations are needed, first use the complete `memoryBodyId + id` returned by recall, then run related.

## Web Retrieval and Agent Queries

The Web “Recall” page follows a different path from model tools:

```text
Direct search
  -> RPC read channel
  -> MnemonService.search directly
  -> raw evidence

Agent search
  -> the same deterministic direct search
  -> spawn a worker with no Mnemon tools
  -> answer only from supplied evidence
  -> Host filters citations to actual memoryBodyId/id pairs
```

The “Entities” and “Content” pages also read the deterministic service directly and do not start a recall worker. “Content” uses a graph snapshot and does not increment Mnemon recall access counts.

## Explicit Long-Term Writes

The long-term write flow for the root Agent or `/mnemon remember` is:

```text
durable candidate
       |
       v
spawn write worker
       |
       +-- list Memory Spaces
       +-- choose the narrowest suitable scope
       +-- recall when duplicate/conflict checking is useful
       +-- create a new scope only for a recurring distinct domain
       +-- remember / link / forget / merge as requested
       v
structured receipt
```

The first Memory Space created in an empty storage root uses Mnemon's native `default` ID; the Host generates later IDs. A successful write to an inactive target activates it. This activation affects only DSH routing, and merging a source database is non-destructive.

Runtime `add` / `replace` / `remove` and Document `create` / `update` do not need a model to perform storage I/O; they enter the deterministic control layer through the coordinator. Only capacity maintenance and archiving start dedicated workers.

## Runtime add: Normal Path

```text
request
  -> normalize content
  -> acquire in-process queue and file lock
  -> reload memories.json
  -> validate unique match / duplicate / capacity
  -> write temporary JSON and Markdown projections
  -> rename projections
  -> rename memories.json as the commit marker
  -> return compact receipt
```

`replace` and `remove` must match exactly one item through `old_text`. Capacity maintenance is triggered automatically only when `add` overflows.

## USER.md Capacity Maintenance

```text
USER add exceeds 4 KiB
          |
          v
snapshot revision + committed entries
          |
          v
spawn no-tool local compactor
          |
          v
return compacted entries + sourceIndexes
          |
          v
Host validates:
  - every source index appears exactly once
  - no duplicate or out-of-range index
  - importance is not lowered
  - candidate fits the Host byte budget
  - revision is still current
          |
          +-- invalid/conflict -> preserve original data
          |
          v
deterministic UTF-8 packing
          |
          v
retry pending add
```

The user profile is never sent to Memory Spaces. The worker has no tool permissions.

## MEMORY.md Archival and Compaction

```text
MEMORY add exceeds 10 KiB
          |
          v
snapshot revision + committed entries
          |
          v
spawn archive worker
  allow: memory_bodies, recall, remember, body_create
          |
          v
route semantic clusters and archive or duplicate-check them
          |
          v
return action + target spaces + compacted candidates
          |
          v
Host validates structure, action, revision and byte budget
          |
          +-- failure/conflict -> preserve hot memory
          |
          v
pack candidates by importance
          |
          v
retry pending add
```

The worker persona requires every committed entry to be represented in long-term storage or verified as a duplicate; this is an LLM-supervised policy. The Host's hard guarantees are structural, revision, and capacity validation, so semantic coverage should not be described as a database-level proof.

If a revision conflict occurs after a successful long-term write, the hot memory is preserved while the long-term layer may also contain a copy. The plugin prioritizes preventing data loss and does not attempt to roll back a completed Mnemon write across the database and file system.

## Document Creation, Update, and Archiving

```text
create/update request
          |
          v
capacityPlan using rendered UTF-8 bytes
          |
     +----+----+
     |         |
    fits     overflow
     |         |
     v         v
 commit    select least-recently-used active Document
               |
               v
          snapshot document + revision
               |
               v
          spawn archive worker
               |
               v
       write/verify concise Mnemon cold reference
       with title, summary, planned path, SHA-256
               |
          +----+----+
          |         |
        failed    receipt ok
          |         |
          v         v
   keep active   revision check
                    |
               +----+----+
               |         |
             conflict   current
               |         |
               v         v
          keep active  move file to archived
                             |
                             v
                    retry original mutation
```

Manual archiving uses the same “index first, move second” path. When the Mnemon index succeeds but a revision conflict occurs, the index is not rolled back, so a safe duplicate reference may remain while the active original text is never lost.

## Deterministic Activity Scoring and Background Review

Completed turns accumulate four signals:

```text
score =
  min(floor(totalUserCharacters / 50), 3)
  + completedTurnCount
  + min(floor(completedToolResults / 5), 2)
  + toolDiversityScore

toolDiversityScore:
  unique tools < 3  -> 0
  unique tools = 3  -> 1
  unique tools >= 4 -> 2

eligible when score >= 5
```

Reaching the threshold does not guarantee a write:

```text
completed turn
      |
      v
score >= 5 ? -- no --> retain activity for later turns
      |
     yes
      |
      v
wait idleReviewMs (default 30 s)
      |
      +-- new turn --> cancel timer/worker, retain activity
      |
      v
confirm Agent is idle and turn/end exists
      |
      v
fork completed parent checkpoint
      |
      v
conservative maintenance decision
  - at most one hot-memory mutation by persona
  - at most one Document create/update by persona
  - no direct long-term remember/forget tools
      |
      +-- completed, including skip -> clear activity
      |
      +-- failed/aborted ------------> retain activity
```

“At most one” is currently enforced by the worker persona, not by a Host mutation counter. Background watermarks are not yet persisted, so a Host restart loses accumulated signals that have not been processed.

## How Configuration Switches Interact

- `recallMode=off`: stops injecting recall cues; explicit `mnemon_recall` remains available.
- `writebackMode=off`: disables writeback cues and scored background review; explicit writes are still governed by `writeEnabled`.
- `lifecycleEnabled=false`: disables lifecycle reminders and review without removing explicit tools or Web entry points.
- `routingGuidance=false`: removes only the additional routing section; the Runtime Memory context remains registered.
- `writeEnabled=false`: removes semantic write tools and write RPC, and rejects write commands; it does not guarantee a read-only file-system mount.
