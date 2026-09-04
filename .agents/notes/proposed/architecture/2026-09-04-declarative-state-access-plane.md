# Agent Note: Declarative State Access Plane

Status: proposed

English | [中文](2026-09-04-declarative-state-access-plane.zh.md)

## Problem

The durable orchestration path compiles one bounded [`ContextPacketV1`](../../../../packages/orchestration/context-compiler/src/types.ts) before an attempt starts, seals only its `contextPacketRef` into [`NodeExecutionPlanV1`](../../../../packages/orchestration/orchestration/src/index.ts), and then lets a Resident or RLM execution continue from that static projection. This preserves the initial context bytes and lineage, but it does not define a durable state address space, a changing working set, or an authoritative record of which state versions a long-running execution later made visible to the model.

Long-running Agent Programs accumulate artifacts, evidence, tool results, child results, agent messages, claim ledgers, harness entries, approvals, and recovery records. Keeping that history durable is necessary for recovery and audit, but repeatedly materializing the full history into every model turn increases token cost, context competition, and compaction pressure. Summarization or truncation reduces the active context but destroys exact addressability and cannot prove which source versions supported a later effect or artifact.

The persistent RLM runtime already carries sealed child execution options, durable child identities, messages, goals, heartbeats, and command receipts, yet its model-facing host requests resolve live resources and do not expose a provider-neutral state-access contract. A child may inherit the parent execution options while still seeing newly resolved state through later host calls. The runtime therefore lacks a precise rule for deriving a child-readable state space from the parent's authority.

A future inference provider may implement native KV-block filtering or prefetch, while current Codex, Claude Code, and model-worker providers can only materialize selected objects logically through a typed tool bridge or subsequent turn. Binding the orchestration API directly to one inference engine's block table would mix logical state identity, authorization, and physical attention placement.

Agentic Transaction Processing also needs a read-side record. An effect intent can be authorized at commit time only if the runtime can identify the exact semantic epoch and state versions that were available to the decision. The current context packet proves the initial projection, not the state objects made visible during an extended RLM execution.

## Proposal

Introduce a provider-neutral Declarative State Access Plane. It compiles an immutable, versioned state address space for each Agent Transaction, accepts model-generated state-access declarations only as untrusted proposals, validates each proposal against the transaction's authority, capability, semantic epoch, policy, budget, and provider limits, materializes an exact working-set revision, and appends an access receipt that records the provider-observable readable set.

The first implementation will support logical access to six state-object families: Artifact, Evidence, Tool Result, Child Result, Agent Message, and Claim Ledger. It will not modify an attention kernel. The same Service Definition will reserve an optional `native-block-mask` provider mode so a future vLLM or SGLang adapter can map versioned state segments to KV pages without changing the orchestration, RLM, capability, or evidence contracts.

The Context Compiler remains responsible for the bounded initial model projection. It will consume an address-space reference and an initial working-set reference instead of treating all potentially useful state as inline source material. The State Access service owns dynamic navigation, focus, release, inspection, grants, leases, and receipts after dispatch.

### Scope and non-goals

This proposal defines the logical contracts, ownership, versioning, durability, child attenuation, provider negotiation, failure semantics, and required verification for Declarative State Access.

The proposal does not claim that a model used or cognitively relied on every object exposed by a grant. A logical provider can prove materialization; a native provider can prove which KV segments its kernel made readable. Neither observation proves neural attention weight, factual correctness, evidence completeness, or mission success.

The proposal does not replace retrieval, compaction, RLM, the Context Compiler, Semantic Isolation, Capability Capsules, or the Agent Transaction Engine. Retrieval determines candidate state; compaction manages representation lifetime; RLM generates computation and child topology; State Access controls the current readable set; Semantic Isolation pins versions; the Agent Transaction Engine coordinates state and effects.

The proposal does not ship HBM/DRAM tiering, KV prefetch, PagedAttention block-table rewriting, native thinking-mode control, or GPU scheduling. Those capabilities remain behind the provider interface and require separate implementation evidence.

The proposal does not turn mutable shared state into an in-place model-visible object. A mutable ledger or message stream is exposed as an immutable versioned snapshot; a later version requires an address-space revision or semantic rebase according to its owner.

### Four state layers

The runtime will distinguish four layers instead of using `context` for all persisted and model-visible information:

| Layer | Owner | Contents | Mutation and visibility |
| --- | --- | --- | --- |
| Journal and Artifact Store, `J` | Agent Transaction and source authorities | Complete durable events, immutable artifacts, receipts, and source versions | Append-only or content-addressed; not automatically model-visible |
| State Address Space, `Aτ` | State Access service for transaction `τ` | Authorized, version-pinned state-object descriptors and navigation metadata | Immutable revisions; only the host may extend or rebase it |
| Dynamic Working Set, `Wτ(t)` | State Access service and selected provider | Always-visible objects plus active focus grants for one execution phase | Versioned revisions; changed only by admitted access commands |
| Attention Set, `Kτ(t)` | Materialization or native attention provider | Text spans, model-tool results, or KV pages exposed for the current phase | Provider-specific and bounded by the working set |

The required containment is:

```text
Kτ(t) ⊆ Wτ(t) ⊆ Aτ ⊆ J
```

`J` is a logical superset: an object can exist in the journal without being eligible for the transaction address space. `Aτ` contains only exact versions the transaction may name. `Wτ(t)` contains only objects admitted for the current phase. `Kτ(t)` is the provider's physical or logical realization of that working set.

Every transition must be monotonic with respect to authority: navigation cannot discover an unauthorized object; focus cannot expand the address space; a child cannot derive a broader address space than its parent; release cannot remove an always-visible object; native attention cannot expose a segment absent from the current working set.

