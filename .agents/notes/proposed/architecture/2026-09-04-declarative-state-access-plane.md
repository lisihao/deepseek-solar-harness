# Agent Note: Declarative State Access Plane

Status: proposed

English | [中文](2026-09-04-declarative-state-access-plane.zh.md)

## Problem

The durable orchestration path compiles one bounded `ContextPacketV1` before an attempt starts, seals only its `contextPacketRef` into `NodeExecutionPlanV1`, and then lets a Resident or RLM execution continue from that static projection. This preserves the initial bytes and lineage, but it does not define a durable state address space, a changing working set, or an authoritative record of which state versions a long-running execution later exposed to the model.

Long-running Agent Programs accumulate artifacts, evidence, tool results, child results, agent messages, claim ledgers, harness entries, approvals, and recovery records. Keeping that history durable is necessary for recovery and audit. Materializing all of it into every model turn creates token pressure, context competition, and compaction loss. Summarization reduces the active context but cannot preserve exact addressability or prove which versions supported a later artifact or effect.

The persistent RLM runtime already owns durable root and child identities, inherited execution options, messages, goals, heartbeats, and command receipts. It does not yet carry a provider-neutral address-space reference, working-set revision, state-access policy, or dynamic access receipts. Child inheritance therefore cannot prove that the child-readable state is an authority- and capability-narrowed subset of the parent.

Future inference providers may support native KV-block filtering, while current Codex, Claude Code, and model-worker routes can only materialize selected objects through a typed bridge or a subsequent turn. Exposing provider-native token ranges or block tables in the orchestration API would couple logical state identity and authorization to one serving engine.

Agentic Transaction Processing also needs a read-side record. A future effect intent can be admitted at commit time only when the runtime knows the exact semantic epoch and state versions made readable to the decision. The initial Context Packet is not a complete dynamic read history.

## Decision

Introduce a provider-neutral Declarative State Access Plane. It compiles an immutable, versioned state address space for each Agent Transaction; treats every model-generated access declaration as an untrusted proposal; validates that proposal against authority, capability, semantic epoch, policy, budget, and provider limits; creates an immutable working-set revision; and appends an access receipt describing the provider-observable readable set.

The first implementation supports logical access to six object families: Artifact, Evidence, Tool Result, Child Result, Agent Message, and Claim Ledger. It does not modify an attention kernel. The same Service Definition reserves a `native-block-mask` provider mode so a future vLLM or SGLang adapter can map semantic state segments to KV pages without changing orchestration, RLM, capability, or evidence contracts.

The Context Compiler continues to own the bounded initial model projection. State Access owns post-dispatch navigation, focus, release, inspection, grants, leases, working-set revisions, materialization, and receipts. State Access is not a scheduler and does not replace retrieval, compaction, RLM, Semantic Isolation, Capability Capsules, or the Agent Transaction Engine.

## Scope and non-goals

This proposal defines public contracts, ownership, durability, child attenuation, provider negotiation, failure semantics, migration, observability, and verification for Declarative State Access.

It does not claim that a model cognitively used every object exposed by a grant. A logical provider can prove which objects it materialized. A native provider can prove which segments it made readable to the attention kernel. Neither observation proves non-zero neural attention, factual correctness, evidence sufficiency, or mission completion.

It does not ship HBM/DRAM tiering, KV prefetch, PagedAttention block-table rewriting, native thinking-mode control, or GPU scheduling. Those remain provider capabilities requiring separate implementation evidence.

It does not expose mutable shared state in place. A ledger, message stream, or other mutable source is represented by an immutable versioned snapshot. A later version requires a new address-space revision or an explicit semantic rebase according to the source owner.

## State model

The runtime distinguishes four layers:

| Layer | Owner | Contents | Visibility |
| --- | --- | --- | --- |
| Journal and Artifact Store, `J` | Agent Transaction and source authorities | Complete durable events, immutable artifacts, receipts, and source versions | Durable but not automatically model-visible |
| State Address Space, `Aτ` | State Access service for transaction `τ` | Authorized and version-pinned object descriptors plus navigation metadata | Immutable revisions |
| Dynamic Working Set, `Wτ(t)` | State Access service and selected provider | Always-visible objects plus active focus grants | Immutable revisions with one current pointer |
| Attention Set, `Kτ(t)` | Logical materializer or native attention provider | Text spans, tool results, or KV pages exposed for the current phase | Provider-specific and bounded by the working set |

