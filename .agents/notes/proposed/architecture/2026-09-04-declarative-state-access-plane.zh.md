# Agent Note: 声明式状态访问平面

Status: proposed

[English](2026-09-04-declarative-state-access-plane.md) | 中文

## Problem

当前持久编排链路会在 Attempt 启动前编译一次有界的 [`ContextPacketV1`](../../../../packages/orchestration/context-compiler/src/types.ts)，并仅将其 `contextPacketRef` 密封进 [`NodeExecutionPlanV1`](../../../../packages/orchestration/orchestration/src/index.ts)，随后 Resident 或 RLM 执行从这个静态投影继续运行。该机制能够保留初始上下文字节和 Lineage，但没有定义持久状态地址空间、动态 Working Set，也没有权威记录说明长程执行后续向模型暴露了哪些状态版本。

长期运行的 Agent Program 会持续积累 Artifact、Evidence、Tool Result、Child Result、Agent Message、Claim Ledger、Harness Entry、审批和恢复记录。完整保存这些历史是恢复与审计的必要条件，但每轮把全部历史重新物化进模型会增加 Token 成本、Context Competition 和 Compaction 压力。摘要或截断虽然减小活跃上下文，却会破坏精确寻址，也无法证明后续 Effect 或 Artifact 是基于哪些精确版本形成的。

持久 RLM Runtime 已经携带密封的 Child Execution Options、持久 Child Identity、Message、Goal、Heartbeat 和 Command Receipt，但其模型侧 Host Request 仍解析 Live Resource，且没有 provider-neutral 的状态访问契约。Child 可以继承 Parent Execution Options，同时仍通过后续 Host Call 看到新解析的状态。因此，Runtime 缺少从 Parent Authority 推导 Child 可读状态空间的精确规则。

未来推理 Provider 可能实现原生 KV Block Filtering 或 Prefetch，而当前 Codex、Claude Code 和 Model Worker Provider 只能通过 Typed Tool Bridge 或后续 Turn 逻辑物化选中对象。若编排 API 直接绑定某个推理引擎的 Block Table，就会把逻辑状态身份、授权与物理 Attention Placement 混在一起。

Agentic Transaction Processing 还需要读侧记录。只有 Runtime 能识别决策时可见的精确 Semantic Epoch 和状态版本，Effect Intent 才能在 Commit 时完成授权与新鲜度校验。当前 Context Packet 只能证明初始投影，不能证明长程 RLM 执行期间后续暴露的 State Object。

## Proposal

引入 provider-neutral 的 Declarative State Access Plane。它为每个 Agent Transaction 编译不可变、版本化的状态地址空间；把模型生成的 State Access Declaration 仅视为不可信 Proposal；根据 Transaction 的 Authority、Capability、Semantic Epoch、Policy、Budget 和 Provider 限制校验每个 Proposal；物化一个精确 Working Set Revision；并追加 Access Receipt，记录 Provider 可观测的可读集合。

首个实现将支持六类逻辑 State Object：Artifact、Evidence、Tool Result、Child Result、Agent Message 和 Claim Ledger。首版不会修改 Attention Kernel。同一个 Service Definition 将预留可选的 `native-block-mask` Provider Mode，使未来的 vLLM 或 SGLang Adapter 能把版本化状态 Segment 映射到 KV Page，而无需改变 Orchestration、RLM、Capability 或 Evidence 契约。

Context Compiler 继续负责有界的初始模型投影。它将消费 Address Space Ref 和 Initial Working Set Ref，而不是把所有潜在有用状态都视为 Inline Source Material。Dispatch 之后的动态 Navigate、Focus、Release、Inspect、Grant、Lease 和 Receipt 由 State Access Service 所有。

### Scope and non-goals

本提案定义 Declarative State Access 的逻辑契约、所有权、版本、持久化、Child 权限收窄、Provider 协商、错误语义和必要验证。

本提案不声称模型使用或在认知上依赖了 Grant 暴露的每个对象。Logical Provider 可以证明 Materialization；Native Provider 可以证明其 Kernel 允许读取哪些 KV Segment。这两种观测都不能证明 Attention Weight、事实正确性、Evidence 完整性或 Mission Success。

本提案不替代 Retrieval、Compaction、RLM、Context Compiler、Semantic Isolation、Capability Capsule 或 Agent Transaction Engine。Retrieval 决定候选状态；Compaction 管理表示生命周期；RLM 生成计算和 Child 拓扑；State Access 控制当前可读集合；Semantic Isolation 固定版本；Agent Transaction Engine 协调状态和 Effect。

本提案不交付 HBM/DRAM Tiering、KV Prefetch、PagedAttention Block-table Rewrite、原生 Thinking Mode 控制或 GPU Scheduling。这些能力保留在 Provider 接口之后，并需要独立实现证据。

本提案不把可变共享状态作为可原地修改的模型可见对象。可变 Ledger 或 Message Stream 以不可变版本化 Snapshot 暴露；后续版本必须由其 Owner 根据规则创建 Address Space Revision 或 Semantic Rebase。