### Proposal and authority rule

A model, RLM child, capability provider, or external controller may submit a `StateAccessIntentV1`. The intent is never an authorization token and never carries raw filesystem paths, secrets, provider-native KV identifiers, or unvalidated content references.

The effective readable set is the intersection of independent constraints:

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

The host computes every set except `R_declared`. A provider receives only a `StateAccessGrantV1` containing exact admitted object versions and segments. A provider must reject an unknown, expired, stale-revision, or wrongly fenced grant instead of attempting a best-effort access.

The always-visible set contains the task objective, output contract, current transaction identity, state-access policy summary, unresolved obligations, and safety or authority instructions selected by the owning runtime. The model cannot release, replace, or mask these objects. Secret-bearing authority state is represented by a non-secret summary and digest, not by credential material.

### Package topology and ownership

Add two packages under `packages/orchestration/`:

| Package | Responsibility |
| --- | --- |
| `@deepseek-ai/dsh-state-access` | Branded identities, public schemas, error vocabulary, Service Definition, object-source and materialization-provider interfaces |
| `@deepseek-ai/dsh-state-access-local` | Owner-local address-space compiler, working-set state machine, command receipts, SQLite/CAS adapter, logical materialization provider, and provider registry |

The dependency direction will be:

```text
context-compiler ─┐
orchestration     ├──> state-access <── state-access-local
rlm-runtime       ┤
capability-capsule┤
physical-operator ┘
```

`state-access` will depend only on stable lower-level types such as `@deepseek-ai/dsh-brand`, Cordis, and JSON-compatible contracts. It will not import `@deepseek-ai/dsh-orchestration`, because orchestration already consumes State Access and a reverse dependency would create a cycle. Cross-package references remain opaque branded strings whose owning adapter verifies them.

`state-access-local` may use the orchestration store through an injected owner adapter, but the public State Access Service Definition will not know SQLite tables or orchestration artifact paths. The existing [Domain KV storage proposal](2026-07-24-domain-kv-storage-and-workspace.md) concerns durable storage media and domain records; it does not own model-visible state selection, access authority, working-set revisions, or attention providers. This proposal does not supersede it.

Object contents remain owned by their source packages. State Access stores descriptors and references; it does not duplicate the source's authority or create a second mutable copy. The initial source adapters are orchestration artifacts/evidence, RLM child results and messages, physical tool-result artifacts, and Debate claim ledgers.

### Public identities and common records

The Service Definition will introduce branded references for every durable cross-package identity:

```ts ignore-check
export type StateObjectRef = Branded<'StateObjectRef'>
export type StateAddressSpaceRef = Branded<'StateAddressSpaceRef'>
export type StateWorkingSetRef = Branded<'StateWorkingSetRef'>
export type StateAccessPolicyRef = Branded<'StateAccessPolicyRef'>
export type StateAccessIntentRef = Branded<'StateAccessIntentRef'>
export type StateAccessGrantRef = Branded<'StateAccessGrantRef'>
export type StateAccessReceiptRef = Branded<'StateAccessReceiptRef'>
export type StateAccessLeaseId = Branded<'StateAccessLeaseId'>
```

A reference names immutable, digest-verified data unless the type explicitly names a lease. Callers never infer a filesystem path, table row, model token range, or provider-native block identifier from a reference.

### `StateObjectV1`

```ts ignore-check
export interface StateObjectV1 {
  readonly version: 1
  readonly ref: StateObjectRef
  readonly objectId: string
  readonly objectVersion: string
  readonly kind:
    | 'artifact'
    | 'evidence'
    | 'tool-result'
    | 'child-result'
    | 'agent-message'
    | 'claim-ledger'
  readonly owner: {
    readonly providerId: string
    readonly runId?: string
    readonly nodeId?: string
    readonly attempt?: number
    readonly sessionId?: string
    readonly transactionId: string
  }
  readonly contentRef: string
  readonly summaryRef?: string
  readonly segmentRefs: readonly string[]
  readonly contentSha256: string
  readonly semanticManifestRef: string
  readonly semanticEpoch: number
  readonly lineageRefs: readonly string[]
  readonly authorityScope: string
  readonly sensitivity: 'public' | 'internal' | 'confidential' | 'secret'
  readonly immutable: true
  readonly byteEstimate: number
  readonly tokenEstimate: number
  readonly descriptorSha256: string
}
```

`objectId` is the stable semantic identity, while `objectVersion` and `contentSha256` identify the exact immutable revision. An address space may contain only one version of an object identity unless its policy explicitly models multiple historical versions as separate identities. `segmentRefs` are provider-neutral semantic segments; a native provider may map them to token spans or KV pages through a separately digested map.

The first implementation will reject `sensitivity: 'secret'` objects from model-visible address spaces. Future confidential-object support requires an explicit provider confidentiality contract and must not infer authorization from the model request.

### `StateAddressSpaceManifestV1`

```ts ignore-check
export interface StateAddressSpaceManifestV1 {
  readonly version: 1
  readonly ref: StateAddressSpaceRef
  readonly transactionId: string
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
  readonly revision: number
  readonly parentAddressSpaceRef?: StateAddressSpaceRef
  readonly semanticManifestRef: string
  readonly semanticEpoch: number
  readonly authorityEnvelopeRef: string
  readonly authorityRevision: number
  readonly policyRef: StateAccessPolicyRef
  readonly objectRefs: readonly StateObjectRef[]
  readonly alwaysVisibleObjectRefs: readonly StateObjectRef[]
  readonly navigableObjectRefs: readonly StateObjectRef[]
  readonly focusableObjectRefs: readonly StateObjectRef[]
  readonly sourceCursorRefs: readonly string[]
  readonly createdAt: string
  readonly manifestSha256: string
}
```

