# Agent Note: 显式晚绑定算子回退保持 Debate 角色语义

Status: implemented

[English](2026-09-01-explicit-late-bound-operator-fallback.md) | 中文

## 问题

Debate 拥有逻辑角色和 persona，而 Scheduler 拥有可以独立变得不可用的物理算子与模型 offer。把每个不可用的首选算子都当成搜索全部 offer 的许可，会违反用户的显式选择，或者隐藏实际执行某个角色的不同产品。把一轮讨论视为单一失败，也会在另一个角色被阻断时丢失已经结算的角色输出。

[原生使用 TaskGraph 的智能协作](../feature/2026-08-20-taskgraph-smart-collaboration.md) 决策已经负责与 Provider 无关的偏好和硬锁定行为，但没有定义显式授权的物理回退所需的持久准入和来源记录契约。

## 决策

Graph 的 `operator.preferredIds` 在分配时规范化为 `preferredOperatorIds`，继续保持硬锁定。省略 `operator.fallbackIds` 会保留原有行为：首选算子无法通过资格审查时显式失败，Scheduler 不会扩大候选集合。调用方可以通过 `operator.fallbackIds` 明确授权部署拥有的替代算子；Debate roster 角色使用 `fallbackOperatorIds` 表达同一意图。

只有当所有首选 lane 因 `OPERATOR_UNAVAILABLE`、`AUTHENTICATION_UNQUALIFIED`、`MODEL_UNAVAILABLE` 或 `QUOTA_UNQUALIFIED` 这些非容量原因而不合格时，Scheduler 才会考虑这些显式替代项。已通过资格审查但没有空闲槽位的首选 lane 返回 `MODEL_CAPACITY_BUSY`，并保持 busy 或 waiting；暂时满载不会触发回退。

Fallback 选择仍然限制在当前策略、认证、配额、来源和 effect 检查已经准入的 offer 内。fallback 字段不会授权计量 API、绕过原生订阅资格审查、扩大 Graph 权限预算，也不会静默选择未列出的算子。

物理回退不会改变逻辑 roster。角色 id、角色类型、模型意图、persona、mandate 和 instructions 保持不变；只有该 Attempt 的物理算子和已封存模型在运行时晚绑定。因此，一个物理 Provider 可以承载多个独立的逻辑角色，例如 proposer、falsifier 和 judge，而不需要伪装成不同安装，也不要求跨 Provider 多样性。

已封存的分配计划记录 `fromOperatorId`、可选的 `fromModel` 和稳定的 `reasonCode`。Debate turn 投影记录请求的与实际的算子／模型、回退原因、分配计划引用、Attempt 以及结构化 blocker。这样，回退会在持久 Trace 中可见，而不是隐藏的重试。

Round 投影按角色独立。已结算的 proposer、被阻断的 falsifier 和因依赖失败而阻断的 judge 都保留各自的状态、输出、Attempt、路由和 blocker。Run 可以以 failed 或 awaiting recovery 结束，却不会把已经成功的角色结果改写成失败；被阻断或 indeterminate 的工作由显式恢复决策处理。

本 Note 部分取代了[原生使用 TaskGraph 的智能协作](../feature/2026-08-20-taskgraph-smart-collaboration.md)中关于 fallback 的句子：原 Note 继续负责协作偏好和 Graph 准入，本 Note 负责显式回退授权、容量语义、来源记录和按角色投影结果。

## 考虑过的替代方案

**首选算子不可用时回退到任意通过资格审查的 offer。** 否决，因为它会把硬锁定的算子选择变成隐式 Provider 切换，用户无法控制哪些产品可以执行，Trace 也无法解释实际路由。

**把暂时容量饱和视为算子不可用。** 否决，因为已通过资格审查但繁忙的 lane 应该在恢复后继续，而不是改变产品或模型语义；每个满槽位都触发 fallback 会造成不必要的路由振荡，还可能消耗另一个配额池。

**为每个物理 Provider 复制一份角色 roster。** 否决，因为角色和 persona 是逻辑事实，而 Provider 与模型是执行事实。按 Attempt 晚绑定可以让同一个 Provider 承载多个角色，无需复制 Debate 策略，也不会削弱角色级 Trace。

**允许计量 API offer 作为自动回退。** 否决，因为显式物理回退不等于同意产生计量费用。计量执行需要单独的策略决策和准入路径；本契约绝不隐式授予该权限。

**某个角色失败时折叠整轮。** 否决，因为这会丢弃已经独立结算的证据，并让不可用的 Claude 角色看起来像失败的 Codex 角色。Scheduler 与 Debate Provider 保留每个 slot 的终态事实，并将依赖失败与物理不可用保持区分。

## 后果

用户默认仍获得可预测的硬锁定行为，也可以在 Debate 角色允许在订阅算子之间移动时，选择一个范围明确的 fallback 列表。Claude 不可用时，Codex-only roster 仍可以承载 proposer、falsifier 和 judge 角色，同时 Trace 继续显示请求的角色与实际物理路由。

持久模型增加了显式路由与 blocker 字段，并且每次 fallback 都要求在 Attempt 边界进行晚分配决策。这会给计划和投影增加来源记录，也会让部分成功的轮次信息更完整；代价是繁忙的首选 lane 可能等待，而不是使用备用容量。本契约还刻意把自动计量 API 回退与运行中能力变更排除在此路径之外。

## 相关内容

分配和 Graph 契约位于 [`model-allocation`](../../../../packages/orchestration/model-allocation/src/index.ts) 与 [`orchestration`](../../../../packages/orchestration/orchestration/src/index.ts)；Debate 角色与 turn 投影位于 [`debate`](../../../../packages/orchestration/debate/src/types.ts)。
