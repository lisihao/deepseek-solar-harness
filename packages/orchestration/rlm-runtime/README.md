# @deepseek-ai/dsh-rlm-runtime

English | [中文](README.zh.md)

Provider-neutral Service Definition for a persistent, programmable recursive language model runtime. It owns no Scheduler policy and performs no native model call itself.

## Service API

`ctx.rlmRuntime` exposes root lifecycle, persistent TypeScript cells, asynchronous child admission, child inspection, family-scoped messaging, durable goals, event cursors, interruption, reset, receipt-bound compaction scheduling, receipt inspection, explicit indeterminate abandonment, and reconciliation. A Consumer supplies `RlmRuntimeHostBindings`; a Provider never imports the physical-operator or orchestration implementation.

The Prime Agents View control surface is versioned as `attach → input → detach`. `attach` uses a caller id and command id to establish one exclusive lease and returns the current session snapshot plus event cursor. A second live controller fails with `RLM_CONTROL_BUSY`. `input` requires that lease and uses the existing message/continuation path (it does not create another Scheduler); repeated command ids return the same receipt and conflicting payloads fail. `detach` is idempotent. Leases are owner-process fenced, so a Provider restart can reclaim a lease left by a dead process while the durable RLM session remains available.

`RLM_TYPESCRIPT_REPL_TOOL_SCHEMA` is the canonical `ToolSchema` for the `typescript_repl` bridge. Consumers should reuse it rather than maintaining a second description or JSON schema.

Mutating calls use caller-generated command identities. `rlm(...)` admission returns an `RlmChildHandleV1`; the child answer arrives later through messages or artifact references. The programmable `skills.list()` API returns Host-issued `RlmManagedSkillDescriptorV1.alias` values, and `skills.call(name, args)` accepts only one of those aliases. Aliases use the public kebab-case skill grammar and are at most 128 characters. The Host maps each alias to a managed entry and its TypeScript import/callable; neither title nor `reference.import` is accepted from the kernel. Both operations return `RlmManagedSkillResultV1` for success and failure. A recovered uncertain command remains `indeterminate` until a trusted caller records `abandon`; replay never guesses its native outcome.

The model-facing compaction surface is `compact.status()` and `compact.run({ instructions? })`. The exact Host wire methods are `compact.status` with `{}` and `compact.run` with `{ instructions? }`. `compact.run` records the Host's `scheduled`, optional `reason`, and optional `note`; it does not claim that history was already compacted. The Host owns the real turn-boundary scheduling and native history operation.

## Extension points

Providers may use a local process, remote worker, or another durable kernel as long as the versioned observable contracts remain unchanged. Consumers may bind DSH Resident physical operators or a test fixture through the same host interface.

## Model Experience

Indirectly, through the model-facing TypeScript REPL Consumer that maps this service to a genuine provider tool.

#### KV Cache effect

The Service Definition has no direct token or KV-cache effect; the Consumer owns tool schema and result rendering.

## Known Limitations and Deferred Work

- **Provider required** — loading this abstract package alone does not create a kernel or execute a child.
- **Compatible subset** — Prime compatibility remains unclaimed until the native DeepSeek, Claude Code, and Codex host-tool paths plus Continuous Harness pass the fixed end-to-end matrix.