Only admitted objects appear in the manifest. Forbidden objects are represented by authority-scope digests in the authority envelope, not by discoverable object names. An extension creates a new immutable manifest revision and retains the prior reference; it never mutates an existing manifest. A semantic-epoch change requires an explicit semantic rebase and a new root address space rather than an ordinary revision.

`sourceCursorRefs` let the owner add newly settled child results, messages, or claim-ledger versions deterministically. The extension operation records which source cursor produced each new object and rejects duplicate semantic identities with conflicting versions.

### `StateWorkingSetV1`

```ts ignore-check
export interface StateWorkingSetV1 {
  readonly version: 1
  readonly ref: StateWorkingSetRef
  readonly transactionId: string
  readonly addressSpaceRef: StateAddressSpaceRef
  readonly revision: number
  readonly alwaysVisibleObjectRefs: readonly StateObjectRef[]
  readonly focusedObjectRefs: readonly StateObjectRef[]
  readonly activeGrantRefs: readonly StateAccessGrantRef[]
  readonly materializationProviderId: string
  readonly materializedTokenEstimate: number
  readonly materializedByteEstimate: number
  readonly createdAt: string
  readonly workingSetSha256: string
}
```

A working set is immutable. `state.focus` and `state.release` create a new revision through optimistic concurrency using `expectedWorkingSetRevision`. The runtime stores the current pointer separately. Replaying a completed command returns the recorded working-set reference; it does not re-resolve live source state.

### `StateAccessPolicyV1`

```ts ignore-check
export interface StateAccessPolicyV1 {
  readonly version: 1
  readonly permittedObjectKinds: readonly StateObjectV1['kind'][]
  readonly maximumAddressableObjects: number
  readonly maximumFocusedObjects: number
  readonly maximumMaterializedTokens: number
  readonly maximumMaterializedBytes: number
  readonly maximumScopeTransitions: number
  readonly maximumFullFallbacks: number
  readonly maximumNavigationResults: number
  readonly grantTtlMs: number
  readonly onObjectMiss: 'navigate' | 'expand-focus' | 'full-fallback' | 'fail'
  readonly fullFallback: 'forbidden' | 'allowed' | 'required-for-commit'
  readonly receiptRequired: true
  readonly minimumProviderMode: 'logical-materialization' | 'native-block-mask'
  readonly requiredEvidenceKinds: readonly string[]
  readonly policySha256: string
}
```

The policy separates address-space scale from working-set scale. A transaction may address many objects while admitting only a bounded number of focused objects and materialized tokens. Full fallback is an explicit, budgeted operation; it is not an unbounded escape hatch.

### `StateAccessIntentV1`

`StateAccessIntentV1` is a discriminated union accepted at a hostile model/tool or wire boundary. Every member carries a caller-stable `commandId`, transaction identity, exact address-space reference, and expected working-set revision.

```ts ignore-check
export type StateAccessIntentV1 =
  | {
      readonly version: 1
      readonly operation: 'navigate'
      readonly commandId: string
      readonly transactionId: string
      readonly addressSpaceRef: StateAddressSpaceRef
      readonly expectedWorkingSetRevision: number
      readonly query?: string
      readonly kinds?: readonly StateObjectV1['kind'][]
      readonly cursor?: string
      readonly limit: number
      readonly purpose: string
    }
  | {
      readonly version: 1
      readonly operation: 'focus'
      readonly commandId: string
      readonly transactionId: string
      readonly addressSpaceRef: StateAddressSpaceRef
      readonly expectedWorkingSetRevision: number
      readonly objectRefs: readonly StateObjectRef[]
      readonly segmentRefs?: readonly string[]
      readonly maximumMaterializedTokens?: number
      readonly validForTurns?: number
      readonly purpose: string
      readonly onMiss?: StateAccessPolicyV1['onObjectMiss']
    }
  | {
      readonly version: 1
      readonly operation: 'release'
      readonly commandId: string
      readonly transactionId: string
      readonly addressSpaceRef: StateAddressSpaceRef
      readonly expectedWorkingSetRevision: number
      readonly grantRefs?: readonly StateAccessGrantRef[]
      readonly objectRefs?: readonly StateObjectRef[]
      readonly purpose: string
    }
  | {
      readonly version: 1
      readonly operation: 'inspect'
      readonly commandId: string
      readonly transactionId: string
      readonly addressSpaceRef: StateAddressSpaceRef
      readonly expectedWorkingSetRevision: number
    }
```

`purpose` is audit metadata and may support later policy evaluation; it never expands authority. `navigate` returns bounded descriptors and summaries, not object bodies. `inspect` returns address-space and budget metadata, active grants, working-set revision, misses, and fallback counters without revealing inaccessible object identities.

### `StateAccessGrantV1`

```ts ignore-check
export interface StateAccessGrantV1 {
  readonly version: 1
  readonly ref: StateAccessGrantRef
  readonly intentRef: StateAccessIntentRef
  readonly commandId: string
  readonly transactionId: string
  readonly operation: StateAccessIntentV1['operation']
  readonly requestedAddressSpaceRef: StateAddressSpaceRef
  readonly grantedAddressSpaceRef: StateAddressSpaceRef
  readonly previousWorkingSetRef: StateWorkingSetRef
  readonly resultingWorkingSetRef: StateWorkingSetRef
  readonly grantedObjects: readonly {
    readonly ref: StateObjectRef
    readonly objectId: string
    readonly objectVersion: string
    readonly contentSha256: string
    readonly segmentRefs: readonly string[]
  }[]
  readonly deniedRequests: readonly {
    readonly requestDigest: string
    readonly code: StateAccessErrorCode
  }[]
  readonly leaseId?: StateAccessLeaseId
  readonly authorityRevision: number
  readonly semanticEpoch: number
  readonly clusterTerm?: number
  readonly expiresAt?: string
  readonly providerPlanRef?: string
  readonly grantSha256: string
}
```

