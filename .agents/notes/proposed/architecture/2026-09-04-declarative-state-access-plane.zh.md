# Agent Note：声明式状态访问平面

Status: proposed

[English](2026-09-04-declarative-state-access-plane.md) | 中文

## Problem

当前持久编排链路在 Attempt 启动前编译一次有界 `ContextPacketV1`，仅把其 `contextPacketRef` 密封进 `NodeExecutionPlanV1`，随后 Resident 或 RLM 执行从这个静态投影继续运行。该机制保留了初始字节和 Lineage，却没有定义持久状态地址空间、动态 Working Set，也没有权威记录说明长程执行后续向模型暴露了哪些状态版本。

长期运行的 Agent Program 会持续积累 Artifact、Evidence、Tool Result、Child Result、Agent Message、Claim Ledger、Harness Entry、审批和恢复记录。完整保留这些历史是恢复和审计的必要条件；每轮把全部历史重新物化到模型中，则会增加 Token 压力、Context Competition 和 Compaction 损失。摘要可以缩小活跃上下文，却不能保持精确寻址，也不能证明后续 Artifact 或 Effect 建立在哪些精确版本上。

持久 RLM Runtime 已经拥有 Durable Root/Child Identity、继承的 Execution Options、Message、Goal、Heartbeat 和 Command Receipt，但尚未携带 provider-neutral 的 Address-space Ref、Working-set Revision、State-access Policy 或 Dynamic Access Receipt。因此 Child Inheritance 无法证明 Child 可读状态是 Parent Authority 与 Capability 的收窄子集。

未来推理 Provider 可能支持原生 KV-block Filtering，而当前 Codex、Claude Code 和 Model-worker Route 只能通过 Typed Bridge 或后续 Turn 逻辑物化选中对象。若把 Provider-native Token Range 或 Block Table 暴露进 Orchestration API，就会把逻辑状态身份和授权耦合到单一 Serving Engine。

Agentic Transaction Processing 还需要读侧记录。只有 Runtime 知道决策时可见的精确 Semantic Epoch 和状态版本，未来的 Effect Intent 才能在 Commit 时完成授权与新鲜度校验。Initial Context Packet 不是完整的 Dynamic Read History。

## Decision

引入 provider-neutral 的 Declarative State Access Plane。它为每个 Agent Transaction 编译不可变、版本化的状态地址空间；把模型生成的 Access Declaration 仅视为不可信 Proposal；依据 Authority、Capability、Semantic Epoch、Policy、Budget 和 Provider Limit 校验；创建不可变 Working-set Revision；追加 Access Receipt，描述 Provider 可观测的可读集合。

首个实现支持六类逻辑对象：Artifact、Evidence、Tool Result、Child Result、Agent Message 和 Claim Ledger。首版不修改 Attention Kernel。同一个 Service Definition 预留 `native-block-mask` Provider Mode，使未来 vLLM 或 SGLang Adapter 可以把 Semantic State Segment 映射到 KV Page，而无需改变 Orchestration、RLM、Capability 或 Evidence Contract。

Context Compiler 继续拥有有界 Initial Model Projection。State Access 拥有 Dispatch 之后的 Navigate、Focus、Release、Inspect、Grant、Lease、Working-set Revision、Materialization 和 Receipt。State Access 不是 Scheduler，也不替代 Retrieval、Compaction、RLM、Semantic Isolation、Capability Capsule 或 Agent Transaction Engine。

## Scope and non-goals

本提案定义 Declarative State Access 的 Public Contract、Ownership、Durability、Child Attenuation、Provider Negotiation、Failure Semantics、Migration、Observability 和 Verification。

本提案不声称模型在认知上使用了 Grant 暴露的每个对象。Logical Provider 可以证明物化了哪些对象；Native Provider 可以证明向 Attention Kernel 暴露了哪些 Segment。这两类观测均不能证明非零 Neural Attention、事实正确性、Evidence 充分性或 Mission Completion。