The required invariant is:

```text
Kτ(t) ⊆ Wτ(t) ⊆ Aτ ⊆ J
```

The inclusion is logical. An object may exist in the Journal without being eligible for the transaction address space. The address space contains only exact versions the transaction may name. The working set contains only objects admitted for the current phase. The attention set is the provider realization of that working set.

Transitions are authority-monotonic: navigation cannot reveal an unauthorized object; focus cannot expand the address space; a child cannot receive a broader address space than its parent; release cannot remove an always-visible object; native attention cannot expose a segment absent from the working set.

## Proposal and authority semantics

A model, RLM child, capability provider, or external controller may submit a `StateAccessIntentV1`. The intent is never an authorization token and cannot contain raw filesystem paths, credentials, provider-native KV identifiers, or unvalidated content references.

The effective readable set is the intersection of independently owned constraints:

```text
R_effective = R_declared
            ∩ R_address_space
            ∩ R_authority
            ∩ R_capability
            ∩ R_semantic_epoch
            ∩ R_policy
            ∩ R_budget
            ∩ R_provider
```

The model controls only `R_declared`. The host computes all remaining sets and issues a grant containing exact admitted object versions and segments. A provider rejects unknown, expired, stale-revision, stale-term, or wrongly fenced grants instead of attempting best-effort access.

The always-visible set contains the objective, output contract, transaction identity, state-access policy summary, unresolved obligations, and host-selected authority or safety instructions. The model cannot mask or release these objects. Secret-bearing authority state is represented by a non-secret summary and digest, never credential material.

## Package topology

Add two packages under `packages/orchestration/`:

| Package | Responsibility |
| --- | --- |
| `@deepseek-ai/dsh-state-access` | Branded identities, public schemas, strict validators, errors, Service Definition, source and provider interfaces |
| `@deepseek-ai/dsh-state-access-local` | Address-space compiler, working-set state machine, provider registry, command receipts, SQLite/CAS adapter, and logical materialization provider |

The dependency direction is:

```text
context-compiler ─┐
orchestration     ├──> state-access <── state-access-local
rlm-runtime       ┤
capability-capsule┤
physical-operator ┘
```

`state-access` must not import `@deepseek-ai/dsh-orchestration`, because orchestration already consumes it. Cross-package identities remain opaque branded strings verified by their owner adapters. Object contents stay owned by their source packages; State Access stores descriptors and refs, not a second mutable copy.

The existing [Domain KV storage and workspace proposal](2026-07-24-domain-kv-storage-and-workspace.md) owns durable storage media and domain-record semantics. It does not own model-visible state selection, access authority, working-set revisions, or attention-provider negotiation. This proposal does not supersede it.

## Public contracts

All cross-package records are versioned, immutable, digest-bearing, JSON-compatible, and strictly validated at model, IPC, provider, and persistence boundaries. Representative TypeScript shapes below are design contracts, not compiled source.

### StateObjectV1

```text
interface StateObjectV1 {
  version: 1
  ref: StateObjectRef
  objectId: string
  objectVersion: string
  kind: 'artifact' | 'evidence' | 'tool-result' |
        'child-result' | 'agent-message' | 'claim-ledger'
  owner: {
    providerId: string
    transactionId: string
    runId?: string
    nodeId?: string
    attempt?: number
    sessionId?: string
  }
  contentRef: string
  summaryRef?: string
  segmentRefs: string[]
  contentSha256: string
  semanticManifestRef: string
  semanticEpoch: number
  lineageRefs: string[]
  authorityScope: string
  sensitivity: 'public' | 'internal' | 'confidential' | 'secret'
  immutable: true
  byteEstimate: number
  tokenEstimate: number
  descriptorSha256: string
}
```

`objectId` is the stable semantic identity. `objectVersion` and `contentSha256` identify the exact immutable revision. The first implementation rejects `secret` objects from model-visible address spaces. `segmentRefs` are provider-neutral semantic segments; physical coordinates remain behind a provider-owned mapping.

### StateAddressSpaceManifestV1