Denied entries use request digests rather than echoing unauthorized names. A mixed focus request may be rejected as a whole when the capability requires exactness; best-effort partial focus is allowed only when the policy and capability context contract both permit it. The default is all-or-nothing focus.

### `StateAccessReceiptV1`

```ts ignore-check
export interface StateAccessReceiptV1 {
  readonly version: 1
  readonly ref: StateAccessReceiptRef
  readonly intentRef: StateAccessIntentRef
  readonly grantRef: StateAccessGrantRef
  readonly commandId: string
  readonly transactionId: string
  readonly addressSpaceRef: StateAddressSpaceRef
  readonly workingSetRef: StateWorkingSetRef
  readonly operation: StateAccessIntentV1['operation']
  readonly providerId: string
  readonly observationLevel: 'logical-materialization' | 'native-block-mask'
  readonly observedReadSet: readonly {
    readonly objectRef: StateObjectRef
    readonly objectVersion: string
    readonly segmentRefs: readonly string[]
    readonly contentSha256: string
  }[]
  readonly materializedTokens: number
  readonly materializedBytes: number
  readonly attendedTokenPositions?: number
  readonly kvBytesRead?: number
  readonly accessMissDigests: readonly string[]
  readonly fallback?: 'navigate' | 'expand-focus' | 'full'
  readonly authorityRevision: number
  readonly semanticEpoch: number
  readonly startedAt: string
  readonly settledAt: string
  readonly observedReadSetSha256: string
  readonly receiptSha256: string
}
```

For `logical-materialization`, `observedReadSet` means the exact objects delivered through the model-visible projection or tool result. For `native-block-mask`, it means the exact segments the provider exposed to the attention kernel. The field never claims that the model assigned non-zero attention or used the information in its answer.

A receipt is immutable and append-only. A command that crashes after provider application but before receipt persistence enters `indeterminate`; recovery calls the provider's `reconcile` operation using the command and grant identities. It never blindly reapplies the grant.

### Provider contract

The Service Definition will expose registration for materialization providers. Registrations are Cordis effects, duplicate provider IDs fail, and routing is explicit rather than registration-order dependent.

```ts ignore-check
export interface StateAccessProviderOfferV1 {
  readonly providerId: string
  readonly mode: 'logical-materialization' | 'native-block-mask'
  readonly supportedOperations: readonly StateAccessIntentV1['operation'][]
  readonly granularity: 'state-object' | 'segment' | 'kv-block'
  readonly maximumObjectsPerGrant: number
  readonly maximumSegmentsPerGrant: number
  readonly supportsPrefetch: boolean
  readonly supportsKvOffload: boolean
  readonly supportsThinkingMode: boolean
  readonly reportsAttendedTokens: boolean
  readonly reportsKvBytes: boolean
  readonly providerVersion: string
  readonly contractSha256: string
}

export interface StateAccessMaterializationProviderV1 {
  readonly offer: StateAccessProviderOfferV1
  open(request: StateAccessProviderOpenRequestV1): Promise<StateAccessProviderSessionV1>
  apply(request: StateAccessProviderApplyRequestV1): Promise<StateAccessProviderObservationV1>
  reconcile(request: StateAccessProviderReconcileRequestV1): Promise<StateAccessProviderObservationV1 | 'not-applied' | 'unknown'>
  close(session: StateAccessProviderSessionV1): Promise<void>
}
```

`apply` receives only a host-issued grant and resolved object material; it does not resolve authority or live semantic versions. `reconcile` is required even for the logical provider so the command receipt and model-visible delivery remain recoverable. `close` is idempotent and does not delete address-space, working-set, intent, grant, or receipt artifacts.

The owner-local provider will implement `logical-materialization`. It will construct bounded, source-labelled materialization artifacts and expose them through the existing typed model-tool bridge or a host continuation. It will never splice unlabelled state into native history.

A future native provider will implement `native-block-mask`. It will consume a digest-verified mapping from state segments to token spans and provider-native KV pages. It must reject mappings created for another model route, tokenizer, prompt prefix, semantic epoch, or provider session.

### Context Compiler evolution

Do not mutate the persisted `ContextPacketV1` contract. Introduce `ContextPacketV2` and let readers accept `ContextPacketV1 | ContextPacketV2` during migration.

`ContextPacketV2` will retain the current objective, task, included-source, initial source-material, lineage, redaction, compiler, and digest fields, and add:

```ts ignore-check
export interface ContextPacketV2StateAccess {
  readonly addressSpaceRef: StateAddressSpaceRef
  readonly initialWorkingSetRef: StateWorkingSetRef
  readonly stateAccessPolicyRef: StateAccessPolicyRef
  readonly initialAccessReceiptRefs: readonly StateAccessReceiptRef[]
}
```

The packet's token budget applies only to the initial working-set materialization. Addressable objects may exceed that token budget because they are represented by descriptors and summaries until focused. The compiler rejects an initial working set whose always-visible objects alone exceed the configured budget.

The orchestration preparation order becomes:

```text
collect candidate state descriptors
→ pin semantic and authority inputs
→ compile address-space revision 1
→ create initial working-set revision 1
→ compile ContextPacketV2 from the initial working set
→ resolve model and materialization provider
→ seal NodeExecutionPlanV2
→ dispatch
```

### Orchestration plan and evidence evolution