### Four state layers

Runtime 将区分四层，而不再用 `context` 同时指代所有持久状态和模型可见信息：

| 层 | Owner | 内容 | 修改与可见性 |
| --- | --- | --- | --- |
| Journal and Artifact Store，`J` | Agent Transaction 与 Source Authority | 完整持久 Event、不可变 Artifact、Receipt 和 Source Version | Append-only 或 Content-addressed；不会自动对模型可见 |
| State Address Space，`Aτ` | Transaction `τ` 的 State Access Service | 已授权、固定版本的 State Object Descriptor 与 Navigation Metadata | 不可变 Revision；仅 Host 可扩展或 Rebase |
| Dynamic Working Set，`Wτ(t)` | State Access Service 与选定 Provider | Always-visible Object 与当前 Focus Grant | 版本化 Revision；只由已准入的 Access Command 修改 |
| Attention Set，`Kτ(t)` | Materialization 或 Native Attention Provider | 当前阶段暴露的 Text Span、Model-tool Result 或 KV Page | Provider-specific，且受 Working Set 限制 |

必须满足：

```text
Kτ(t) ⊆ Wτ(t) ⊆ Aτ ⊆ J
```

`J` 是逻辑超集：对象可以存在于 Journal 中，但不一定有资格进入 Transaction Address Space。`Aτ` 只包含 Transaction 可以命名的精确版本。`Wτ(t)` 只包含当前阶段被准入的对象。`Kτ(t)` 是 Provider 对 Working Set 的物理或逻辑实现。

每个转换都必须在 Authority 上单调收窄：Navigate 不能发现未授权对象；Focus 不能扩大 Address Space；Child 不能获得比 Parent 更大的 Address Space；Release 不能移除 Always-visible Object；Native Attention 不能暴露不在当前 Working Set 中的 Segment。

### Proposal and authority rule

模型、RLM Child、Capability Provider 或 External Controller 可以提交 `StateAccessIntentV1`。Intent 永远不是授权 Token，也不能携带原始文件路径、Secret、Provider-native KV Identifier 或未验证 Content Ref。

有效可读集合是独立约束的交集：

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

除 `R_declared` 外，所有集合均由 Host 计算。Provider 只能收到包含精确已准入 Object Version 和 Segment 的 `StateAccessGrantV1`。Provider 遇到未知、过期、Revision 过时或 Fencing 不匹配的 Grant 必须拒绝，而不是尝试 Best-effort Access。

Always-visible Set 包含 Task Objective、Output Contract、当前 Transaction Identity、State Access Policy 摘要、未完成 Obligation，以及由 Runtime Owner 选定的安全或 Authority Instruction。模型不能 Release、替换或 Mask 这些对象。包含 Secret 的 Authority State 只能表示为不含 Secret 的摘要和 Digest，不能包含 Credential Material。

### Package topology and ownership

在 `packages/orchestration/` 下增加两个 Package：

| Package | 职责 |
| --- | --- |
| `@deepseek-ai/dsh-state-access` | Branded Identity、Public Schema、Error Vocabulary、Service Definition、Object Source 与 Materialization Provider Interface |
| `@deepseek-ai/dsh-state-access-local` | Owner-local Address Space Compiler、Working Set State Machine、Command Receipt、SQLite/CAS Adapter、Logical Materialization Provider 和 Provider Registry |

依赖方向为：

```text
context-compiler ─┐
orchestration     ├──> state-access <── state-access-local
rlm-runtime       ┤
capability-capsule┤
physical-operator ┘
```

`state-access` 仅依赖 `@deepseek-ai/dsh-brand`、Cordis 和 JSON-compatible Contract 等稳定下层类型。它不导入 `@deepseek-ai/dsh-orchestration`，因为 Orchestration 已消费 State Access，反向依赖会形成 Cycle。跨 Package Ref 使用 Opaque Branded String，并由 Owner Adapter 校验。

`state-access-local` 可以通过注入的 Owner Adapter 使用 Orchestration Store，但 Public State Access Service Definition 不知道 SQLite Table 或 Orchestration Artifact Path。现有 [Domain KV storage proposal](2026-07-24-domain-kv-storage-and-workspace.md) 负责 Durable Storage Media 和 Domain Record，不负责 Model-visible State Selection、Access Authority、Working Set Revision 或 Attention Provider。本提案不 supersede 该提案。

Object Content 继续由 Source Package 所有。State Access 保存 Descriptor 和 Ref，不复制 Source Authority，也不创建第二份可变副本。初始 Source Adapter 包括 Orchestration Artifact/Evidence、RLM Child Result 与 Message、Physical Tool-result Artifact，以及 Debate Claim Ledger。

### Public identities and common records

Service Definition 将为所有 Durable Cross-package Identity 引入 Branded Ref：

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

除显式命名 Lease 的类型外，Ref 均指向不可变、通过 Digest 校验的数据。Caller 不能从 Ref 推断文件路径、Table Row、Model Token Range 或 Provider-native Block Identifier。

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