```text
interface StateAddressSpaceManifestV1 {
  version: 1
  ref: StateAddressSpaceRef
  transactionId: string
  runId: string
  nodeId: string
  attempt: number
  revision: number
  parentAddressSpaceRef?: StateAddressSpaceRef
  semanticManifestRef: string
  semanticEpoch: number
  authorityEnvelopeRef: string
  authorityRevision: number
  policyRef: StateAccessPolicyRef
  objectRefs: StateObjectRef[]
  alwaysVisibleObjectRefs: StateObjectRef[]
  navigableObjectRefs: StateObjectRef[]
  focusableObjectRefs: StateObjectRef[]
  sourceCursorRefs: string[]
  createdAt: string
  manifestSha256: string
}
```

Only admitted objects appear in the manifest. Forbidden objects are not listed. Extending the address space creates a new immutable revision and retains the previous ref. A semantic-epoch change creates a new root address space through explicit semantic rebase, not an ordinary revision.

### StateWorkingSetV1

```text
interface StateWorkingSetV1 {
  version: 1
  ref: StateWorkingSetRef
  transactionId: string
  addressSpaceRef: StateAddressSpaceRef
  revision: number
  alwaysVisibleObjectRefs: StateObjectRef[]
  focusedObjectRefs: StateObjectRef[]
  activeGrantRefs: StateAccessGrantRef[]
  materializationProviderId: string
  materializedTokenEstimate: number
  materializedByteEstimate: number
  createdAt: string
  workingSetSha256: string
}
```

`state.focus` and `state.release` create new working-set revisions using `expectedWorkingSetRevision`. The runtime stores the current pointer separately. Replay returns the recorded working-set ref rather than resolving live source state.

### StateAccessPolicyV1

```text
interface StateAccessPolicyV1 {
  version: 1
  permittedObjectKinds: StateObjectKind[]
  maximumAddressableObjects: number
  maximumFocusedObjects: number
  maximumMaterializedTokens: number
  maximumMaterializedBytes: number
  maximumScopeTransitions: number
  maximumFullFallbacks: number
  maximumNavigationResults: number
  grantTtlMs: number
  onObjectMiss: 'navigate' | 'expand-focus' | 'full-fallback' | 'fail'
  fullFallback: 'forbidden' | 'allowed' | 'required-for-commit'
  receiptRequired: true
  minimumProviderMode: 'logical-materialization' | 'native-block-mask'
  requiredEvidenceKinds: string[]
  policySha256: string
}
```

Address-space scale and working-set scale are independent. Full fallback is an explicit budgeted operation, never an unbounded escape hatch.

### StateAccessIntentV1

`StateAccessIntentV1` is a discriminated union with four operations. Every member carries `version`, a caller-stable `commandId`, `transactionId`, exact `addressSpaceRef`, and `expectedWorkingSetRevision`.

```text
navigate {
  query?: string
  kinds?: StateObjectKind[]
  cursor?: string
  limit: number
  purpose: string
}

focus {
  objectRefs: StateObjectRef[]
  segmentRefs?: string[]
  maximumMaterializedTokens?: number
  validForTurns?: number
  purpose: string
  onMiss?: StateAccessMissPolicy
}

release {
  grantRefs?: StateAccessGrantRef[]
  objectRefs?: StateObjectRef[]
  purpose: string
}

inspect {}
```

`purpose` is audit metadata and cannot expand authority. `navigate` returns bounded descriptors and summaries, not bodies. `inspect` returns revisions, active grants, budgets, and counters without revealing inaccessible object identities.

### StateAccessGrantV1

```text
interface StateAccessGrantV1 {
  version: 1
  ref: StateAccessGrantRef
  intentRef: StateAccessIntentRef
  commandId: string
  transactionId: string
  operation: 'navigate' | 'focus' | 'release' | 'inspect'
  requestedAddressSpaceRef: StateAddressSpaceRef
  grantedAddressSpaceRef: StateAddressSpaceRef
  previousWorkingSetRef: StateWorkingSetRef
  resultingWorkingSetRef: StateWorkingSetRef
  grantedObjects: {
    ref: StateObjectRef
    objectId: string
    objectVersion: string
    contentSha256: string
    segmentRefs: string[]
  }[]
  deniedRequests: { requestDigest: string; code: StateAccessErrorCode }[]
  leaseId?: StateAccessLeaseId
  authorityRevision: number
  semanticEpoch: number
  clusterTerm?: number
  expiresAt?: string
  providerPlanRef?: string
  grantSha256: string
}
```

Denied entries use request digests rather than echoing unauthorized names. Focus is all-or-nothing by default. Partial focus is legal only when the capability contract and policy both allow it.

### StateAccessReceiptV1