Do not mutate `NodeExecutionPlanV1` or `OrchestrationExecutionEvidenceV1`. Introduce versioned V2 records and keep legacy artifacts readable without manufacturing access history.

`NodeExecutionPlanV2` will add:

```ts ignore-check
export interface NodeStateAccessPlanV1 {
  readonly addressSpaceRef: StateAddressSpaceRef
  readonly initialWorkingSetRef: StateWorkingSetRef
  readonly stateAccessPolicyRef: StateAccessPolicyRef
  readonly materializationProviderId: string
  readonly providerOfferRef: string
  readonly bridgeRef?: string
  readonly planSha256: string
}
```

`OrchestrationExecutionEvidenceV2` will add the final address-space reference, final working-set reference, all access-receipt references, `observedReadSetSha256`, semantic epoch, and an access-completeness disposition of `complete`, `degraded`, or `unknown`. Legacy V1 evidence is `unknown`; migration must not reinterpret its initial context packet as a complete dynamic read history.

The scheduler still owns TaskGraph dependencies, readiness, attempt generation, and physical operator dispatch. State Access does not become another scheduler. The orchestration daemon owns the adapter that turns upstream evidence, child results, messages, and claim ledgers into source-owned state-object descriptors.

Every model-visible navigation result, focus materialization, fallback, denial, release, and inspection result must be reconstructable from the session or orchestration event log. This preserves the repository's model-visible-equals-logged invariant.

### RLM model tools

Add four model-facing operations through the typed RLM host bridge:

| Operation | Input | Result | State change |
| --- | --- | --- | --- |
| `state.navigate` | bounded query, kind filter, cursor, limit | descriptors, summaries, versions, lineage hints | none except receipt/counters |
| `state.focus` | exact object refs, optional segment refs, budget and miss policy | materialization handle and admitted object versions | creates a working-set revision and optional lease |
| `state.release` | grant refs or focused object refs | resulting working-set metadata | creates a working-set revision; cannot release always-visible objects |
| `state.inspect` | no content selectors | address-space revision, working-set revision, active grants, budgets, counters | none except receipt |

The model-facing tool schema never accepts a raw `contentRef`, artifact path, SQLite key, secret reference, or provider-native block ID. Navigation returns only objects already present in the caller's address space.

RLM command IDs will be derived from the durable session, cell command, and call ordinal using the same idempotent command-receipt pattern as existing RLM mutations. A repeated command with the same request digest returns the original result; a repeated command ID with a different digest fails `STATE_ACCESS_COMMAND_CONFLICT`.

The RLM session snapshot and `RlmChildExecutionOptionsV2` will carry `addressSpaceRef`, `workingSetRef`, `stateAccessPolicyRef`, and `semanticEpoch`. Host rebind after daemon recovery reads these exact references and does not compile a new live address space.

### Child address-space attenuation

A child address space is derived by the host from the parent address space and child task contract:

```text
A_child = requested_child_objects
        ∩ A_parent
        ∩ child_authority
        ∩ child_capabilities
        ∩ child_policy
```

The child receives a new immutable `StateAddressSpaceManifestV1` with `parentAddressSpaceRef`. It does not inherit the parent's active focus grants or transaction-private local working set unless the spawn request explicitly selects objects and the host admits them into the child's initial working set.

The child may request an address-space extension, but the request is routed to the parent or orchestration authority as a separate durable command. The child cannot make the extension effective itself. A late child result is added as a new object only by the owner that settles the child transaction.

The runtime will enforce `objectRefs(A_child) ⊆ objectRefs(A_parent)` and equal semantic epoch at creation. Cross-epoch child work requires an explicit semantic rebase or a new child transaction; it is not an address-space extension.

### Capability context-access contract

Extend Capability Capsule semantics with a `ContextAccessContractV1` so selective access is a declared capability property rather than an implicit optimization.

```ts ignore-check
export interface ContextAccessContractV1 {
  readonly accessShape:
    | 'point-lookup'
    | 'few-span'
    | 'multi-span'
    | 'global-aggregate'
    | 'streaming-transform'
    | 'iterative-search'
  readonly requiredAlwaysVisibleKinds: readonly StateObjectV1['kind'][]
  readonly addressableKinds: readonly StateObjectV1['kind'][]
  readonly selectiveAccess: 'required' | 'allowed' | 'forbidden'
  readonly exactFocus: boolean
  readonly maximumFocusObjects?: number
  readonly minimumEvidenceCoverage?: number
  readonly fullFallback: 'required' | 'allowed' | 'forbidden'
  readonly contractSha256: string
}
```

A global aggregate or streaming transform may forbid selective focus and require a complete scan provider. A citation or evidence-checking capability may require exact focus and a minimum evidence-coverage disposition. Safety policy, goal lock, authority summary, output schema, and unresolved obligations remain always-visible regardless of the selected capability.

Capability resolution must fail when a capsule requires native block masking but the selected physical route only offers logical materialization, or when the capability forbids selective access but the graph policy requires it. The selected context-access contract and effective limits are sealed into the capability binding plan and Node execution plan.

### Physical operator attention-control offer

Extend `PhysicalOperatorResidentCatalog` with an optional `attentionControl` offer rather than assuming every provider supports the same mechanism:

```ts ignore-check
export interface AttentionControlOfferV1 {
  readonly mode: 'none' | 'logical-materialization' | 'native-block-mask'
  readonly supportedOperations: readonly StateAccessIntentV1['operation'][]
  readonly granularity: 'state-object' | 'segment' | 'kv-block'
  readonly supportsPrefetch: boolean
  readonly supportsKvOffload: boolean
  readonly supportsThinkingMode: boolean
  readonly reportsAttendedTokens: boolean
  readonly reportsKvBytes: boolean
  readonly providerVersion: string
  readonly contractSha256: string
}
```