本提案不交付 HBM/DRAM Tiering、KV Prefetch、PagedAttention Block-table Rewrite、原生 Thinking-mode Control 或 GPU Scheduling。这些属于 Provider 能力，需要独立实现证据。

本提案不原地暴露可变共享状态。Ledger、Message Stream 或其他 Mutable Source 以不可变版本化 Snapshot 表示；后续版本必须由 Source Owner 创建新的 Address-space Revision，或通过显式 Semantic Rebase 进入新 Epoch。

## State model

Runtime 区分四层：

| 层 | Owner | 内容 | 可见性 |
| --- | --- | --- | --- |
| Journal and Artifact Store，`J` | Agent Transaction 与 Source Authority | 完整 Durable Event、Immutable Artifact、Receipt 和 Source Version | 持久，但不会自动对模型可见 |
| State Address Space，`Aτ` | Transaction `τ` 的 State Access Service | 已授权、固定版本的 Object Descriptor 与 Navigation Metadata | 不可变 Revision |
| Dynamic Working Set，`Wτ(t)` | State Access Service 与选定 Provider | Always-visible Object 与 Active Focus Grant | 不可变 Revision，另有一个 Current Pointer |
| Attention Set，`Kτ(t)` | Logical Materializer 或 Native Attention Provider | 当前阶段暴露的 Text Span、Tool Result 或 KV Page | Provider-specific，受 Working Set 限制 |

必须满足：

```text
Kτ(t) ⊆ Wτ(t) ⊆ Aτ ⊆ J
```

这里的包含关系是逻辑关系。对象可以存在于 Journal，但没有资格进入当前 Transaction Address Space。Address Space 只包含 Transaction 可以命名的精确版本。Working Set 只包含当前阶段已准入对象。Attention Set 是 Provider 对 Working Set 的实现。

所有转换在 Authority 上单调收窄：Navigate 不能暴露未授权对象；Focus 不能扩大 Address Space；Child 不能获得比 Parent 更大的 Address Space；Release 不能移除 Always-visible Object；Native Attention 不能暴露不在 Working Set 中的 Segment。

## Proposal and authority semantics

模型、RLM Child、Capability Provider 或 External Controller 可以提交 `StateAccessIntentV1`。Intent 永远不是 Authorization Token，也不能包含原始文件路径、Credential、Provider-native KV Identifier 或未验证 Content Ref。

有效可读集合是各独立 Owner 约束的交集：

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

模型只控制 `R_declared`。Host 计算其余集合，签发包含精确已准入 Object Version 和 Segment 的 Grant。Provider 遇到 Unknown、Expired、Stale Revision、Stale Term 或 Fencing 不匹配的 Grant 必须拒绝，不能 Best-effort 执行。

Always-visible Set 包含 Objective、Output Contract、Transaction Identity、State-access Policy 摘要、Unresolved Obligation，以及 Host 选定的 Authority/Safety Instruction。模型不能 Mask 或 Release 这些对象。包含 Secret 的 Authority State 只能以不含 Secret 的摘要和 Digest 表示，不能包含 Credential Material。

## Package topology

在 `packages/orchestration/` 下增加两个 Package：

| Package | 职责 |
| --- | --- |
| `@deepseek-ai/dsh-state-access` | Branded Identity、Public Schema、Strict Validator、Error、Service Definition、Source 与 Provider Interface |
| `@deepseek-ai/dsh-state-access-local` | Address-space Compiler、Working-set State Machine、Provider Registry、Command Receipt、SQLite/CAS Adapter 和 Logical Materialization Provider |

依赖方向为：

```text
context-compiler ─┐
orchestration     ├──> state-access <── state-access-local
rlm-runtime       ┤
capability-capsule┤
physical-operator ┘
```

`state-access` 不能导入 `@deepseek-ai/dsh-orchestration`，因为 Orchestration 已消费 State Access，反向依赖会形成 Cycle。跨 Package Identity 使用 Opaque Branded String，并由 Owner Adapter 验证。Object Content 继续由 Source Package 所有；State Access 保存 Descriptor 和 Ref，不创建第二份可变副本。

