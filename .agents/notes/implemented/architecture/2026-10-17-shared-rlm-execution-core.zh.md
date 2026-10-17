# Agent Note: 由 daemon 持有的共享 RLM 执行核心

Status: implemented

[English](2026-10-17-shared-rlm-execution-core.md) | 中文

## Problem

RLM 根轮次、异步 child 和 continuation 共用取消、用量归集与终态结果规则。把执行代码放在 TaskGraph daemon 内，会使第二个消费方容易复制这些规则，或获得它不需要的 Scheduler 与 attempt 存储修改能力。

## Decision

每个 daemon 在服务注册后、恢复或派发前创建一个 `createRlmExecutionCore`。该核心执行 Resident 与 API 根轮次、child、message continuation、Goal 和 Autonomous 轮次。它的 Goal 用量队列归该 daemon 实例持有。

Daemon 为每次 attempt 构造一个执行上下文。根、child 与 continuation 调用共用其中的控制器、物理执行列表和取消范围。Daemon 保留进度跟踪、Scheduler 状态、恢复逻辑，以及绑定当前 attempt、持久化原生 turn id 的回调。恢复时为被恢复的 attempt 构造新上下文，不保留上一进程的内存对象。

核心只获得用于 RLM 事件、产物和 Autonomous 状态的受限存储视图。Resident 启动、model-worker 执行、WP1 准入与计量、容量，以及 harness 边界处理仍是由宿主持有的依赖。`UnknownPhysicalOutcomeError` 只在 `rlm-continuation.ts` 定义一次，由 daemon 与核心共用，使未知结果保留错误身份和不重放保护。

## Alternatives considered

**只抽取根与 continuation。** 把 child 派发留在 daemon，会使同一生命周期的一部分继续耦合于调用方，并要求第二个消费方另行实现。

**传入完整编排存储。** 这会让核心能够修改任意 attempt。预先绑定当前 run、节点与 attempt 的回调已经提供了所需的唯一 turn-id 写入。

**从 daemon 导入未知结果错误，或复制该类。** 前者造成循环导入；后者拆分既有失败处理所使用的类身份。共用 continuation 模块可避免这两种情况。

## Consequences

Daemon 仍是唯一消费方。这次抽取不增加独立 RLM 算子、准入路由、调度所有者或恢复能力。未来的消费方仍需要明确的准入与所有权设计。

无需密钥的 daemon 测试覆盖具有相同执行身份的两个实例、取消和未知结果，以及在重新创建 daemon 后仍保留原生 turn 的持久化。故意在全局共享用量队列时，隔离测试会失败；故意传入错误 turn id 时，保留 turn 的测试会拒绝。组装后的 `prime-rlm-terminal` 示例通过源码与构建库两种启动方式加载新模块。这些检查证明本地行为与加载路径，不证明真实模型收益、完整 RLM 恢复语义或已安装应用可用性。
