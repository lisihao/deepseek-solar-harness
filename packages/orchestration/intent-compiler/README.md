# Intent Compiler

English | [中文](README.zh.md)

`ctx.intentCompiler` converts an immutable request into versioned `IntentIRV1`. It records compiler provenance and deterministic input/output hashes; it cannot create a run or dispatch work.

## Model Experience

None, as this abstract Service Definition does not add model-visible context.

#### KV Cache effect

None. Consumers decide whether an Intent artifact enters a later model request.

## Known Limitations and Deferred Work

- The shipped local Provider is deterministic pass-through compilation; semantic classification and clarification dialogue require another Provider.