```text
interface StateAccessReceiptV1 {
  version: 1
  ref: StateAccessReceiptRef
  intentRef: StateAccessIntentRef
  grantRef: StateAccessGrantRef
  commandId: string
  transactionId: string
  addressSpaceRef: StateAddressSpaceRef
  workingSetRef: StateWorkingSetRef
  operation: 'navigate' | 'focus' | 'release' | 'inspect'
  providerId: string
  observationLevel: 'logical-materialization' | 'native-block-mask'
  observedReadSet: {
    objectRef: StateObjectRef
    objectVersion: string
    segmentRefs: string[]
    contentSha256: string
  }[]
  materializedTokens: number
  materializedBytes: number
  attendedTokenPositions?: number
  kvBytesRead?: number
  accessMissDigests: string[]
  fallback?: 'navigate' | 'expand-focus' | 'full'
  authorityRevision: number
  semanticEpoch: number
  startedAt: string
  settledAt: string
  observedReadSetSha256: string
  receiptSha256: string
}
```

For logical materialization, the observed read set means the exact objects delivered through the model-visible projection or tool result. For native block masking, it means the exact segments exposed to the attention kernel. The receipt never claims cognitive use or factual correctness.

A crash after provider application but before receipt persistence makes the command `indeterminate`. Recovery calls provider reconciliation with the command and grant identities and never blindly reapplies the grant.

## Provider SPI

The Service Definition registers explicit materialization providers. Duplicate provider IDs fail, registrations follow Cordis lifecycle, and routing never depends on registration order.

```text
interface StateAccessProviderOfferV1 {
  providerId: string
  mode: 'logical-materialization' | 'native-block-mask'
  supportedOperations: ('navigate' | 'focus' | 'release' | 'inspect')[]
  granularity: 'state-object' | 'segment' | 'kv-block'
  maximumObjectsPerGrant: number
  maximumSegmentsPerGrant: number
  supportsPrefetch: boolean
  supportsKvOffload: boolean
  supportsThinkingMode: boolean
  reportsAttendedTokens: boolean
  reportsKvBytes: boolean
  providerVersion: string
  contractSha256: string
}

interface StateAccessMaterializationProviderV1 {
  offer: StateAccessProviderOfferV1
  open(request): Promise<ProviderSession>
  apply(grant, resolvedMaterial): Promise<ProviderObservation>
  reconcile(commandId, grantRef): Promise<ProviderObservation | 'not-applied' | 'unknown'>
  close(session): Promise<void>
}
```

`apply` receives only a host-issued grant and host-resolved material. It cannot resolve authority or live semantic versions. `reconcile` is mandatory even for the logical provider. `close` is idempotent and does not delete durable manifests, working sets, grants, or receipts.

The first provider is `logical-materialization`. It creates bounded, source-labelled, digest-bearing materialization artifacts and exposes them through the typed model-tool bridge or a host continuation. It does not claim native KV-read reduction when a Resident product retains prior context internally.

A future `native-block-mask` provider consumes a digest-verified mapping from semantic segments to token spans and KV pages. It rejects mappings produced for another model route, tokenizer, prompt-prefix digest, semantic epoch, provider session, or session revision.

## Context Compiler evolution

Do not reinterpret `ContextPacketV1`. Add `ContextPacketV2`, and let readers accept V1 or V2 during migration. V2 retains the current objective, task, source, lineage, redaction, compiler, and digest fields and adds:

```text
stateAccess: {
  addressSpaceRef: StateAddressSpaceRef
  initialWorkingSetRef: StateWorkingSetRef
  stateAccessPolicyRef: StateAccessPolicyRef
  initialAccessReceiptRefs: StateAccessReceiptRef[]
}
```

The packet token budget applies to the initial working-set materialization, not to the entire addressable state. The compiler rejects an initial working set whose always-visible objects alone exceed the configured budget.

The preparation order becomes:

```text
collect candidate state descriptors
→ pin semantic and authority inputs
→ compile address-space revision 1
→ create initial working-set revision 1
→ compile ContextPacketV2
→ select model and provider
→ seal NodeExecutionPlanV2
→ dispatch
```

## Orchestration and evidence evolution

Do not reinterpret `NodeExecutionPlanV1` or `OrchestrationExecutionEvidenceV1`. Add V2 records and keep legacy artifacts readable.

