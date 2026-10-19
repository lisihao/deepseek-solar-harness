# Agent Note: 离线 Worker 与 Runtime 装配

Status: implemented

[English](2026-10-18-offline-worker-runtime-assembly.md) | 中文

## Problem

RLM 离线准备必须区分持久 context 与实际模型请求，也必须将上下文放置方式与工具执行、子调用能力分别验证。绕过真实 Worker 或 Runtime 的合成适配器不能证明这些连接。

## Decision

包根出口重导出现有持久评估账本，不增加第二计量者或新账本格式。可运行 Loader 夹具使用实际 DeepSeek Worker 工具循环和 Local Runtime，仅替换模型传输。full 与 external 配对共用同一原始 UTF8 文件、问题、实际模型参数、工具 schema、cell 代码和独立子调用策略。原始字节、持久 context、完整请求、逐次发送与账本行分别留证。

一个夹具 Consumer 持有 trial 领取文件、期限、cell 代理与原账本。已登记的根、子、孙全部使用代理桥接。稳定命令在转发前占用一个 cell，以完整参数检查冲突，保留 Promise 或结果，不退款、不重放。[包 README](../../../../packages/orchestration/orchestration-local/README.md#evaluation-scope) 负责说明公开账本与夹具限制。

## Alternatives considered

将全文基线改成直接作答会同时改变工具执行与上下文放置方式。第二用量计数器会重复原账本。只数账本行会漏掉没有对应行的物理发送；夹具逐项比较独立捕获的发送与 attempt。

## Consequences

期限阻止新的准入并请求取消，不会停止正在执行的 Runtime cell；晚到的真实结果仍保留。内存 cell 计数和期限不能恢复 trial，因此已有领取文件拒绝整个 trial 重建。账本重开保留 unknown 预留，与该拒绝分别验证。

Worker 已知部分用量与完整逐请求核算保持区分；output 已包含 reasoning。source 与 plain Node built Loader 快照验证同一装配。这只是 keyless 装配证据，不证明八臂生产 runner 的完整复现、OS 沙箱、输入／reasoning token 硬上界、数据许可、官方 Pairs 评分、付费授权或收益。已安装应用没有变化。
