# 项目状态

[English](PROJECT_STATE.md) | 中文

本文件记录 Solar 分支当前执行链路、持久架构决策、阻塞缺口和唯一下一实施切片。它不替代当前状态的[架构图](architecture.zh.md)、Package Contract、生成的 Subsystem Reference，或 [Agent Notes](../.agents/notes/README.md) 中的决策依据。

## 当前执行链路

持久 Orchestration Daemon 拥有 Compilation、Scheduling、Attempt、Recovery 和 Content-addressed Artifact Store。一次 Run 编译 Intent 与 Logical TaskGraph，解析 Capability Capsule，可选地快照 Continuous Harness，编译有界 Context Packet，解析 RLM 与 Model Allocation，密封 Node Execution Plan，分派 Resident 或 Model-worker Attempt，并保留 Terminal Evidence 与 Event。Public Contract 位于 [`@deepseek-ai/dsh-orchestration`](../packages/orchestration/orchestration/src/index.ts)；Owner-local Execution Path 位于 [`orchestration-local`](../packages/orchestration/orchestration-local/src/daemon.ts)。

当前 [`ContextPacketV1`](../packages/orchestration/context-compiler/src/types.ts) 是不可变 Per-attempt Projection，包含 Source Ref、可选 Materialized Source Text、Lineage、Redaction、Token Budget、Compiler Identity 和 Content Digest。它只在 Dispatch 前编译一次，不表示 Dynamic State Address Space，也不表示长程 RLM 执行后续暴露的 State Object。

持久 [`RLM Runtime`](../packages/orchestration/rlm-runtime/src/index.ts) 拥有 Durable Root/Child Session、Child Execution Options、Message、Goal、Heartbeat、Command Receipt 和 Host Request。Child Session 继承密封的 Parent Execution Options，但 Runtime 尚未携带 provider-neutral 的 Address-space Ref、Working-set Revision、State-access Policy 或 Access Receipt。

Orchestration Store 由 Single-writer SQLite Database 与 Content-addressed Artifact Directory 构成。Cluster Replica 导出已配置 Replica Table 与全部 Artifact，验证每行和 Artifact Digest，并安装完整、更新的 Leader Image。当前 Store Schema Version 为 4，定义在 [`orchestration-local/src/store.ts`](../packages/orchestration/orchestration-local/src/store.ts)。

## 稳定基础

以下已交付机制构成拟议 Agentic Transaction Processing 工作的基础：

- TaskGraph Node 声明 Capability、Effect、Read、Write、Retry、Acceptance、RLM、Autonomous、Operator 与 Workspace-isolation 上界。
- Capability Resolution 生成不可变 Binding Plan，包含 Catalog Revision、Capsule Ref、Effective Scope/Effect、Blocker 和 Plan Digest。
- Context Compilation 生成不可变 Packet，并保留 Model-visible Source Lineage。
- Node Execution Plan 为一次 Attempt 密封选定的 Context、Capability、Model、Operator、Authority、RLM、Harness 与 Verification Input。
- RLM Root/Child Session 具有 Durable Identity、Bounded Recursion、Idempotent Command Receipt、Explicit Message、Goal、Heartbeat，以及 Daemon Recovery 后的 Host Rebind。
- Orchestration Event 与 Immutable Artifact 支持重建、Cluster Replication 和 Evidence Retention。
- Physical Operator 暴露 Stable Identity、Availability、Product Version、Protocol Hash、Resolved Model Metadata、Durable Accepted Receipt 和可选 Model-tool Bridge。
- Continuous Harness Entry 与 Refinement 已版本化，可 Snapshot、Queue、在 Turn Boundary Apply 或 Rollback。

这些机制提供较强的 Per-attempt Sealing 与 Durable Execution，但尚未提供 Run-level Semantic Isolation、Commit-time Governed Effect、Dynamic State-access Receipt 或完整 Agent Transaction Contract。

## 活跃架构提案

[Declarative State Access Plane 提案](../.agents/notes/proposed/architecture/2026-09-04-declarative-state-access-plane.zh.md)定义 Agentic Transaction Processing 缺失的读侧能力。它区分 Complete Journal、Authorized State Address Space、Dynamic Working Set 与 Provider-specific Attention Set；定义 Typed Access Intent、Grant 和 Receipt；规定 Child Permission Attenuation；并为 Native KV-block Provider 预留接口，同时在首个实现中选择 Logical Materialization。