现有 [Domain KV storage and workspace proposal](2026-07-24-domain-kv-storage-and-workspace.md) 拥有 Durable Storage Media 与 Domain-record Semantics，不拥有 Model-visible State Selection、Access Authority、Working-set Revision 或 Attention-provider Negotiation。本提案不 supersede 它。

## Public contracts

所有跨 Package Record 均为 Versioned、Immutable、Digest-bearing、JSON-compatible，并在 Model、IPC、Provider 和 Persistence Boundary 严格校验。下列 TypeScript 形状是设计契约，不是可编译源代码。

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

`objectId` 是稳定 Semantic Identity，`objectVersion` 和 `contentSha256` 标识精确不可变 Revision。首个实现拒绝把 `secret` Object 放入 Model-visible Address Space。`segmentRefs` 是 provider-neutral Semantic Segment；物理坐标保留在 Provider-owned Mapping 后。

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

Manifest 中只出现已准入对象，不列出 Forbidden Object。Address Space 扩展创建新不可变 Revision 并保留旧 Ref。Semantic Epoch 变化必须通过显式 Semantic Rebase 创建新的 Root Address Space，不能作为普通 Revision。

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

`state.focus` 和 `state.release` 使用 `expectedWorkingSetRevision` 创建新 Working-set Revision。Runtime 单独保存 Current Pointer。Replay 返回已记录 Working-set Ref，不重新解析 Live Source State。

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

Address-space Scale 与 Working-set Scale 独立。Full Fallback 是显式、受 Budget 控制的操作，不是无界 Escape Hatch。

### StateAccessIntentV1

`StateAccessIntentV1` 是包含四种 Operation 的 Discriminated Union。每个 Member 都携带 `version`、Caller-stable `commandId`、`transactionId`、精确 `addressSpaceRef` 和 `expectedWorkingSetRevision`。

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

`purpose` 是 Audit Metadata，不能扩大 Authority。`navigate` 返回有界 Descriptor 和 Summary，不返回 Body。`inspect` 返回 Revision、Active Grant、Budget 和 Counter，但不泄露不可访问 Object Identity。

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

Denied Entry 使用 Request Digest，不回显未授权名称。默认 Focus 为 All-or-nothing。只有 Capability Contract 和 Policy 都允许时，Partial Focus 才合法。

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

对 Logical Materialization，Observed Read Set 表示通过 Model-visible Projection 或 Tool Result 交付的精确 Object。对 Native Block Mask，表示暴露给 Attention Kernel 的精确 Segment。Receipt 永远不声称 Cognitive Use 或事实正确性。

若 Provider Application 后、Receipt Persist 前 Crash，Command 进入 `indeterminate`。Recovery 根据 Command 和 Grant Identity 调用 Provider Reconciliation，不能 Blind Reapply。

## Provider SPI

Service Definition 显式注册 Materialization Provider。重复 Provider ID 失败，Registration 跟随 Cordis Lifecycle，路由不能依赖注册顺序。

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

`apply` 只接收 Host-issued Grant 和 Host-resolved Material，不能解析 Authority 或 Live Semantic Version。即使 Logical Provider 也必须实现 `reconcile`。`close` 幂等，且不删除 Durable Manifest、Working Set、Grant 或 Receipt。

首个 Provider 是 `logical-materialization`。它创建有界、带 Source Label 和 Digest 的 Materialization Artifact，通过 Typed Model-tool Bridge 或 Host Continuation 暴露。当 Resident Product 内部保留既有 Context 时，它不能声称降低 Native KV Read。

未来 `native-block-mask` Provider 消费从 Semantic Segment 到 Token Span/KV Page 的 Digest-verified Mapping。若 Mapping 属于其他 Model Route、Tokenizer、Prompt-prefix Digest、Semantic Epoch、Provider Session 或 Session Revision，必须拒绝。

## Context Compiler evolution