A missing offer means `none`. The orchestration compiler may still select the owner-local logical provider through the typed tool bridge when the physical operator supports model tools. A graph or capsule that requires `native-block-mask` fails admission when no qualified offer exists; it never silently degrades to prompt-only instructions.

The execution plan records the selected attention-control mode and exact offer digest. A retry under a changed product version, protocol hash, tokenizer, or attention offer requires semantic compatibility admission rather than silent rebinding.

### Logical and native provider modes

`logical-materialization` is the first supported mode. It materializes a bounded object set as a labelled, digest-bearing model-tool result or host continuation. It can reduce the active textual working set and provide exact access receipts, but it does not claim native KV-read reduction when a Resident product retains prior context internally.

`native-block-mask` is an optional future mode. It maps state segments to the physical provider's token and KV-page coordinates and applies a grant for a bounded generation span. It must expose its prompt-prefix digest, tokenizer identity, model route, session revision, segment map digest, and block-table application receipt. A mismatched coordinate system fails before decode continues.

Both modes use identical logical intents, grants, address-space versions, and access receipts. Provider-specific plan fields remain behind opaque refs. This preserves application behavior while allowing physical implementations to evolve independently.

### Access receipts and effect intents

The Agent Transaction Engine's `EffectIntentV1` will carry a read basis:

```ts ignore-check
export interface EffectReadBasisV1 {
  readonly addressSpaceRef: StateAddressSpaceRef
  readonly workingSetRef: StateWorkingSetRef
  readonly accessReceiptRefs: readonly StateAccessReceiptRef[]
  readonly observedReadSetSha256: string
  readonly semanticManifestRef: string
  readonly semanticEpoch: number
  readonly authorityRevision: number
  readonly freshnessRequirements: readonly {
    readonly objectId: string
    readonly minimumVersion?: string
    readonly mustRemainCurrent: boolean
  }[]
}
```

Commit admission verifies that every receipt belongs to the same transaction and attempt, was issued under the same semantic epoch, references an admitted address space, and has a valid digest. Immutable evidence objects need no live re-read. Policy, approval, budget, lease, and other mutable authority inputs marked `mustRemainCurrent` are revalidated by their owning providers at commit time.

A capability that requires access receipts or evidence coverage cannot commit an external effect or promote a final artifact when the read basis is missing, degraded beyond its policy, or built from a legacy V1 context with unknown dynamic access. A transaction may explicitly enter a human-review or full-fallback path; it may not fabricate completeness.

The access receipt provides causal lineage, not truth. Independent evaluators remain responsible for determining whether the selected evidence was sufficient and whether the result is correct.

### Durability, SQLite, and cluster replication

Immutable state objects, policies, address-space manifests, intents, grants, working-set snapshots, provider plans, observations, and receipts will be stored as content-addressed orchestration artifacts. SQLite will store indexes, command state, current pointers, and leases rather than duplicate artifact payloads.

The orchestration schema migration will add the following indexed tables and include them in `REPLICA_TABLES`:

| Table | Purpose |
| --- | --- |
| `state_objects` | object ref, owner coordinates, kind, semantic epoch, and creation time |
| `state_address_spaces` | immutable manifest refs by transaction, revision, parent, epoch, and authority revision |
| `state_working_sets` | immutable working-set refs by transaction and revision plus the current pointer marker |
| `state_access_commands` | command ID, request digest, lifecycle, intent/grant/receipt refs, error, and timestamps |
| `state_access_leases` | grant, transaction, authority revision, cluster term, expiry, and consumed/released state |
| `state_access_receipts` | append-only receipt refs indexed by run, node, attempt, session, and command |

The store's complete cluster replica already exports every listed table and every content-addressed artifact. Adding the tables to `REPLICA_TABLES`, deletion order, schema creation, and forward migration makes the State Access state part of the same leader image. Replica installation must reject a missing table, invalid row, artifact digest mismatch, or schema-version mismatch.

Issuing a grant, changing the current working-set pointer, and accepting its command receipt occur in one SQLite transaction. Provider application happens after the durable `accepted` state. On success the provider observation and final receipt are persisted together with the `settled` command state. A crash after provider application but before settlement leaves the command `indeterminate`; recovery uses provider reconciliation and never applies a second uncoordinated focus operation.

Cluster leadership and authority revision fence new grants. A grant records the cluster term when cluster mode is active. A recovered or former leader cannot apply or renew a grant after losing authority. Logical materialization without external side effects still uses fencing because an old daemon exposing newly forbidden confidential state is a security failure.

### Versioning and migration

This proposal requires forward-only versioned additions rather than in-place reinterpretation:

- `ContextPacketV1` remains readable; new executions emit `ContextPacketV2`.
- `NodeExecutionPlanV1` remains readable; new state-aware attempts emit `NodeExecutionPlanV2`.
- `RlmChildExecutionOptionsV1` remains readable; state-aware roots and children use V2.
- `OrchestrationExecutionEvidenceV1` remains readable with access completeness `unknown`; new attempts emit V2.
- The orchestration SQLite schema advances from version 4 through an explicit migration that creates the State Access tables and preserves all existing run, attempt, event, and artifact rows.
- Existing RLM sessions without state-access refs remain legacy static-context sessions. Host rebind does not invent an address space. They may finish under legacy semantics or be explicitly continued as a new state-aware transaction.

A migration never derives an observed read set from a prompt or transcript, because model-visible input is not equivalent to a provider-observed access history.

### Error semantics

The public error vocabulary will include:

```ts ignore-check
export type StateAccessErrorCode =
  | 'STATE_ACCESS_INVALID'
  | 'STATE_ACCESS_OBJECT_UNAVAILABLE'
  | 'STATE_ACCESS_AUTHORITY_DENIED'
  | 'STATE_ACCESS_CAPABILITY_DENIED'
  | 'STATE_ACCESS_EPOCH_CONFLICT'
  | 'STATE_ACCESS_REVISION_CONFLICT'
  | 'STATE_ACCESS_BUDGET_EXCEEDED'
  | 'STATE_ACCESS_GRANT_EXPIRED'
  | 'STATE_ACCESS_COMMAND_CONFLICT'
  | 'STATE_ACCESS_COMMAND_INDETERMINATE'
  | 'STATE_ACCESS_PROVIDER_UNAVAILABLE'
  | 'STATE_ACCESS_NATIVE_CONTROL_UNSUPPORTED'
  | 'STATE_ACCESS_REPLAY_DRIFT'
  | 'STATE_ACCESS_FULL_FALLBACK_REQUIRED'
```

Unknown and unauthorized object references use the same model-visible message unless the caller has catalog-inspection authority, preventing object-existence disclosure. Internal events retain the exact policy reason under restricted diagnostics.

An epoch conflict, authority denial, capability denial, replay drift, or unsupported required provider mode fails closed. A navigation miss or focus miss follows the sealed policy and records the selected fallback. A budget failure never automatically increases a limit.

### Security and abuse controls

State-object references are opaque and capability-scoped. The model cannot enumerate the journal, filesystem, artifact directory, SQLite tables, or other tenants. Navigation operates only over a precompiled authorized catalog.

Full fallback, focus-object count, materialized tokens, materialized bytes, state transitions, and navigation result count are independently budgeted. Repeated full requests, focus thrashing, or invalid-reference probing produce counters and events that a host evaluator may use to stop or quarantine the transaction.

Prompt or tool-result content cannot grant access by naming another object. The parser treats all object IDs inside source text as data unless the model submits them through the typed State Access tool and the host admits them.

Materialized content retains source labels, object versions, digests, sensitivity class, and lineage. The provider must not concatenate content in a way that removes object boundaries or makes an untrusted source indistinguishable from host instructions.

### Observability

Each transaction will expose bounded metrics and events for address-space size, working-set size, materialized tokens and bytes, navigation latency, focus latency, access misses, full fallbacks, denied requests, transition count, provider mode, grant expiry, reconciliation, and access-completeness disposition.

Native providers may additionally report attended token positions, KV bytes read, block count, residency, prefetch hits, and offload bytes. These counters remain absent rather than estimated when the provider does not expose authoritative telemetry.

The public event projection must not include secret object names, raw confidential contents, provider-native addresses, credentials, or hidden reasoning. It may include opaque refs, counts, digests, and bounded public summaries already admitted to the model.

### First implementation slice

The first implementation will add the two packages, use the owner-local logical materialization provider, and integrate one complete RLM path. A state-aware RLM root will receive an address space containing upstream orchestration artifacts/evidence, durable RLM messages, settled child-result artifacts, and a Debate claim ledger when present. It will use `state.navigate`, `state.focus`, `state.release`, and `state.inspect` through the typed bridge.

The slice will not modify vLLM or any Resident provider. Its acceptance probe will demonstrate that a child receives an attenuated address space, a focused object becomes model-visible with a receipt, release creates a new working-set revision, daemon recovery rebinds the same refs, and a later effect intent can include the recorded read basis.

The implementation will update the owning subsystem references, package READMEs, generated Cordis API regions, snapshot harness, and current architecture map when the public contracts ship. This proposed note remains the rationale owner and will move to `implemented/architecture` only after the code and verification described below are present.

### Verification design

| Scenario | Required observation |
| --- | --- |
| Wrong focus | A valid but insufficient focus remains receipted; a capability with evidence-coverage requirements blocks artifact promotion or triggers its sealed fallback rather than claiming completeness |
| Unauthorized object | Navigation does not reveal it; direct focus returns the non-disclosing denial and creates no working-set revision |
| Cross-epoch read | A grant under another semantic epoch is rejected before provider application |
| Replay drift | A repeated settled command returns the original working-set and receipt refs; an unavailable pinned materialization fails `STATE_ACCESS_REPLAY_DRIFT` rather than resolving a live replacement |
| Child escape | An object outside the parent address space or child attenuation policy is rejected; no child manifest contains the ref |
| Global/full denial of service | Full fallback and transition budgets stop repeated expansion; limits never self-increase |
| Context miss | The sealed `onObjectMiss` action is taken and recorded, including navigation, expanded focus, full fallback, or fail |
| Full fallback | It materializes only the complete authorized address space, obeys token and byte ceilings, records `fallback: 'full'`, and cannot include forbidden objects |
| Crash after provider application | Command becomes indeterminate; reconciliation settles applied/not-applied/unknown without blind reapplication |
| Cluster failover | A grant from an old cluster term cannot be applied or renewed; the new leader can recover the current working-set pointer and receipts |
| Native-provider contract | A stub provider rejects a mismatched tokenizer, prompt-prefix digest, model route, segment map, or expired grant |
| Legacy recovery | V1 sessions and evidence remain readable with access completeness `unknown`; no synthetic receipt is created |

## Alternatives considered

**Extend `ContextPacketV1` with more inline material.** This preserves a single static projection and increases token pressure; it does not provide dynamic working-set revisions, child attenuation, provider negotiation, command idempotency, or read receipts. A versioned Context Packet remains the initial projection but not the dynamic access owner.