`objectId` 是稳定 Semantic Identity，`objectVersion` 与 `contentSha256` 标识精确不可变 Revision。除非 Policy 把多个历史版本显式建模为不同 Identity，一个 Address Space 对同一 Object Identity 只能包含一个版本。`segmentRefs` 是 provider-neutral 的 Semantic Segment；Native Provider 可通过另一个带 Digest 的 Map 把它们映射到 Token Span 或 KV Page。

首个实现将拒绝把 `sensitivity: 'secret'` Object 放入 Model-visible Address Space。未来的 Confidential-object Support 需要显式 Provider Confidentiality Contract，不能从模型请求推断授权。

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

Manifest 中只出现已准入 Object。Forbidden Object 由 Authority Envelope 中的 Authority-scope Digest 表示，不暴露可发现的 Object Name。扩展操作创建新的不可变 Manifest Revision 并保留旧 Ref；它不能修改既有 Manifest。Semantic Epoch 变化需要显式 Semantic Rebase 和新的 Root Address Space，而不是普通 Revision。

`sourceCursorRefs` 使 Owner 能确定性加入新 Settled Child Result、Message 或 Claim-ledger Version。扩展操作记录每个新 Object 来自哪个 Source Cursor，并拒绝具有冲突版本的重复 Semantic Identity。

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

Working Set 是不可变对象。`state.focus` 和 `state.release` 通过 `expectedWorkingSetRevision` 的 Optimistic Concurrency 创建新 Revision。Runtime 单独保存 Current Pointer。重放一个已完成 Command 时返回已经记录的 Working-set Ref，不重新解析 Live Source State。

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

Policy 分离 Address Space Scale 与 Working Set Scale。一个 Transaction 可以寻址大量 Object，但只能准入有界 Focus Object、Materialized Token 和 Materialized Byte。Full Fallback 是显式、受 Budget 控制的操作，不是无界 Escape Hatch。

### `StateAccessIntentV1`

`StateAccessIntentV1` 是在 Hostile Model/Tool 或 Wire Boundary 接收的 Discriminated Union。每个 Member 都携带 Caller-stable `commandId`、Transaction Identity、精确 Address-space Ref 和 Expected Working-set Revision。

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

`purpose` 是审计 Metadata，未来可以用于 Policy Evaluation，但不能扩大 Authority。`navigate` 返回有界 Descriptor 和 Summary，不返回 Object Body。`inspect` 返回 Address-space 和 Budget Metadata、Active Grant、Working-set Revision、Miss 和 Fallback Counter，但不能泄露不可访问 Object Identity。

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

Denied Entry 使用 Request Digest，不回显未授权名称。当 Capability 要求 Exactness 时，混合 Focus Request 可以整体拒绝；只有 Policy 和 Capability Context Contract 都允许时，才能 Best-effort Partial Focus。默认 Focus 为 All-or-nothing。

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

对于 `logical-materialization`，`observedReadSet` 表示通过 Model-visible Projection 或 Tool Result 交付的精确 Object。对于 `native-block-mask`，它表示 Provider 暴露给 Attention Kernel 的精确 Segment。该字段永远不声称模型分配了非零 Attention，也不声称模型在答案中使用了这些信息。

Receipt 是不可变、Append-only 的。Command 若在 Provider Application 之后、Receipt Persist 之前 Crash，则进入 `indeterminate`；恢复时使用 Command 和 Grant Identity 调用 Provider `reconcile`，不能盲目重复 Apply Grant。

### Provider contract

Service Definition 将暴露 Materialization Provider 注册。Registration 是 Cordis Effect；重复 Provider ID 失败；路由显式指定，不能依赖注册顺序。

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

`apply` 只接收 Host-issued Grant 和已解析 Object Material，不解析 Authority 或 Live Semantic Version。即使是 Logical Provider，`reconcile` 也必须存在，使 Command Receipt 和 Model-visible Delivery 可恢复。`close` 幂等，且不删除 Address-space、Working-set、Intent、Grant 或 Receipt Artifact。

Owner-local Provider 将实现 `logical-materialization`。它构建有界、带 Source Label 和 Digest 的 Materialization Artifact，并通过现有 Typed Model-tool Bridge 或 Host Continuation 暴露。它不能把无 Label 状态直接拼接进 Native History。

未来 Native Provider 将实现 `native-block-mask`。它消费从 State Segment 到 Token Span 和 Provider-native KV Page 的 Digest-verified Mapping。若 Mapping 属于另一 Model Route、Tokenizer、Prompt Prefix、Semantic Epoch 或 Provider Session，必须拒绝。

### Context Compiler evolution

不能原地修改持久化的 `ContextPacketV1` 契约。引入 `ContextPacketV2`，迁移期间 Reader 接受 `ContextPacketV1 | ContextPacketV2`。

`ContextPacketV2` 保留当前 Objective、Task、Included Source、Initial Source Material、Lineage、Redaction、Compiler 和 Digest Field，并增加：