不能重新解释 `ContextPacketV1`。增加 `ContextPacketV2`，迁移期间 Reader 接受 V1 或 V2。V2 保留当前 Objective、Task、Source、Lineage、Redaction、Compiler 和 Digest Field，并增加：

```text
stateAccess: {
  addressSpaceRef: StateAddressSpaceRef
  initialWorkingSetRef: StateWorkingSetRef
  stateAccessPolicyRef: StateAccessPolicyRef
  initialAccessReceiptRefs: StateAccessReceiptRef[]
}
```

Packet Token Budget 适用于 Initial Working-set Materialization，而不是全部 Addressable State。如果 Always-visible Object 本身超过 Budget，Compiler 必须拒绝。

Preparation 顺序变为：

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

不能重新解释 `NodeExecutionPlanV1` 或 `OrchestrationExecutionEvidenceV1`。增加 V2 Record，并保持 Legacy Artifact 可读。

`NodeExecutionPlanV2` 增加 `NodeStateAccessPlanV1`，包含 `addressSpaceRef`、`initialWorkingSetRef`、`stateAccessPolicyRef`、`materializationProviderId`、精确 Provider-offer Ref、可选 Bridge Ref、Semantic Epoch 和 Plan Digest。

`OrchestrationExecutionEvidenceV2` 增加 Final Address-space Ref、Final Working-set Ref、全部 Access-receipt Ref、`observedReadSetSha256`、Semantic Epoch，以及 `complete`、`degraded` 或 `unknown` 的 Access-completeness Disposition。Legacy V1 Evidence 为 `unknown`；Migration 不能从 Initial Prompt 或 Transcript 推导 Dynamic Read History。

Scheduler 继续拥有 Dependency、Readiness、Attempt Generation、Scope Conflict 和 Physical Dispatch。State Access 不成为另一个 Scheduler。每个 Model-visible Navigation、Materialization、Fallback、Denial、Release 与 Inspect Result 都必须能从 Session 或 Orchestration Event Log 重建。

## RLM integration

通过 Typed RLM Host 暴露四个 Operation：

| Operation | Result | Mutation |
| --- | --- | --- |
| `state.navigate` | 有界 Authorized Descriptor、Summary、Version 和 Lineage Hint | 仅 Receipt 与 Counter |
| `state.focus` | Materialization Handle 与已准入精确版本 | 新 Working-set Revision 与可选 Lease |
| `state.release` | Resulting Working-set Metadata | 新 Working-set Revision；Always-visible Object 保留 |
| `state.inspect` | Address-space Revision、Working-set Revision、Grant、Budget 和 Counter | 仅 Receipt |

Tool Schema 不能接受 Raw Content Ref、Path、SQLite Key、Secret 或 Provider-native Block ID。RLM Command ID 根据 Durable Session Identity、Cell Command 与 Call Ordinal 推导。相同 Command 与 Request Digest 重复时返回原 Result；相同 Command ID 携带另一 Digest 时失败 `STATE_ACCESS_COMMAND_CONFLICT`。

增加 `RlmChildExecutionOptionsV2` 和 State-aware RLM Session Snapshot，携带 `addressSpaceRef`、`workingSetRef`、`stateAccessPolicyRef` 和 `semanticEpoch`。Daemon Recovery 后 Host Rebind 使用精确持久 Ref，不从 Live State 编译 Replacement。

## Child attenuation

Host 按下式推导 Child Address Space：

```text
A_child = requested_child_objects
        ∩ A_parent
        ∩ child_authority
        ∩ child_capabilities
        ∩ child_policy
```

Child 获得含 `parentAddressSpaceRef` 的新不可变 Manifest。除非 Spawn Request 显式选择对象并由 Host 准入 Initial Child Working Set，否则 Child 不继承 Parent Focus Grant 或 Transaction-private Local Working State。

Runtime 在创建时证明 `objects(A_child) ⊆ objects(A_parent)`，且 Semantic Epoch 相同。Address-space Extension 是独立 Durable Request，路由给 Parent 或 Orchestration Authority。跨 Epoch Child Work 需要 Semantic Rebase 或新的 Child Transaction。