`NodeExecutionPlanV2` adds a `NodeStateAccessPlanV1` containing `addressSpaceRef`, `initialWorkingSetRef`, `stateAccessPolicyRef`, `materializationProviderId`, exact provider-offer ref, optional bridge ref, semantic epoch, and a plan digest.

`OrchestrationExecutionEvidenceV2` adds the final address-space ref, final working-set ref, all access-receipt refs, `observedReadSetSha256`, semantic epoch, and an access-completeness disposition of `complete`, `degraded`, or `unknown`. Legacy V1 evidence is `unknown`; migration must not derive a dynamic read history from the initial prompt or transcript.

The scheduler continues to own dependencies, readiness, attempt generation, scope conflicts, and physical dispatch. State Access does not become another scheduler. Every model-visible navigation result, materialization, fallback, denial, release, and inspection result must be reconstructable from the session or orchestration event log.

## RLM integration

Expose four typed RLM host operations:

| Operation | Result | Mutation |
| --- | --- | --- |
| `state.navigate` | Bounded authorized descriptors, summaries, versions, and lineage hints | Receipt and counters only |
| `state.focus` | Materialization handle and admitted exact versions | New working-set revision and optional lease |
| `state.release` | Resulting working-set metadata | New working-set revision; always-visible objects remain |
| `state.inspect` | Address-space revision, working-set revision, grants, budgets, and counters | Receipt only |

The tool schema never accepts raw content refs, paths, SQLite keys, secrets, or provider-native block IDs. RLM command IDs derive from durable session identity, cell command, and call ordinal. Repeating the same command and request digest returns the original result. Reusing a command ID with another digest fails `STATE_ACCESS_COMMAND_CONFLICT`.

Add `RlmChildExecutionOptionsV2` and a state-aware RLM session snapshot carrying `addressSpaceRef`, `workingSetRef`, `stateAccessPolicyRef`, and `semanticEpoch`. Host rebind after daemon recovery uses the exact persisted refs and does not compile a replacement from live state.

## Child attenuation

The host derives a child address space as:

```text
A_child = requested_child_objects
        ∩ A_parent
        ∩ child_authority
        ∩ child_capabilities
        ∩ child_policy
```

The child receives a new immutable manifest with `parentAddressSpaceRef`. It does not inherit parent focus grants or transaction-private local working state unless the spawn request explicitly selects objects and the host admits them into the initial child working set.

The runtime proves `objects(A_child) ⊆ objects(A_parent)` and equal semantic epoch at creation. Address-space extension is a separate durable request routed to the parent or orchestration authority. Cross-epoch child work requires semantic rebase or a new child transaction.

## Capability context-access contract

Extend Capability Capsule semantics with `ContextAccessContractV1`:

```text
interface ContextAccessContractV1 {
  accessShape: 'point-lookup' | 'few-span' | 'multi-span' |
               'global-aggregate' | 'streaming-transform' | 'iterative-search'
  requiredAlwaysVisibleKinds: StateObjectKind[]
  addressableKinds: StateObjectKind[]
  selectiveAccess: 'required' | 'allowed' | 'forbidden'
  exactFocus: boolean
  maximumFocusObjects?: number
  minimumEvidenceCoverage?: number
  fullFallback: 'required' | 'allowed' | 'forbidden'
  contractSha256: string
}
```

Global aggregate and streaming-transform capabilities may forbid selective focus and require a complete scan. Citation and evidence-checking capabilities may require exact focus and a minimum coverage disposition. Safety policy, goal lock, authority summary, output schema, and unresolved obligations remain always visible.

Capability resolution fails when the capsule requires native block masking but no selected physical route offers it, or when capability and graph access policies conflict. The effective contract is sealed into the capability binding plan and node plan.

## Physical operator negotiation

Extend `PhysicalOperatorResidentCatalog` with optional `AttentionControlOfferV1`:

```text
interface AttentionControlOfferV1 {
  mode: 'none' | 'logical-materialization' | 'native-block-mask'
  supportedOperations: ('navigate' | 'focus' | 'release' | 'inspect')[]
  granularity: 'state-object' | 'segment' | 'kv-block'
  supportsPrefetch: boolean
  supportsKvOffload: boolean
  supportsThinkingMode: boolean
  reportsAttendedTokens: boolean
  reportsKvBytes: boolean
  providerVersion: string
  contractSha256: string
}
```