现有 [Domain KV Storage and Workspace 提案](../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)拥有 Durable Storage Media 与 Domain-record Semantics。它不拥有 Model-visible State Selection、Access Authority、Working-set Revision 或 Attention Control，因此不被 Declarative State Access 提案 supersede。

Semantic Isolation、Governed Effect Commit 与更完整的 Agent Transaction Engine 仍属于尚未交付的架构工作。Declarative State Access 通过 Semantic-epoch Ref、Authority Revision、Observed Read-set Digest 与 Effect Read Basis 为未来组合预留接口，但不把这些机制写成已有能力。

## 阻塞缺口

长程 Attempt 可以持久化 Initial Context Packet 与后续 RLM State，但当前不能证明 Dispatch 后究竟暴露了哪些精确 Artifact、Evidence、Tool Result、Child Result、Message 或 Claim-ledger Version，也不能通过权威、幂等、可恢复的 Command Contract 动态收缩或扩展有界 Model-visible Working Set。

该缺口带来四项直接后果：

1. Complete Durable History 与 Active Model Context 过度耦合；保留更多 Evidence 会增加 Context Pressure，除非 Caller 使用有损 Compaction 或自定义 Retrieval。
2. Child RLM Session 继承 Execution Options，却没有 Machine-checked Proof 证明其可读状态是 Parent 的 Permission- 与 Capability-narrowed Subset。
3. Retry、Resume 与 Host Rebind 可以恢复 Execution State，但没有精确 Dynamic Read History；从 Transcript 伪造该历史是不正确的。
4. 未来 Governed Effect 无法把 Commit Decision 绑定到 Provider-observed Read Set，因此 Commit-time Freshness Check 无法区分 Initial Context 与 Transaction 后续暴露的 State。

## 唯一下一实施切片

```text
MODE = EVOLVE

TASK =
实现 Declarative State Access V1 的单个依赖闭合 Logical-materialization 纵向切片。增加 @deepseek-ai/dsh-state-access 和 @deepseek-ai/dsh-state-access-local；把 Artifact、Evidence、Child Result、Agent Message 和 Claim Ledger 接入一条 State-aware RLM Root/Child Path；通过 Typed Host Bridge 增加 state.navigate、state.focus、state.release 和 state.inspect；持久化并复制 Address-space、Working-set、Command、Lease 和 Receipt State。

TARGET =
State-aware RLM Attempt 使用不可变 Address-space Ref、Initial Working-set Ref、State-access Policy 和 Logical Provider Offer 编译 ContextPacketV2 与 NodeExecutionPlanV2。Child 获得 Attenuated Address Space。Focus 与 Release 产生幂等 Working-set Revision 和 Access Receipt。Recovery 重新绑定相同 Ref，Effect-intent Test Fixture 可以绑定 Observed Read-set Digest，但首片不实现 External Effect Commit。

ACCEPTANCE_CRITERIA =
1. 实现 Public State Access Schema 与严格 Model/Wire Validator，使用 Branded Ref 与 Content Digest。
2. Logical Provider 只物化已准入 Object，并为每个 Source 标注 Version、Digest、Sensitivity 与 Lineage。
3. ContextPacketV1 与 Legacy Execution/Evidence Record 保持可读；新 State-aware Attempt 生成显式 V2 Record。
4. RLM Model Tool 使用 Caller-stable Command ID、Request-digest Conflict Detection、Durable Accepted/Settled/Indeterminate State 和 Provider Reconciliation。
5. Child Address-space Construction 证明 Subset、Authority、Capability、Policy 与 Semantic-epoch Constraint。
6. Capability Resolution 包含 ContextAccessContractV1；Physical Operator Catalog 暴露 AttentionControlOfferV1，但不声称 Native KV Support。
7. SQLite Migration 与 Cluster Replica Change 保留 Existing Data，并拒绝 Missing Table、Invalid Row、Stale Term 与 Artifact Digest Mismatch。
8. Test 覆盖 Wrong Focus、Unauthorized Object、Cross-epoch Read、Replay Drift、Child Escape、Full/global Budget Abuse、Context Miss、Full Fallback、Provider-application Crash、Cluster Failover 和 Legacy Recovery。
9. Model-visible Access Result 被记录，且 Keyless Snapshot 覆盖组装后的 RLM Path。
10. Full Repository Governance Verification 与 Attestation 对 Exact Delivered Commit 通过。
```