## Capability context-access contract

扩展 Capability Capsule Semantics，增加 `ContextAccessContractV1`：

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

Global Aggregate 与 Streaming-transform Capability 可以禁止 Selective Focus，并要求 Complete Scan。Citation 与 Evidence-checking Capability 可以要求 Exact Focus 与最低 Coverage Disposition。Safety Policy、Goal Lock、Authority Summary、Output Schema 和 Unresolved Obligation 始终可见。

当 Capsule 要求 Native Block Mask，而选定 Physical Route 不提供；或 Capability 与 Graph Access Policy 冲突时，Capability Resolution 必须失败。Effective Contract 被密封进 Capability Binding Plan 和 Node Plan。

## Physical operator negotiation

扩展 `PhysicalOperatorResidentCatalog`，增加可选 `AttentionControlOfferV1`：

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

缺少 Offer 等价于 `none`。当 Physical Operator 支持 Model Tool 时，可以通过 Owner-local Typed Bridge 选择 Logical Provider。Graph 要求 `native-block-mask` 而无合格 Offer 时必须 Admission Failure，不能静默降级为 Prompt-only Instruction。

Node Plan 记录选定 Mode 和精确 Offer Digest。Retry 若 Product Version、Protocol Hash、Tokenizer、Model Route 或 Attention Offer 变化，必须进行 Semantic Compatibility Admission。

## Effect read basis

未来 Agent Transaction 的 `EffectIntentV1` 携带 `EffectReadBasisV1`：

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

Commit Admission 验证全部 Receipt 属于同一 Transaction 与 Attempt，使用同一 Semantic Epoch，引用已准入 Address Space，并通过 Digest Validation。Immutable Evidence Object 不需要 Live Reread；标记 `mustRemainCurrent` 的 Policy、Approval、Budget、Lease 和其他 Mutable Authority Input 由 Owner 在 Commit 时重新校验。

要求 Access Receipt 或 Evidence Coverage 的 Capability，在 Read Basis 缺失、Degraded 过度，或仅来自 Dynamic Access Unknown 的 Legacy V1 State 时，不能 Promote Final Artifact 或 Commit External Effect。Receipt 提供 Causal Lineage，不提供 Truth；Independent Evaluator 仍负责充分性和正确性。

## Durability and cluster replication

Immutable Object、Policy、Address-space Manifest、Intent、Grant、Working-set Snapshot、Provider Plan、Observation 和 Receipt 以 Content-addressed Artifact 保存。SQLite 保存 Index、Command Lifecycle、Current Pointer 和 Lease，不复制 Payload。

增加以下 Indexed Table，并纳入 `REPLICA_TABLES`、Deletion Order、Schema Creation、Export、Validation 和 Install：

| Table | Purpose |
| --- | --- |
| `state_objects` | Object Ref、Owner Coordinate、Kind、Semantic Epoch 与 Creation Time |
| `state_address_spaces` | 按 Transaction、Revision、Parent、Epoch 和 Authority Revision 索引 Manifest Ref |
| `state_working_sets` | 按 Transaction/Revision 索引 Working-set Ref 与 Current Pointer Marker |
| `state_access_commands` | Command ID、Request Digest、Lifecycle、Intent/Grant/Receipt Ref、Error 与 Timestamp |
| `state_access_leases` | Grant、Transaction、Authority Revision、Cluster Term、Expiry 与 Release State |
| `state_access_receipts` | 按 Run、Node、Attempt、Session 与 Command 索引 Append-only Receipt Ref |

Grant Acceptance、Command Acceptance 和 Current Working-set Pointer Update 在同一 SQLite Transaction 中发生。Provider Application 位于 Durable `accepted` 之后。Provider Observation、Receipt 与 `settled` Command State 再一同持久化。中间 Crash 进入 `indeterminate`，仅通过 Provider Reconciliation 结算。