```ts ignore-check
export interface ContextPacketV2StateAccess {
  readonly addressSpaceRef: StateAddressSpaceRef
  readonly initialWorkingSetRef: StateWorkingSetRef
  readonly stateAccessPolicyRef: StateAccessPolicyRef
  readonly initialAccessReceiptRefs: readonly StateAccessReceiptRef[]
}
```

Packet Token Budget 仅适用于 Initial Working-set Materialization。Addressable Object 可以超过该 Token Budget，因为在 Focus 前它们只由 Descriptor 和 Summary 表示。如果 Always-visible Object 本身超过 Budget，Compiler 必须拒绝 Initial Working Set。

Orchestration Preparation 顺序变为：

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

不能原地修改 `NodeExecutionPlanV1` 或 `OrchestrationExecutionEvidenceV1`。引入 V2 Record，并保持 Legacy Artifact 可读，不能伪造 Access History。

`NodeExecutionPlanV2` 将增加：

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

`OrchestrationExecutionEvidenceV2` 将增加 Final Address-space Ref、Final Working-set Ref、全部 Access-receipt Ref、`observedReadSetSha256`、Semantic Epoch，以及 `complete`、`degraded` 或 `unknown` 的 Access-completeness Disposition。Legacy V1 Evidence 的状态是 `unknown`；迁移不能把其 Initial Context Packet 解释成完整 Dynamic Read History。

Scheduler 继续拥有 TaskGraph Dependency、Readiness、Attempt Generation 和 Physical Operator Dispatch。State Access 不成为另一个 Scheduler。Orchestration Daemon 拥有 Adapter，把 Upstream Evidence、Child Result、Message 和 Claim Ledger 转为 Source-owned State-object Descriptor。

每个 Model-visible Navigation Result、Focus Materialization、Fallback、Denial、Release 和 Inspection Result 都必须可以从 Session 或 Orchestration Event Log 重建，从而保持仓库的 Model-visible-equals-logged Invariant。

### RLM model tools

通过 Typed RLM Host Bridge 增加四个 Model-facing Operation：

| Operation | Input | Result | State change |
| --- | --- | --- | --- |
| `state.navigate` | 有界 Query、Kind Filter、Cursor、Limit | Descriptor、Summary、Version、Lineage Hint | 除 Receipt/Counter 外无状态变化 |
| `state.focus` | 精确 Object Ref、可选 Segment Ref、Budget 与 Miss Policy | Materialization Handle 与已准入 Object Version | 创建 Working-set Revision 和可选 Lease |
| `state.release` | Grant Ref 或 Focused Object Ref | Resulting Working-set Metadata | 创建 Working-set Revision；不能 Release Always-visible Object |
| `state.inspect` | 无 Content Selector | Address-space Revision、Working-set Revision、Active Grant、Budget、Counter | 除 Receipt 外无状态变化 |

Model-facing Tool Schema 不能接受原始 `contentRef`、Artifact Path、SQLite Key、Secret Ref 或 Provider-native Block ID。Navigation 只能返回已经存在于 Caller Address Space 的 Object。

RLM Command ID 将根据 Durable Session、Cell Command 和 Call Ordinal 推导，复用现有 RLM Mutation 的 Idempotent Command-receipt Pattern。相同 Request Digest 的重复 Command 返回原 Result；相同 Command ID 携带不同 Digest 时失败 `STATE_ACCESS_COMMAND_CONFLICT`。

RLM Session Snapshot 与 `RlmChildExecutionOptionsV2` 将携带 `addressSpaceRef`、`workingSetRef`、`stateAccessPolicyRef` 和 `semanticEpoch`。Daemon Recovery 后 Host Rebind 读取这些精确 Ref，不重新编译 Live Address Space。

### Child address-space attenuation

Host 根据 Parent Address Space 和 Child Task Contract 推导 Child Address Space：

```text
A_child = requested_child_objects
        ∩ A_parent
        ∩ child_authority
        ∩ child_capabilities
        ∩ child_policy
```

Child 获得新的不可变 `StateAddressSpaceManifestV1`，其中含 `parentAddressSpaceRef`。除非 Spawn Request 显式选择对象且 Host 将其准入 Child Initial Working Set，否则 Child 不继承 Parent Active Focus Grant 或 Transaction-private Local Working Set。

Child 可以请求 Address-space Extension，但该请求必须作为独立 Durable Command 路由给 Parent 或 Orchestration Authority。Child 不能自行使扩展生效。Late Child Result 只能由结算 Child Transaction 的 Owner 作为新 Object 加入。

Runtime 在创建时强制 `objectRefs(A_child) ⊆ objectRefs(A_parent)` 且 Semantic Epoch 相同。跨 Epoch Child Work 需要显式 Semantic Rebase 或新的 Child Transaction，不能作为 Address-space Extension。

### Capability context-access contract

扩展 Capability Capsule Semantics，增加 `ContextAccessContractV1`，使 Selective Access 成为已声明 Capability Property，而不是隐式优化。

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