A missing offer means `none`. A logical provider may still be selected through the owner-local typed bridge when the physical operator supports model tools. A graph requiring `native-block-mask` fails admission when no qualified offer exists; it never silently degrades to prompt-only instructions.

The node plan records the selected mode and exact offer digest. Retry under a changed product version, protocol hash, tokenizer, model route, or attention offer requires semantic compatibility admission.

## Effect read basis

A future Agent Transaction `EffectIntentV1` carries an `EffectReadBasisV1`:

```text
interface EffectReadBasisV1 {
  addressSpaceRef: StateAddressSpaceRef
  workingSetRef: StateWorkingSetRef
  accessReceiptRefs: StateAccessReceiptRef[]
  observedReadSetSha256: string
  semanticManifestRef: string
  semanticEpoch: number
  authorityRevision: number
  freshnessRequirements: {
    objectId: string
    minimumVersion?: string
    mustRemainCurrent: boolean
  }[]
}
```

Commit admission verifies that all receipts belong to the same transaction and attempt, use the same semantic epoch, reference admitted address spaces, and pass digest validation. Immutable evidence objects do not require a live reread. Policy, approval, budget, lease, and other mutable authority inputs marked `mustRemainCurrent` are revalidated by their owners at commit time.

Capabilities requiring access receipts or evidence coverage cannot promote a final artifact or commit an external effect when the read basis is missing, too degraded, or derived from legacy V1 state with unknown dynamic access. The receipt provides causal lineage, not truth; independent evaluators still determine sufficiency and correctness.

## Durability and cluster replication

Immutable objects, policies, address-space manifests, intents, grants, working-set snapshots, provider plans, observations, and receipts are content-addressed artifacts. SQLite stores indexes, command lifecycle, current pointers, and leases rather than duplicating payloads.

Add these indexed tables and include them in `REPLICA_TABLES`, deletion order, schema creation, export, validation, and install:

| Table | Purpose |
| --- | --- |
| `state_objects` | Object ref, owner coordinates, kind, semantic epoch, and creation time |
| `state_address_spaces` | Manifest refs by transaction, revision, parent, epoch, and authority revision |
| `state_working_sets` | Working-set refs by transaction/revision and the current pointer marker |
| `state_access_commands` | Command ID, request digest, lifecycle, intent/grant/receipt refs, error, and timestamps |
| `state_access_leases` | Grant, transaction, authority revision, cluster term, expiry, and release state |
| `state_access_receipts` | Append-only receipt refs indexed by run, node, attempt, session, and command |

Grant acceptance, command acceptance, and current working-set pointer update occur in one SQLite transaction. Provider application happens after durable `accepted`. Provider observation, receipt, and `settled` command state are then persisted together. A crash in between becomes `indeterminate` and is resolved only through provider reconciliation.

Cluster term and authority revision fence grants. A former leader cannot apply or renew a grant after losing authority. Fencing applies to logical materialization too, because an old daemon exposing newly forbidden confidential state is a security failure.

## Versioning and migration

- Keep `ContextPacketV1` readable; emit `ContextPacketV2` for new state-aware attempts.
- Keep `NodeExecutionPlanV1` readable; emit V2 for new state-aware attempts.
- Keep `RlmChildExecutionOptionsV1` readable; use V2 for state-aware roots and children.
- Keep `OrchestrationExecutionEvidenceV1` readable with access completeness `unknown`; emit V2 for new attempts.
- Advance orchestration SQLite schema from version 4 through an explicit forward migration preserving all existing rows and artifacts.
- Treat existing RLM sessions without State Access refs as legacy static-context sessions. Host rebind never invents an address space or receipt.

Migration never derives an observed read set from a prompt or transcript, because model-visible input is not equivalent to provider-observed access history.

## Error semantics

The public error vocabulary includes:

```text
STATE_ACCESS_INVALID
STATE_ACCESS_OBJECT_UNAVAILABLE
STATE_ACCESS_AUTHORITY_DENIED
STATE_ACCESS_CAPABILITY_DENIED
STATE_ACCESS_EPOCH_CONFLICT
STATE_ACCESS_REVISION_CONFLICT
STATE_ACCESS_BUDGET_EXCEEDED
STATE_ACCESS_GRANT_EXPIRED
STATE_ACCESS_COMMAND_CONFLICT
STATE_ACCESS_COMMAND_INDETERMINATE
STATE_ACCESS_PROVIDER_UNAVAILABLE
STATE_ACCESS_NATIVE_CONTROL_UNSUPPORTED
STATE_ACCESS_REPLAY_DRIFT
STATE_ACCESS_FULL_FALLBACK_REQUIRED
```