**Put state navigation directly inside the RLM runtime.** Standard orchestration nodes, Debate synthesis, future Agent Program executors, and non-RLM physical operators also need state access. RLM should consume the capability instead of owning state identity, authority, persistence, or provider routing.

**Use retrieval or vector search as the state-access interface.** Retrieval ranks candidate content but does not define an authorized address space, exact semantic versions, working-set lifetime, observed read-set receipts, child attenuation, or native attention placement. Retrieval providers can populate or navigate an address space through this proposal.

**Use compaction and summaries only.** Compaction is lossy and changes representation lifetime. It cannot recover exact source bytes without another addressable store and does not record which versions became readable during a decision. Summaries remain navigation aids and never replace exact object refs.

**Expose vLLM chunk or KV-block identifiers directly to the model.** Provider-native coordinates are unstable across tokenizers, prompt prefixes, model routes, block sizes, compaction, and session recovery. They also bypass authorization and couple the model protocol to one serving engine. Models name semantic state objects; providers own physical mapping.

**Let the model manage full/global access through prompt tags alone.** Free-form tags are not an authority or durable command protocol, are susceptible to syntax errors and prompt injection, and cannot support idempotent recovery. A future native provider may parse reserved control tokens, but the result still passes through the typed grant and receipt contract.

**Always provide the full authorized history.** This remains an explicit fallback and a useful correctness baseline, but it makes address-space growth identical to active-context growth and prevents the runtime from exploiting phase-local state access.

**Store State Access payloads as mutable JSON rows.** Immutable manifests, working sets, grants, and receipts belong in the existing content-addressed artifact plane. SQLite rows index and coordinate them; duplicating payloads would create two sources of truth and make cluster verification weaker.

## Acceptance criteria

- `StateObjectV1`, `StateAddressSpaceManifestV1`, `StateAccessIntentV1`, `StateAccessGrantV1`, and `StateAccessReceiptV1` are public, versioned, branded, digest-bearing contracts with strict model/wire-boundary validation.
- The implementation enforces `Attention Set ⊆ Working Set ⊆ Address Space ⊆ Journal` and documents the provider-observable meaning of the read set without claiming neural attention or factual correctness.
- Every model declaration is an untrusted proposal; effective access is the intersection of address space, authority, capability, semantic epoch, policy, budget, and provider limits.
- `ContextPacketV2` carries `addressSpaceRef`, `initialWorkingSetRef`, and `stateAccessPolicyRef`; legacy V1 artifacts remain readable and are not reinterpreted.
- `NodeExecutionPlanV2`, `RlmChildExecutionOptionsV2`, and `OrchestrationExecutionEvidenceV2` carry the State Access refs, semantic epoch, provider mode, receipt refs, and access-completeness disposition.
- RLM exposes `state.navigate`, `state.focus`, `state.release`, and `state.inspect` through the typed host bridge with idempotent command receipts and model-visible event reconstruction.
- Child address-space derivation proves the child object set is a permission- and capability-narrowed subset of the parent and does not inherit active focus grants implicitly.
- Capability Capsule resolution includes an effective `ContextAccessContractV1` and rejects incompatible access shapes, evidence requirements, fallbacks, or provider modes.
- `PhysicalOperatorResidentCatalog` publishes an optional `AttentionControlOfferV1`; required native control fails loud when no qualified route exists.
- The provider registry supports `logical-materialization` and `native-block-mask` contracts, while the first shipped provider implements only logical materialization and does not claim KV performance gains.
- An Agent Transaction effect intent can bind `StateAccessReceiptRef` values and `observedReadSetSha256`; commit admission validates transaction, attempt, epoch, authority revision, and required freshness.
- Tests cover wrong focus, unauthorized objects, cross-epoch reads, replay drift, child escape, global/full denial of service, context miss, full fallback, provider-application crash, cluster failover, native contract mismatch, and legacy recovery.
- The implementation updates the orchestration SQLite schema and cluster replica, current subsystem/package documentation, snapshots, and project state, and passes the repository's selected full governance verification without hidden skips.

## Risks

**Incorrect focus can be precisely wrong.** A valid grant proves what became readable, not that the selected objects were sufficient. Capabilities that require coverage need independent evaluators, required evidence classes, or full fallback before promotion or effect commit.

**Logical materialization may not reduce native KV reads.** Resident products can retain prior conversation state even when the host supplies only focused objects in a tool result. The first provider delivers correctness and observability; performance claims require native telemetry.

**Dynamic working sets increase protocol and persistence cost.** Intents, grants, working-set revisions, receipts, and events add write amplification. Content-addressed payloads, idempotent commands, bounded histories, and indexed current pointers limit the cost, but the first implementation must benchmark it.

**Address-space construction can become a new bottleneck.** Large journals need source-owned indexes and summaries; State Access must not scan every artifact on each navigation call. The first slice uses bounded run-local sources, while global catalog scaling remains separate work.

**Provider telemetry can be misleading.** A provider may report materialized tokens or KV bytes incorrectly. Provider contract tests and explicit `observationLevel` prevent logical counters from being presented as native attention measurements, but trusted deployment still depends on provider integrity.

**State-access control can become a denial-of-service channel.** A model can thrash focus, request full fallback, or probe invalid refs. Independent budgets, non-disclosing errors, host stop policy, and transaction quarantine are required.

**Version proliferation increases retention cost.** Address spaces, working sets, and semantic object versions are immutable. Retention and compaction policies must preserve every object still referenced by an active transaction, receipt, evidence record, or replay contract.

**Cross-package versioning is expensive.** Introducing V2 context, plan, child-option, and evidence records touches public contracts and persisted state. The implementation must be one dependency-closed vertical slice; partial consumers that silently ignore the new refs are not acceptable.
