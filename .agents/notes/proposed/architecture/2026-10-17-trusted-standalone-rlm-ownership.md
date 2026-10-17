# Agent Note: Trusted standalone RLM ownership

Status: proposed

English | [中文](2026-10-17-trusted-standalone-rlm-ownership.zh.md)

## Problem

A standalone RLM entry must preserve the original analysis input and existing execution limits without creating another Scheduler or charging the wrapper for the same work. A live Agent registry entry alone cannot establish that an embedding Host authorizes that Agent, and a completed logical node cannot establish that every physical request has settled.

## Proposal

Use the existing orchestration daemon, durable store, shared RLM execution core, and WP1 accounting as the sole execution owner. The Provider publishes an instance-specific Host binding only after its physical operator is registered. The Host registers the exact live root returned by its own create/resume, with an explicit versioned driver and execution policy. The first composition owns one wrapper binding per Cordis context and accepts only ephemeral, read-only text analysis with one certified leaf.

Bind each prepared tool call to the Agent object, execution id, immutable whole input, cancellation signal, policy version, and revocation state. Revalidate after readiness and immediately before sending. Default discovery grants no eligibility. Remove grants on Host or Provider disposal, and require the daemon's explicit wrapper exclusion list throughout root selection, child delegation, inherited plans, and recovery.

Persist acceptance before asynchronous compilation and associate a command with only one business run. Preserve the original nested JSON serialization separately from the canonical whole-input fingerprint so durable round trips do not change the existing context envelope digest. Exact duplicate commands observe the original effect; conflicting input fails. Restart fences unresolved commands rather than recreating or replaying them.

Check the expected complete command fingerprint before projecting any observation or requesting cancellation. Preserve explicit daemon non-admission proof separately from unknown transport outcomes. Fence recovered standalone runs at Scheduler, Host rebinding, reattachment and physical dispatch; ordinary TaskGraph recovery remains unchanged.

Track terminal evidence for every actual API request or exact Resident turn. Registry refusal before Provider invocation finishes the command as known non-dispatch. Mark an unknown physical effect indeterminate before business retry classification. Keep the same command, result, disposal, and outer capacity pending until physical settlement is known; daemon shutdown only detaches local holders. The wrapper returns the full result and omits duplicate usage; absent usage remains unknown. Store context envelopes as their original JSON text inside a versioned artifact so canonical CAS serialization cannot invalidate their existing digests.

## Alternatives considered

**A separate standalone scheduler and usage ledger.** This would create competing execution and settlement owners and permit limits to diverge from TaskGraph execution.

**Eligibility inferred from registry discovery.** This would authorize unrelated roots and children without the owning Host's explicit grant. YAML entry order also cannot prove Provider readiness because Loader mounts entries concurrently.

**Canonical JSON as the durable envelope representation.** Canonical sorting is suitable for whole-input equality, but reordering a nested envelope invalidates its existing digest. Preserve the received representation and validate it again on read.

## Acceptance criteria

Real Loader source and built-library compositions must exercise the Host, physical_operator tool, daemon, store, Scheduler, and production DeepSeek worker using only fake external transports. Tests must reject unregistered or child Agents, modified input, revoked grants, explicit wrapper self-selection, duplicate effects, unresolved restart, and unknown-request retries. Delayed Provider registration must not create a root early; unloading it must invalidate old grants. Required source checks and independent review must pass before this slice is accepted.

## Risks

Owner-local IPC shares a trust domain and does not independently prove cross-process Agent liveness. Unknown external settlement may retain capacity indefinitely rather than silently releasing or retrying. ACP, general CLI, and Desktop Host adoption remain separate work; keyless integration does not establish representative-task performance, paid-provider behavior, remote CI, or installed availability.