Unknown and unauthorized object refs use the same model-visible message unless the caller has catalog-inspection authority. Epoch conflict, authority denial, capability denial, replay drift, and unsupported required provider mode fail closed. Misses follow the sealed policy. Budget failures never increase limits automatically.

## Security and abuse controls

State-object refs are opaque and capability-scoped. The model cannot enumerate the journal, filesystem, artifact directory, SQLite tables, or another tenant. Navigation operates only over a precompiled authorized catalog.

Full fallback count, focused object count, materialized tokens and bytes, transition count, and navigation result count have independent budgets. Focus thrashing, repeated full fallback, and invalid-ref probing produce bounded events and counters that may stop or quarantine the transaction.

Object IDs found inside prompt or tool-result text remain data and cannot grant access. Materialized content retains source boundaries, version, digest, sensitivity, and lineage; providers must not concatenate untrusted source data so that it becomes indistinguishable from host instructions.

## Observability

Record bounded metrics and events for address-space size, working-set size, materialized tokens and bytes, navigation and focus latency, misses, fallbacks, denied requests, transitions, provider mode, grant expiry, reconciliation, and access completeness.

Native providers may additionally report attended token positions, KV bytes, block count, residency, prefetch hits, and offload bytes. These fields remain absent rather than estimated when the provider does not expose authoritative telemetry.

Public events must not contain secret object names, raw confidential content, provider-native addresses, credentials, or hidden reasoning. Opaque refs, counts, digests, and summaries already admitted to the model are permitted.

## Verification design

| Scenario | Required result |
| --- | --- |
| Wrong focus | The valid but insufficient focus is receipted; coverage requirements block promotion or invoke the sealed fallback rather than claiming completeness |
| Unauthorized object | Navigation does not reveal it; direct focus returns a non-disclosing denial and creates no working-set revision |
| Cross-epoch read | The grant is rejected before provider application |
| Replay drift | Repeated settled command returns original refs; unavailable pinned materialization fails `STATE_ACCESS_REPLAY_DRIFT` rather than resolving a live replacement |
| Child escape | Objects outside parent space or child attenuation are rejected; no child manifest contains them |
| Global/full DoS | Transition and full-fallback budgets stop repeated expansion and never self-increase |
| Context miss | The sealed miss policy executes and is recorded |
| Full fallback | Only the complete authorized address space is materialized, within token/byte ceilings, with `fallback: full` |
| Provider-application crash | The command becomes indeterminate; reconciliation resolves applied, not-applied, or unknown without blind reapplication |
| Cluster failover | Old-term grants cannot apply or renew; the new leader restores current pointer and receipts |
| Native provider mismatch | Stub provider rejects mismatched tokenizer, prompt prefix, model route, segment map, session revision, or expiry |
| Legacy recovery | V1 sessions and evidence remain readable with access completeness `unknown`; no synthetic receipt is created |

## Alternatives considered

**Add more inline material to `ContextPacketV1`.** This preserves a static projection and increases token pressure. It does not provide dynamic revisions, child attenuation, provider negotiation, idempotent commands, or read receipts.

**Put navigation inside RLM only.** Standard nodes, Debate synthesis, future Agent Program executors, and non-RLM physical operators also need state access. RLM consumes the capability but does not own state identity, authority, persistence, or provider routing.

**Use retrieval as the access contract.** Retrieval ranks candidates but does not define an authorized address space, exact versions, working-set lifetime, receipts, child attenuation, or physical attention placement.

**Use compaction and summaries only.** Compaction is lossy and cannot establish which exact versions became readable. Summaries remain navigation aids, not replacements for exact refs.

**Expose KV-block IDs to the model.** Physical coordinates are unstable across tokenizers, prompt prefixes, model routes, block sizes, compaction, and recovery. Models name semantic objects; providers own physical mapping.

**Use prompt tags as authority.** Free-form tags are not durable commands, are vulnerable to syntax errors and injection, and cannot support idempotent recovery. Reserved control tokens may be a native transport later, but still require typed grants and receipts.

**Always expose full history.** This remains a correctness baseline and explicit fallback, but couples durable history growth to active-context growth.

