# Capability Capsule

English | [中文](README.zh.md)

`ctx.capabilityCapsules` snapshots immutable manifests and resolves attempt-scoped bindings. Resolution is constrained by the Graph's capability, effect, scope, operator, and approved-secret upper bounds.

## Model Experience

Indirectly, through hashed instructions and resource references rendered by the orchestration Consumer.

#### KV Cache effect

Bindings are stable within one sealed attempt. A later catalog revision affects only an unaccepted attempt or a new capability generation.

## Known Limitations and Deferred Work

- The local Provider supports a content-addressed on-disk catalog and test capsules. A production catalog and in-turn checkpoint application remain deferred.
