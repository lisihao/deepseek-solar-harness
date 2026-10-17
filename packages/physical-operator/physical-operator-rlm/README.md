# dsh-physical-operator-rlm

English | [中文](README.zh.md)

A standalone physical operator that delegates one bounded analysis to the existing orchestration daemon and shared RLM execution core. The outer wrapper contributes no second Scheduler, usage ledger, or settlement owner. Load it with an explicit id, display name, description, concurrency cap, and polling interval.

## Trusted Host

The Provider grants no Agent eligibility by default. After operator registration, it publishes an instance-specific `standaloneRlmHost` capability; an embedding Host depends on that capability and registers the exact live top-level Agent returned by its own successful create/resume using `registerStandaloneRoot`. The optional `/standalone-host` module creates and owns one explicitly configured root. This composition supports one wrapper binding per Cordis context. Merely appearing in the Agent registry does not authorize other roots or children.

The versioned Host policy supplies a concrete Resident or model-worker operator id and model, read scopes, context budget, RLM recursion/child/turn ceilings, and retry policy. Resident effort is explicit when supplied. Unsupported native session controls, generic generation limits, and non-text inputs fail before dispatch.

The real `physical_operator` Consumer prepares an immutable input before start. The Provider binds the Agent object, cancellation signal, tool call, execution id, whole input, policy version, and revocation state; it rechecks after readiness and immediately before the wire send. The daemon's configured exclusion ids must include the wrapper.

## Execution and settlement

The existing daemon atomically associates the accepted command with one business run. Exact duplicate inputs observe that command; conflicting inputs fail. Every observation and cancellation checks the complete expected request fingerprint before returning output or changing a run. A typed daemon refusal proves non-admission; a transport failure alone does not. Explicit wrapper selection and recursive self-selection are rejected.

Registry rejection before Provider invocation ends local dispatch and resource records without marking a physical request unknown. An unknown physical request retains the same business run as indeterminate before retry classification. Result, disposal, and outer capacity remain pending until actual physical settlement is known. Daemon shutdown detaches local holders without asserting native settlement. Restart fences unresolved standalone runs from scheduling, reattachment, child and continuation dispatch; their original identities remain queryable. Ordinary TaskGraph recovery is unchanged.

## Model Experience

### Delegated analysis input and result

#### What the model sees

The bottom driver receives the retained original text blocks, or the validated `contextEnvelope` rendered once. The `physical_operator` result contains the full owned output and omits duplicate usage. A materialization receipt proves receipt of the context; a content hash does not grant artifact-reading authority.

#### Token effect

The bottom request includes the complete retained task and the bounded RLM transcript. The outer tool result contains the full final output once. Neither path establishes a numerical token reduction.

#### KV Cache effect

The request depends on the original task, context envelope, selected model, and actual RLM transcript. This implementation does not establish a cache, latency, token, or quality improvement.

## Known Limitations and Deferred Work

- The initial subset is text-only, ephemeral, read-only, low-risk, and one certified graph leaf.
- Owner-local IPC is a shared trust domain; the daemon does not independently verify a live cross-process Agent identity.
- ACP, general CLI, and Desktop Host adoption remain separate integration work.
- The keyless runnable example is `examples/headless-agent/standalone-rlm.cordis.yml`; its transport fixtures do not exercise paid APIs or native model subscriptions.