Global Aggregate 或 Streaming Transform 可以禁止 Selective Focus，并要求 Complete-scan Provider。Citation 或 Evidence-checking Capability 可以要求 Exact Focus 和最低 Evidence-coverage Disposition。Safety Policy、Goal Lock、Authority Summary、Output Schema 和 Unresolved Obligation 无论选择哪个 Capability 都保持 Always-visible。

当 Capsule 要求 Native Block Masking 而选定 Physical Route 只提供 Logical Materialization，或 Capability 禁止 Selective Access 但 Graph Policy 要求该模式时，Capability Resolution 必须失败。选定的 Context-access Contract 和 Effective Limit 将被密封进 Capability Binding Plan 与 Node Execution Plan。

### Physical operator attention-control offer

扩展 `PhysicalOperatorResidentCatalog`，增加可选 `attentionControl` Offer，而不是假定每个 Provider 支持同一机制：

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

缺少 Offer 等价于 `none`。当 Physical Operator 支持 Model Tool 时，Orchestration Compiler 仍可通过 Typed Tool Bridge 选择 Owner-local Logical Provider。Graph 或 Capsule 要求 `native-block-mask` 而没有合格 Offer 时必须 Admission Failure，不能静默降级为 Prompt-only Instruction。

Execution Plan 记录选定 Attention-control Mode 与精确 Offer Digest。Retry 若 Product Version、Protocol Hash、Tokenizer 或 Attention Offer 发生变化，必须进行 Semantic Compatibility Admission，不能静默 Rebind。

### Logical and native provider modes

`logical-materialization` 是首个支持模式。它把有界 Object Set 物化为带 Label、Digest 的 Model-tool Result 或 Host Continuation。它可以减小 Active Textual Working Set 并提供精确 Access Receipt，但当 Resident Product 在内部保留既有 Context 时，不能声称降低 Native KV Read。

`native-block-mask` 是可选未来模式。它把 State Segment 映射到 Physical Provider 的 Token 与 KV-page Coordinate，并在有界 Generation Span 上应用 Grant。它必须暴露 Prompt-prefix Digest、Tokenizer Identity、Model Route、Session Revision、Segment-map Digest 和 Block-table Application Receipt。Coordinate System 不匹配时，在 Decode 继续前失败。

两种模式使用相同的 Logical Intent、Grant、Address-space Version 和 Access Receipt。Provider-specific Plan Field 保存在 Opaque Ref 后，使 Application Behavior 与 Physical Implementation 可以独立演进。

### Access receipts and effect intents

Agent Transaction Engine 的 `EffectIntentV1` 将携带 Read Basis：

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

Commit Admission 验证每个 Receipt 属于同一 Transaction 与 Attempt、由同一 Semantic Epoch 签发、引用已准入 Address Space，并具有有效 Digest。不可变 Evidence Object 不需要 Live Re-read。标记 `mustRemainCurrent` 的 Policy、Approval、Budget、Lease 和其他可变 Authority Input 由 Owner Provider 在 Commit 时重新校验。

要求 Access Receipt 或 Evidence Coverage 的 Capability，在 Read Basis 缺失、Degraded 超过 Policy，或只基于 Dynamic Access Unknown 的 Legacy V1 Context 时，不能 Commit External Effect 或 Promote Final Artifact。Transaction 可以显式进入 Human-review 或 Full-fallback 路径，但不能伪造 Completeness。

Access Receipt 提供 Causal Lineage，不提供 Truth。Independent Evaluator 继续负责判断所选 Evidence 是否充分、结果是否正确。

### Durability, SQLite, and cluster replication

Immutable State Object、Policy、Address-space Manifest、Intent、Grant、Working-set Snapshot、Provider Plan、Observation 和 Receipt 以 Content-addressed Orchestration Artifact 保存。SQLite 保存 Index、Command State、Current Pointer 和 Lease，不重复 Artifact Payload。

Orchestration Schema Migration 将增加以下 Indexed Table，并将其加入 `REPLICA_TABLES`：

| Table | Purpose |
| --- | --- |
| `state_objects` | Object Ref、Owner Coordinate、Kind、Semantic Epoch 和 Creation Time |
| `state_address_spaces` | 按 Transaction、Revision、Parent、Epoch 和 Authority Revision 索引 Immutable Manifest Ref |
| `state_working_sets` | 按 Transaction 与 Revision 索引 Immutable Working-set Ref，并保存 Current Pointer Marker |
| `state_access_commands` | Command ID、Request Digest、Lifecycle、Intent/Grant/Receipt Ref、Error 和 Timestamp |
| `state_access_leases` | Grant、Transaction、Authority Revision、Cluster Term、Expiry 和 Consumed/Released State |
| `state_access_receipts` | 按 Run、Node、Attempt、Session 与 Command 索引 Append-only Receipt Ref |

当前 Store 的 Complete Cluster Replica 已经导出全部列入的 Table 和所有 Content-addressed Artifact。将新 Table 加入 `REPLICA_TABLES`、Deletion Order、Schema Creation 和 Forward Migration 后，State Access State 将成为同一 Leader Image 的组成部分。Replica Installation 遇到 Missing Table、Invalid Row、Artifact Digest Mismatch 或 Schema-version Mismatch 必须拒绝。

