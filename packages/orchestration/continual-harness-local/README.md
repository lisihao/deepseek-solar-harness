# @deepseek-ai/dsh-continual-harness-local

English | [中文](README.zh.md)

Owner-local persistent Provider for `ctx.continualHarness`. It stores explicit managed harness entries, bounded outcome summaries, tags, and Evidence references under the orchestration daemon root. It never captures raw user prompts, full transcripts, credentials, or model-private state.

Snapshots are versioned, content-addressed, and immutable once sealed into a node attempt. Reads without an explicit scope overlay normalized session, workspace, and owner-local `global` entries in that order; a narrower entry id shadows a broader one, while explicit scope reads remain exact. Session and workspace identities remain isolated, while the owner-local `global` identity is shared by every repository using the same DSH home. A refinement applies each valid edit independently, retains structured failures for rejected edits, and persists before-images only for successful edits. Rollback creates a later generation and survives Provider restart.

## Model Experience

Indirectly, through bounded entries selected for the current node.

#### KV Cache effect

Changing a selected entry changes the sealed node request prefix; raw historical turns never enter it.

## Known Limitations and Deferred Work

- The Provider is an owner-local, single-writer store used by `dsh-orchestratord`.
- Distributed replication and cross-machine harness synchronization are deferred.