Cluster Term 和 Authority Revision 对 Grant 执行 Fencing。Former Leader 失去 Authority 后不能 Apply 或 Renew Grant。Logical Materialization 同样需要 Fencing，因为旧 Daemon 暴露已禁止 Confidential State 属于安全故障。

## Versioning and migration

- 保持 `ContextPacketV1` 可读；新的 State-aware Attempt 生成 `ContextPacketV2`。
- 保持 `NodeExecutionPlanV1` 可读；新的 State-aware Attempt 生成 V2。
- 保持 `RlmChildExecutionOptionsV1` 可读；State-aware Root 与 Child 使用 V2。
- 保持 `OrchestrationExecutionEvidenceV1` 可读，Access Completeness 为 `unknown`；新 Attempt 生成 V2。
- 通过显式 Forward Migration 从 Orchestration SQLite Schema Version 4 前进，保留全部既有 Row 与 Artifact。
- 缺少 State Access Ref 的既有 RLM Session 继续作为 Legacy Static-context Session。Host Rebind 不伪造 Address Space 或 Receipt。

Migration 不能从 Prompt 或 Transcript 推导 Observed Read Set，因为 Model-visible Input 不等同于 Provider-observed Access History。

## Error semantics

Public Error Vocabulary 包括：

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

除非 Caller 拥有 Catalog-inspection Authority，Unknown 与 Unauthorized Object Ref 使用相同 Model-visible Message。Epoch Conflict、Authority Denial、Capability Denial、Replay Drift 和 Required Provider Mode Unsupported 均 Fail Closed。Miss 按密封 Policy 处理。Budget Failure 不能自动提高 Limit。

## Security and abuse controls

State-object Ref 为 Opaque、Capability-scoped。模型不能枚举 Journal、Filesystem、Artifact Directory、SQLite Table 或其他 Tenant。Navigation 只能在预编译 Authorized Catalog 中运行。

Full Fallback Count、Focused Object Count、Materialized Token/Byte、Transition Count 和 Navigation Result Count 分别独立受 Budget 控制。Focus Thrashing、Repeated Full Fallback 与 Invalid-ref Probing 产生有界 Event 和 Counter，可触发 Stop 或 Quarantine。

Prompt 或 Tool-result Text 中出现 Object ID 仍然只是 Data，不能授予 Access。Materialized Content 保留 Source Boundary、Version、Digest、Sensitivity 和 Lineage；Provider 不能把 Untrusted Source 拼接成与 Host Instruction 无法区分的内容。

## Observability

记录有界 Metric 与 Event：Address-space Size、Working-set Size、Materialized Token/Byte、Navigate/Focus Latency、Miss、Fallback、Denied Request、Transition、Provider Mode、Grant Expiry、Reconciliation 和 Access Completeness。

Native Provider 可以额外报告 Attended Token Position、KV Byte、Block Count、Residency、Prefetch Hit 和 Offload Byte。Provider 不提供权威 Telemetry 时，这些字段保持缺失而非估算。

Public Event 不能包含 Secret Object Name、Raw Confidential Content、Provider-native Address、Credential 或 Hidden Reasoning。允许 Opaque Ref、Count、Digest 和已经准入模型的 Summary。

## Verification design