Grant 签发、Current Working-set Pointer 修改和 Command Receipt Accept 在同一 SQLite Transaction 中发生。Provider Application 位于 Durable `accepted` 之后。成功后，Provider Observation 与 Final Receipt 和 `settled` Command State 一同持久化。若 Provider Application 后、Settlement 前 Crash，Command 进入 `indeterminate`；Recovery 使用 Provider Reconciliation，不能再次执行未协调 Focus Operation。

Cluster Leadership 与 Authority Revision 对新 Grant 执行 Fencing。Cluster Mode 下 Grant 记录 Cluster Term。失去 Authority 的旧 Leader 不能 Apply 或 Renew Grant。即使 Logical Materialization 没有外部副作用也必须 Fencing，因为旧 Daemon 暴露已禁止的 Confidential State 属于安全故障。

### Versioning and migration

本提案要求 Forward-only Versioned Addition，不能原地重新解释：

- `ContextPacketV1` 保持可读；新 Execution 生成 `ContextPacketV2`。
- `NodeExecutionPlanV1` 保持可读；新的 State-aware Attempt 生成 `NodeExecutionPlanV2`。
- `RlmChildExecutionOptionsV1` 保持可读；State-aware Root 与 Child 使用 V2。
- `OrchestrationExecutionEvidenceV1` 保持可读，其 Access Completeness 为 `unknown`；新 Attempt 生成 V2。
- Orchestration SQLite Schema 通过显式 Migration 从 Version 4 前进，创建 State Access Table，并保留所有既有 Run、Attempt、Event 和 Artifact Row。
- 缺少 State-access Ref 的既有 RLM Session 仍是 Legacy Static-context Session。Host Rebind 不伪造 Address Space。它们可以在 Legacy Semantics 下完成，或显式作为新的 State-aware Transaction 继续。

Migration 不能从 Prompt 或 Transcript 推导 Observed Read Set，因为 Model-visible Input 不等同于 Provider-observed Access History。

### Error semantics

Public Error Vocabulary 将包括：

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

除非 Caller 拥有 Catalog-inspection Authority，未知和未授权 Object Ref 使用相同 Model-visible Message，避免泄露 Object Existence。内部 Event 在受限 Diagnostic 中保留精确 Policy Reason。

Epoch Conflict、Authority Denial、Capability Denial、Replay Drift 或 Required Provider Mode Unsupported 均 Fail Closed。Navigation Miss 或 Focus Miss 根据密封 Policy 执行并记录选定 Fallback。Budget Failure 不能自动提高 Limit。

### Security and abuse controls

State-object Ref 是 Opaque 且 Capability-scoped。模型不能枚举 Journal、Filesystem、Artifact Directory、SQLite Table 或其他 Tenant。Navigation 只能在预编译 Authorized Catalog 中运行。

Full Fallback、Focus-object Count、Materialized Token、Materialized Byte、State Transition 和 Navigation Result Count 分别独立受 Budget 控制。重复 Full Request、Focus Thrashing 或 Invalid-ref Probing 会产生 Counter 和 Event，Host Evaluator 可据此停止或隔离 Transaction。

Prompt 或 Tool-result Content 即使写出另一个 Object 名称也不能授予 Access。Parser 将 Source Text 中的全部 Object ID 视为 Data；只有模型通过 Typed State Access Tool 提交且 Host 准入后才产生访问。

Materialized Content 保留 Source Label、Object Version、Digest、Sensitivity Class 和 Lineage。Provider 不能通过拼接移除 Object Boundary，也不能让 Untrusted Source 与 Host Instruction 无法区分。

### Observability

每个 Transaction 将暴露有界 Metric 和 Event：Address-space Size、Working-set Size、Materialized Token 与 Byte、Navigation Latency、Focus Latency、Access Miss、Full Fallback、Denied Request、Transition Count、Provider Mode、Grant Expiry、Reconciliation 和 Access-completeness Disposition。

Native Provider 还可以报告 Attended Token Position、KV Byte Read、Block Count、Residency、Prefetch Hit 和 Offload Byte。当 Provider 不提供权威 Telemetry 时，Counter 保持缺失而不是估算。

Public Event Projection 不能包含 Secret Object Name、Raw Confidential Content、Provider-native Address、Credential 或 Hidden Reasoning。它可以包含 Opaque Ref、Count、Digest，以及已经准入模型的有界 Public Summary。

### First implementation slice

首个实现将增加两个 Package，使用 Owner-local Logical Materialization Provider，并集成一条完整 RLM 路径。State-aware RLM Root 的 Address Space 将包含 Upstream Orchestration Artifact/Evidence、Durable RLM Message、Settled Child-result Artifact，以及存在时的 Debate Claim Ledger。它通过 Typed Bridge 使用 `state.navigate`、`state.focus`、`state.release` 和 `state.inspect`。

