# Agent Note: Solar 治理关键路径

Status: implemented

[English](2026-08-20-solar-governance-critical-path.md) | 中文

## Problem

Solar 治理在 typecheck、lint、文档和 Web 构建门禁中重复执行相同的 TypeScript 源码准备。完整 related-test 门禁随后用单个 worker 运行 833 个文件，在 GitHub macOS runner 上耗时 757 秒；文档同步又耗时 173 秒，完整治理任务接近 20 分钟。同一提交还可能同时触发拉取请求 CI 与 fork 的完整推送适配器。

两个原生 HMR 测试套件仅在包含 833 个文件的长时间共享运行中偶发丢失文件系统事件。30 轮定向重复全部通过，直接 Chokidar 实验也确认：对于最初不存在的精确路径，必须监听其祖先目录。因此证据指向共享的原生 watcher 压力，而不是超时不足或应用行为错误。

第一次优化后的拉取请求运行暴露了第二个资源边界：三 CPU 的 macOS runner 把三个外层治理门禁与各自的内部 worker 池相乘。read-card 套件动态导入全部 Shiki 懒加载语法时，超过了保持不变的五秒响应契约，而其余 13,588 个测试全部通过。这是嵌套并行超卖，不是覆盖缺失，也不构成增加超时的理由。

Solar 仓库没有注册任何自定义 runner，也没有故障切换变量。三个必需 Linux 作业和独立的原生 Windows 作业从上游继承了仅供组织内部使用的 runner 标签，排队超过两小时仍未获得 runner。这段延迟是无上限的资源分配等待，不是构建执行时间。

把这些作业迁移到标准四核 runner 后，覆盖率通道暴露出最后一处嵌套预算：instrumented 与 exempt 套件各用一个 worker 并行运行，而 Oxlint 响应时间契约会在剩余的共享 CPU 压力下启动子进程。仅把 Oxlint 自身限制为单线程仍不够：final-diagnostics 用例耗时 5.228 秒，超过保持不变的五秒限制；instrumented 覆盖率套件和其余 216 个 exempt 测试全部通过。

## Decision

Solar profile 采用 `max_concurrency: 2` 的有界依赖图。这样在 GitHub macOS 的三 CPU runner 上为子进程池保留一个 CPU，避免三个顶层门禁再分别乘以三个内部 worker。唯一的 `source-build` 门禁准备共享 TypeScript 输出；typecheck、lint、文档同步与 Web 构建通过各自的 `*:contracts-ready` 入口复用输出，并声明 `needs: [source-build]`。治理运行时展开传递依赖，只调度已就绪门禁；依赖失败时阻断消费者。

Vitest 在项目配置中拥有 worker 预算：线程安全测试最多使用三个 worker，进程约束测试使用一个。两个原生 HMR 套件和 CPU 密集型 read-card 懒加载语法套件只在进程约束项目运行，其行为与超时保持不变；语法套件在外层治理 DAG 活跃时仍必须遵守既有五秒响应契约。相关测试仍由 `vitest run --changed=origin/solar` 选择，因此治理 profile 不会覆盖项目级隔离。

工作流使用部分 blob checkout、pnpm 与 Yarn 缓存，并取消已被新提交取代的运行。Solar 的必需拉取请求作业默认使用可移植的 `ubuntu-24.04` 与 `windows-2025` runner，并按标准四核容量限制内部并发。已有的仓库变量选择器仍允许显式配置自托管池，但日常正确性不再依赖上游组织的 runner 标签。拉取请求 CI 继续作为自动、绑定提交的权威结论。完整的 [fork 适配器](2026-08-15-fork-branch-push-ci.md) 保留手工调度能力，供跨平台诊断使用，但不再重复每次 `codex/**` 分支推送。

覆盖率通道还固定 `DSH_OXLINT_THREADS=1`，并只把 `scripts/oxlint-contract.spec.ts` 移入依赖尾节点。instrumented 与其余 exempt 套件仍然并行；两者结束后，Oxlint 响应时间契约在空闲 runner 上运行。这样只增加一个聚焦尾节点，不会把两条长覆盖率路径整体串行化。测试选择、覆盖率阈值与五秒契约均未改变。

## Alternatives considered

**增加 HMR 超时。** 不采用，因为定向压力测试通过，失败来自聚合 watcher 压力下的事件丢失；延长等待只能掩盖竞争，不能消除竞争。

**使用轮询或允许项目选择为空。** 不采用，因为轮询会持续增加文件系统负载，`--passWithNoTests` 还可能把错误的测试分区变成表面成功。

**跳过完整 Code-as-Harness 验证。** 不采用，因为性能优化必须保留相同的可证明门禁集合与证据语义。

**同时自动运行 fork push CI 和拉取请求 CI。** 不采用，因为两者会为同一提交重复完整证据。手工适配器保留诊断矩阵，又不占用日常关键路径。

## Consequences

独立门禁使用两个外层并发槽位，原生 watcher 与懒加载语法测试在 Vitest 内保持串行。每个任务完成后再输出其日志，使并发日志仍可阅读。标准 runner 通道可能比组织专用的大型 runner 执行更久，但无需仓库外部配置即可开始运行，使公开仓保持可复现。没有拉取请求的分支推送不再自动获得 fork 适配器结论；创建或更新拉取请求会提供所需权威结论，诊断矩阵仍可手工调度。

## Verification

契约测试固定共享构建依赖、复用产物的消费者命令、精确 related-test 命令、worker 预算、部分 checkout、缓存，以及工作流不再执行第二次源码构建。治理运行时测试覆盖无效与循环依赖、传递选择、有界独立执行和依赖失败。验收要求依次通过严格审计、monorepo 校验器、完整 Code-as-Harness 验证与证明，并取得精确提交对应的远端拉取请求 CI 结论。