| Scenario | Required result |
| --- | --- |
| Wrong focus | 合法但不充分的 Focus 有 Receipt；Coverage Requirement 阻止 Promotion 或执行密封 Fallback，不能声称 Complete |
| Unauthorized object | Navigation 不揭示对象；Direct Focus 返回 Non-disclosing Denial，且不创建 Working-set Revision |
| Cross-epoch read | Grant 在 Provider Application 前被拒绝 |
| Replay drift | 重复 Settled Command 返回原 Ref；Pinned Materialization 不可用时失败 `STATE_ACCESS_REPLAY_DRIFT`，不能解析 Live Replacement |
| Child escape | Parent Space 或 Child Attenuation 外的 Object 被拒绝；Child Manifest 不包含它 |
| Global/full DoS | Transition 与 Full-fallback Budget 阻止重复扩张，且永不自增 |
| Context miss | 执行并记录密封 Miss Policy |
| Full fallback | 仅在 Token/Byte Ceiling 内物化完整 Authorized Address Space，并记录 `fallback: full` |
| Provider-application crash | Command 进入 Indeterminate；Reconciliation 在 Applied、Not-applied 或 Unknown 间结算，不能 Blind Reapply |
| Cluster failover | Old-term Grant 不能 Apply/Renew；New Leader 恢复 Current Pointer 与 Receipt |
| Native provider mismatch | Stub Provider 拒绝不匹配 Tokenizer、Prompt Prefix、Model Route、Segment Map、Session Revision 或 Expiry |
| Legacy recovery | V1 Session 与 Evidence 可读，Access Completeness 为 `unknown`，不创建 Synthetic Receipt |

## Alternatives considered

**给 `ContextPacketV1` 增加更多 Inline Material。** 这仍是静态投影并增加 Token 压力，无法提供 Dynamic Revision、Child Attenuation、Provider Negotiation、Idempotent Command 或 Read Receipt。

**只把 Navigation 放进 RLM。** 标准 Node、Debate Synthesis、未来 Agent Program Executor 和非 RLM Physical Operator 同样需要 State Access。RLM 消费 Capability，但不拥有 State Identity、Authority、Persistence 或 Provider Routing。

**使用 Retrieval 作为 Access Contract。** Retrieval 对候选排序，但不定义 Authorized Address Space、Exact Version、Working-set Lifetime、Receipt、Child Attenuation 或 Physical Attention Placement。

**只使用 Compaction 和 Summary。** Compaction 有损，不能建立哪些精确版本变为可读的记录。Summary 是 Navigation Aid，不替代 Exact Ref。

**向模型暴露 KV-block ID。** Physical Coordinate 会随 Tokenizer、Prompt Prefix、Model Route、Block Size、Compaction 和 Recovery 变化。模型命名 Semantic Object，Provider 拥有 Physical Mapping。

**把 Prompt Tag 当作 Authority。** Free-form Tag 不是 Durable Command，易受 Syntax Error 与 Injection 影响，也不能支持 Idempotent Recovery。未来 Reserved Control Token 仍需 Typed Grant 与 Receipt。

**始终暴露完整 History。** 该模式保留为 Correctness Baseline 与显式 Fallback，但会把 Durable History Growth 与 Active-context Growth 耦合。

**把全部 Payload 保存为 Mutable SQLite JSON。** Immutable Manifest、Working Set、Grant 与 Receipt 属于 Artifact Plane。SQLite 负责 Index 和 Coordination；复制 Payload 会形成两个 Source of Truth。

## First implementation slice

增加两个 Package 和 Owner-local Logical Materialization Provider。集成一条完整 State-aware RLM Root/Child Path，其 Address Space 包含 Upstream Artifact/Evidence、Durable RLM Message、Settled Child-result Artifact，以及存在时的 Debate Claim Ledger。暴露四个 Typed Tool，持久化并复制 State Access State，并证明：

- Child 获得 Attenuated Address Space；
- Focus 让精确 Object Version 带 Receipt 进入 Model-visible Projection；
- Release 创建新的不可变 Working-set Revision；
- Daemon Recovery 重新绑定相同 Ref；
- 测试 Effect Intent 可以绑定记录的 Read Basis，但首片不实现 External Effect Commit。

本 Note 保持 `proposed`。只有 Public Contract、Persistence、Integration、Test、Package Documentation、Generated Reference、Snapshot 和 Full Governance Attestation 全部交付后，才移动到 `implemented/architecture`。

## Acceptance criteria