该 Slice 不修改 vLLM 或任何 Resident Provider。Acceptance Probe 将证明 Child 获得 Attenuated Address Space；Focused Object 带 Receipt 进入 Model-visible Projection；Release 创建新的 Working-set Revision；Daemon Recovery 重新绑定相同 Ref；后续 Effect Intent 可以包含已记录 Read Basis。

实现阶段将同步更新 Owning Subsystem Reference、Package README、Generated Cordis API Region、Snapshot Harness 和 Current Architecture Map。只有代码和下述验证全部交付后，本 Proposed Note 才移动到 `implemented/architecture` 并继续作为 Rationale Owner。

### Verification design

| Scenario | Required observation |
| --- | --- |
| Wrong focus | 合法但不充分的 Focus 仍有 Receipt；要求 Evidence Coverage 的 Capability 阻止 Artifact Promotion，或执行密封 Fallback，而不能声称 Complete |
| Unauthorized object | Navigation 不揭示对象；Direct Focus 返回 Non-disclosing Denial，且不创建 Working-set Revision |
| Cross-epoch read | 另一 Semantic Epoch 的 Grant 在 Provider Application 前被拒绝 |
| Replay drift | 重复 Settled Command 返回原 Working-set 与 Receipt Ref；Pinned Materialization 不可用时失败 `STATE_ACCESS_REPLAY_DRIFT`，不能解析 Live Replacement |
| Child escape | Parent Address Space 或 Child Attenuation Policy 之外的 Object 被拒绝；Child Manifest 不包含该 Ref |
| Global/full denial of service | Full Fallback 与 Transition Budget 阻止重复扩张；Limit 永不自增 |
| Context miss | 执行并记录密封 `onObjectMiss` Action，包括 Navigate、Expanded Focus、Full Fallback 或 Fail |
| Full fallback | 只物化完整 Authorized Address Space，遵守 Token 与 Byte Ceiling，记录 `fallback: 'full'`，且不能包含 Forbidden Object |
| Crash after provider application | Command 进入 Indeterminate；Reconciliation 在 Applied/Not-applied/Unknown 间结算，不能 Blind Reapply |
| Cluster failover | Old Cluster Term 的 Grant 不能 Apply 或 Renew；New Leader 可恢复 Current Working-set Pointer 和 Receipt |
| Native-provider contract | Stub Provider 拒绝不匹配 Tokenizer、Prompt-prefix Digest、Model Route、Segment Map 或 Expired Grant |
| Legacy recovery | V1 Session 与 Evidence 保持可读，Access Completeness 为 `unknown`，且不创建 Synthetic Receipt |

## Alternatives considered

**给 `ContextPacketV1` 增加更多 Inline Material。** 这仍是单次静态投影并增加 Token 压力，无法提供 Dynamic Working-set Revision、Child Attenuation、Provider Negotiation、Command Idempotency 或 Read Receipt。Versioned Context Packet 仍是 Initial Projection，但不拥有 Dynamic Access。

**把 State Navigation 直接放进 RLM Runtime。** 标准 Orchestration Node、Debate Synthesis、未来 Agent Program Executor 和非 RLM Physical Operator 同样需要 State Access。RLM 应消费该 Capability，而不是拥有 State Identity、Authority、Persistence 或 Provider Routing。

**使用 Retrieval 或 Vector Search 作为 State-access Interface。** Retrieval 对候选 Content 排序，但不定义 Authorized Address Space、Exact Semantic Version、Working-set Lifetime、Observed Read-set Receipt、Child Attenuation 或 Native Attention Placement。Retrieval Provider 可以通过本提案填充或导航 Address Space。

**只使用 Compaction 和 Summary。** Compaction 有损并改变 Representation Lifetime。没有另一个可寻址 Store 时无法恢复 Exact Source Byte，也不会记录决策期间哪些版本变为可读。Summary 保持为 Navigation Aid，不能替代 Exact Object Ref。

**把 vLLM Chunk 或 KV-block Identifier 直接暴露给模型。** Provider-native Coordinate 在 Tokenizer、Prompt Prefix、Model Route、Block Size、Compaction 与 Session Recovery 之间不稳定，还会绕过 Authorization 并把 Model Protocol 耦合到一个 Serving Engine。模型命名 Semantic State Object；Provider 拥有 Physical Mapping。

**只通过 Prompt Tag 让模型管理 Full/Global Access。** Free-form Tag 不是 Authority 或 Durable Command Protocol，容易受到 Syntax Error 与 Prompt Injection 影响，也不能支持 Idempotent Recovery。未来 Native Provider 可以解析 Reserved Control Token，但结果仍需通过 Typed Grant 和 Receipt Contract。

**始终提供完整 Authorized History。** 该模式保留为显式 Fallback 和 Correctness Baseline，但它会使 Address-space Growth 等同于 Active-context Growth，并阻止 Runtime 利用 Phase-local State Access。

**将 State Access Payload 保存为 Mutable JSON Row。** Immutable Manifest、Working Set、Grant 和 Receipt 属于现有 Content-addressed Artifact Plane。SQLite Row 负责 Index 与 Coordination；复制 Payload 会形成两个 Source of Truth，并削弱 Cluster Verification。

