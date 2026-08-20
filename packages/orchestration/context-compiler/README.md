# Context Compiler

English | [中文](README.zh.md)

`ctx.contextCompiler` produces immutable, budgeted `ContextPacketV1` projections with source lineage, degradation, redaction, and capsule instruction records. Source systems remain authoritative.

## Model Experience

Indirectly, through orchestration execution plans that render one sealed packet for a physical operator.

#### KV Cache effect

Each sealed attempt has a stable packet hash; a new attempt or capability generation may replace the packet.

## Known Limitations and Deferred Work

- The local baseline Provider includes task, workspace, scopes, acceptance, upstream artifact references, and capsule instructions; retrieval, compression, and multi-source fusion are deferred.