**Store all payloads as mutable SQLite JSON.** Immutable manifests, working sets, grants, and receipts belong in the artifact plane. SQLite indexes and coordinates them; duplicating payloads creates two sources of truth.

## First implementation slice

Add the two packages and the owner-local logical materialization provider. Integrate one complete state-aware RLM root/child path whose address space contains upstream artifacts/evidence, durable RLM messages, settled child-result artifacts, and a Debate claim ledger when present. Expose the four typed tools, persist and replicate State Access state, and demonstrate that:

- a child receives an attenuated address space;
- focus makes an exact object version model-visible with a receipt;
- release creates a new immutable working-set revision;
- daemon recovery rebinds the same refs;
- a test effect intent can bind the recorded read basis without implementing external effect commit.

This note remains `proposed`. It moves to `implemented/architecture` only after the public contracts, persistence, integration, tests, package documentation, generated references, snapshots, and full governance attestation ship.

## Acceptance criteria

- Public, versioned, branded, digest-bearing contracts exist for `StateObjectV1`, `StateAddressSpaceManifestV1`, `StateAccessIntentV1`, `StateAccessGrantV1`, and `StateAccessReceiptV1`, with strict boundary validation.
- The implementation enforces `Attention Set ⊆ Working Set ⊆ Address Space ⊆ Journal` without claiming neural attention or factual correctness.
- Every model declaration is an untrusted proposal; effective access is intersected with authority, capability, semantic epoch, policy, budget, and provider limits.
- `ContextPacketV2` carries `addressSpaceRef`, `initialWorkingSetRef`, and `stateAccessPolicyRef`; legacy V1 artifacts remain readable and are not reinterpreted.
- `NodeExecutionPlanV2`, `RlmChildExecutionOptionsV2`, and `OrchestrationExecutionEvidenceV2` carry State Access refs, semantic epoch, provider mode, receipt refs, and access completeness.
- RLM exposes `state.navigate`, `state.focus`, `state.release`, and `state.inspect` through the typed bridge with idempotent command receipts and reconstructable model-visible events.
- Child derivation proves an authority- and capability-narrowed subset and does not inherit active focus grants implicitly.
- Capability resolution enforces `ContextAccessContractV1`; physical operator catalogs expose optional `AttentionControlOfferV1` and fail loud when required native control is unavailable.
- Provider routing supports `logical-materialization` and `native-block-mask`; the first shipped provider implements only logical materialization and makes no KV-performance claim.
- Future effect intents can bind access receipts and `observedReadSetSha256`; commit admission validates transaction, attempt, epoch, authority revision, and required freshness.
- SQLite migration and cluster replication cover all State Access indexes, pointers, commands, leases, receipts, artifacts, and fencing state.
- Tests cover wrong focus, unauthorized objects, cross-epoch reads, replay drift, child escape, global/full DoS, context miss, full fallback, crash reconciliation, cluster failover, native-provider mismatch, and legacy recovery.
- Model-visible State Access results are logged, a keyless snapshot exercises the assembled path, and full repository governance verification and attestation pass without hidden skips.

## Risks

**A precise focus can still be wrong.** A grant proves what became readable, not that the selection was sufficient. Coverage-sensitive capabilities require independent evaluators or full fallback before promotion or effect commit.

**Logical materialization may not reduce native KV reads.** Resident products may retain prior history internally. The first provider improves control and observability; native performance claims require authoritative telemetry.

**Dynamic working sets add write amplification.** Intents, grants, revisions, receipts, and events increase persistence cost. Content-addressed payloads, bounded history, indexed pointers, and idempotent commands limit but do not remove this cost.

**Address-space construction can become a bottleneck.** Large journals require source-owned indexes and summaries. The first slice is bounded to run-local sources; global catalog scaling is separate work.

**Provider telemetry may be wrong.** `observationLevel` prevents logical counters from being presented as native attention measurements, but trusted deployment still depends on provider integrity and contract tests.

**The control channel can be abused.** Focus thrashing, invalid-ref probing, and full-fallback loops require independent budgets, host stop policy, and quarantine.

**Immutable versions increase retention cost.** Retention and compaction must preserve every object referenced by an active transaction, receipt, evidence record, or replay contract.

**Cross-package V2 migration is expensive.** Context, plans, RLM child options, evidence, store schema, events, docs, and snapshots must ship as one dependency-closed vertical slice. Partial consumers that silently ignore the new refs are unacceptable.