## Acceptance criteria

- `StateObjectV1`、`StateAddressSpaceManifestV1`、`StateAccessIntentV1`、`StateAccessGrantV1` 和 `StateAccessReceiptV1` 是 Public、Versioned、Branded、Digest-bearing Contract，并在 Model/Wire Boundary 做严格验证。
- 实现强制 `Attention Set ⊆ Working Set ⊆ Address Space ⊆ Journal`，并说明 Read Set 的 Provider-observable 含义，不声称 Neural Attention 或事实正确性。
- 所有模型声明均为不可信 Proposal；Effective Access 是 Address Space、Authority、Capability、Semantic Epoch、Policy、Budget 和 Provider Limit 的交集。
- `ContextPacketV2` 携带 `addressSpaceRef`、`initialWorkingSetRef` 与 `stateAccessPolicyRef`；Legacy V1 Artifact 保持可读且不被重新解释。
- `NodeExecutionPlanV2`、`RlmChildExecutionOptionsV2` 与 `OrchestrationExecutionEvidenceV2` 携带 State Access Ref、Semantic Epoch、Provider Mode、Receipt Ref 和 Access-completeness Disposition。
- RLM 通过 Typed Host Bridge 暴露 `state.navigate`、`state.focus`、`state.release` 与 `state.inspect`，具备 Idempotent Command Receipt 和 Model-visible Event Reconstruction。
- Child Address-space Derivation 证明 Child Object Set 是 Parent 的 Permission- 与 Capability-narrowed Subset，且不隐式继承 Active Focus Grant。
- Capability Capsule Resolution 包含 Effective `ContextAccessContractV1`，并拒绝不兼容 Access Shape、Evidence Requirement、Fallback 或 Provider Mode。
- `PhysicalOperatorResidentCatalog` 发布可选 `AttentionControlOfferV1`；要求 Native Control 而无合格 Route 时 Fail Loud。
- Provider Registry 支持 `logical-materialization` 与 `native-block-mask` Contract；首个 Shipped Provider 仅实现 Logical Materialization，且不声称 KV Performance Gain。
- Agent Transaction Effect Intent 可以绑定 `StateAccessReceiptRef` 与 `observedReadSetSha256`；Commit Admission 校验 Transaction、Attempt、Epoch、Authority Revision 和 Required Freshness。
- 测试覆盖 Wrong Focus、Unauthorized Object、Cross-epoch Read、Replay Drift、Child Escape、Global/full DoS、Context Miss、Full Fallback、Provider-application Crash、Cluster Failover、Native Contract Mismatch 和 Legacy Recovery。
- 实现同步更新 Orchestration SQLite Schema 与 Cluster Replica、Current Subsystem/Package Documentation、Snapshot 和 Project State，并通过仓库选定的 Full Governance Verification，不能隐藏 Skip。

## Risks

**错误 Focus 可以精确地错误。** 合法 Grant 只证明什么变得可读，不证明所选 Object 足够。要求 Coverage 的 Capability 需要 Independent Evaluator、Required Evidence Class 或 Full Fallback，才能 Promote 或 Commit Effect。

**Logical Materialization 可能不减少 Native KV Read。** 即使 Host 只在 Tool Result 中提供 Focused Object，Resident Product 仍可能在内部保留既有 Conversation State。首个 Provider 交付 Correctness 与 Observability；Performance Claim 需要 Native Telemetry。

**Dynamic Working Set 增加 Protocol 和 Persistence Cost。** Intent、Grant、Working-set Revision、Receipt 与 Event 会带来 Write Amplification。Content-addressed Payload、Idempotent Command、Bounded History 与 Indexed Current Pointer 可以限制成本，但首个实现必须 Benchmark。

**Address-space Construction 可能成为新瓶颈。** 大型 Journal 需要 Source-owned Index 与 Summary；State Access 不能在每次 Navigate 时扫描全部 Artifact。首个 Slice 使用 Bounded Run-local Source，Global Catalog Scaling 仍是独立工作。

**Provider Telemetry 可能误导。** Provider 可以错误报告 Materialized Token 或 KV Byte。Provider Contract Test 与显式 `observationLevel` 防止 Logical Counter 被描述成 Native Attention Measurement，但 Trusted Deployment 仍依赖 Provider Integrity。

**State-access Control 可能成为 DoS Channel。** 模型可以 Focus Thrash、反复请求 Full Fallback 或探测 Invalid Ref。必须配置独立 Budget、Non-disclosing Error、Host Stop Policy 与 Transaction Quarantine。

**Version Proliferation 增加 Retention Cost。** Address Space、Working Set 与 Semantic Object Version 都是不可变对象。Retention 与 Compaction Policy 必须保存仍被 Active Transaction、Receipt、Evidence Record 或 Replay Contract 引用的对象。

**Cross-package Versioning 成本高。** 引入 V2 Context、Plan、Child Option 与 Evidence Record 会触及 Public Contract 和 Persisted State。实现必须是 Dependency-closed Vertical Slice；部分 Consumer 静默忽略新 Ref 不可接受。