- `StateObjectV1`、`StateAddressSpaceManifestV1`、`StateAccessIntentV1`、`StateAccessGrantV1` 和 `StateAccessReceiptV1` 成为 Public、Versioned、Branded、Digest-bearing Contract，并有严格 Boundary Validation。
- 实现强制 `Attention Set ⊆ Working Set ⊆ Address Space ⊆ Journal`，且不声称 Neural Attention 或事实正确性。
- 每个模型 Declaration 都是不可信 Proposal；Effective Access 与 Authority、Capability、Semantic Epoch、Policy、Budget 和 Provider Limit 取交集。
- `ContextPacketV2` 携带 `addressSpaceRef`、`initialWorkingSetRef` 与 `stateAccessPolicyRef`；Legacy V1 Artifact 保持可读且不被重新解释。
- `NodeExecutionPlanV2`、`RlmChildExecutionOptionsV2` 和 `OrchestrationExecutionEvidenceV2` 携带 State Access Ref、Semantic Epoch、Provider Mode、Receipt Ref 与 Access Completeness。
- RLM 通过 Typed Bridge 暴露 `state.navigate`、`state.focus`、`state.release` 和 `state.inspect`，具备 Idempotent Command Receipt 与可重建 Model-visible Event。
- Child Derivation 证明 Authority- 与 Capability-narrowed Subset，且不隐式继承 Active Focus Grant。
- Capability Resolution 执行 `ContextAccessContractV1`；Physical Operator Catalog 暴露可选 `AttentionControlOfferV1`，Required Native Control 不可用时 Fail Loud。
- Provider Routing 支持 `logical-materialization` 和 `native-block-mask`；首个 Shipped Provider 只实现 Logical Materialization，不做 KV Performance Claim。
- 未来 Effect Intent 可以绑定 Access Receipt 与 `observedReadSetSha256`；Commit Admission 校验 Transaction、Attempt、Epoch、Authority Revision 与 Required Freshness。
- SQLite Migration 与 Cluster Replication 覆盖全部 State Access Index、Pointer、Command、Lease、Receipt、Artifact 和 Fencing State。
- Test 覆盖 Wrong Focus、Unauthorized Object、Cross-epoch Read、Replay Drift、Child Escape、Global/full DoS、Context Miss、Full Fallback、Crash Reconciliation、Cluster Failover、Native-provider Mismatch 和 Legacy Recovery。
- Model-visible State Access Result 被记录；Keyless Snapshot 覆盖组装链路；Full Repository Governance Verification 与 Attestation 无隐藏 Skip 地通过。

## Risks

**精确 Focus 仍可能错误。** Grant 证明什么变得可读，不证明 Selection 充分。Coverage-sensitive Capability 在 Promotion 或 Effect Commit 前需要 Independent Evaluator 或 Full Fallback。

**Logical Materialization 可能不减少 Native KV Read。** Resident Product 可能保留旧 History。首个 Provider 改善 Control 与 Observability；Native Performance Claim 需要权威 Telemetry。

**Dynamic Working Set 增加 Write Amplification。** Intent、Grant、Revision、Receipt 和 Event 增加持久化成本。Content-addressed Payload、Bounded History、Indexed Pointer 与 Idempotent Command 只能限制，不能消除该成本。

**Address-space Construction 可能成为瓶颈。** 大型 Journal 需要 Source-owned Index 与 Summary。首片只处理 Bounded Run-local Source；Global Catalog Scaling 是独立工作。

**Provider Telemetry 可能错误。** `observationLevel` 防止把 Logical Counter 描述成 Native Attention Measurement，但 Trusted Deployment 仍依赖 Provider Integrity 与 Contract Test。

**Control Channel 可被滥用。** Focus Thrashing、Invalid-ref Probing 与 Full-fallback Loop 需要独立 Budget、Host Stop Policy 与 Quarantine。

**Immutable Version 增加 Retention Cost。** Retention 与 Compaction 必须保留仍被 Active Transaction、Receipt、Evidence Record 或 Replay Contract 引用的对象。

**Cross-package V2 Migration 成本高。** Context、Plan、RLM Child Option、Evidence、Store Schema、Event、Docs 和 Snapshot 必须作为一个 Dependency-closed Vertical Slice 交付。部分 Consumer 静默忽略新 Ref 不可接受。
