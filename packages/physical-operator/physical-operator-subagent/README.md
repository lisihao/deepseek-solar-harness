# @deepseek-ai/dsh-physical-operator-subagent

English | [中文](README.zh.md)

The first physical-operator Service Provider. It maps deployment-stable operator ids to existing `ctx.subagents` providers, so DSH can invoke Codex, Claude Code, or another registered execution product through one physical-operator contract.

## Configuration

```yaml
- id: physical-operator
  name: '@deepseek-ai/dsh-physical-operator'

- id: physical-operator-subagent
  name: '@deepseek-ai/dsh-physical-operator-subagent'
  config:
    operators:
      - id: physics-codex
        provider: codex
        displayName: Physics via Codex
        description: Solves one bounded physics task with Codex.
        tags: [physics, codex]
        maxConcurrency: 1
      - id: physics-claude-code
        provider: claude-code
        displayName: Physics via Claude Code
        description: Solves one bounded physics task with Claude Code.
        tags: [physics, claude-code]
        maxConcurrency: 1
```

| Key | Meaning |
|---|---|
| `operators[].id` | Stable caller-visible operator id. |
| `operators[].provider` | Existing `ctx.subagents` provider name. |
| `displayName` / `description` | Discovery presentation. |
| `tags` | Optional selection hints with no authority semantics. |
| `maxConcurrency` | Per-id fail-fast capacity, default `1`. |

Mappings register even when the backing subagent provider is absent. Discovery then reports `unavailable`, and automatically becomes available after the provider loads or reloads. Loading this plugin starts no child process and does not probe product binaries. An accepted call delegates through `ctx.subagents.start`, preserving the caller's parent agent and cancellation signal; the subagent provider remains the lifecycle and teardown owner.

The product mappings `codex` and `claude-code` are subscription-only. Discovery and `start()` both require the backing provider to attest `authentication.mode: native-subscription`; an explicit child environment or a missing attestation makes the operator unavailable. This blocks DSH-configured API-key billing at the operation boundary. Other provider names retain their own authentication policy, and aliases must be added to this restriction deliberately rather than inheriting it by naming convention.

Provider and Consumer packages depend only on the Service Definition and never import one another. This package adds no scheduler, persistence, command receipt, model selection, subprocess implementation, or AI4Research business code.

## Live subscription evidence

The manual [`subscription-canary-cordis.yml`](../../../examples/acp-agent/tests/fixtures/physical-operator/subagent/subscription-canary-cordis.yml) composition and its driver invoke the public `physical_operator` tool with isolated DSH, Session, and workspace roots. They supply no product `env`, verify the provider attestation before the call, and retain only the operator id, authentication mode, bounded marker, and match result. Run this canary only after independently confirming the host CLI's native login; it spends one real product request and is intentionally excluded from CI.

## Model Experience

Indirectly, through `dsh-tool-physical-operator`, which hides the backing `codex`, `claude-code`, or future provider transport behind one stable operator id.

#### KV Cache effect

No direct parent-prefix invalidation; changing only the deployment mapping leaves the Consumer's tool schema stable.

## Known Limitations and Deferred Work

- **One-shot subagent transport** — no continuation, progress stream, durable execution record, or cross-process resume is added here.
- **Text-oriented task contract** — provider-specific physics inputs, typed artifacts, and schema validation are deferred.
- **Deployment chooses the mapping** — this package does not score, benchmark, route, fail over, or load-balance between providers.
- **Provider side effects remain provider-owned** — cancellation cannot undo files or external actions completed before the provider stops.
- **Native account validity is host state** — the hard guard proves that DSH injected no explicit environment, while a live canary must separately prove the current CLI login and subscription entitlement.
