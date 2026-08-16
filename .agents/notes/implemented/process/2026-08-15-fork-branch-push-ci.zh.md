# Agent Note: Fork 分支推送 CI

Status: implemented

[English](2026-08-15-fork-branch-push-ci.md) | 中文

## Problem

GitHub 会把 fork 贡献的拉取请求事件发送给目标仓库，而不会在 fork 自身产生该事件。因此，以当前公共 fork 为目标的拉取请求无法启动上游 `pull_request` 工作流，但分支保护仍会等待 `all checks passed`。手工调度并不等价，因为上游聚合任务只在拉取请求中运行；被跳过的聚合任务可能在没有执行依赖任务时满足必需检查。

## Decision

该 fork 由 [fork-ci.yml](../../../../.github/workflows/fork-ci.yml) 提供只作用于 `codex/**` 分支的推送触发适配层。它在标准 GitHub 托管 runner 上调用仓库原生的 Linux 主门禁、Node 兼容性、Python SDK、发布形态 Python 运行时和 Windows 阻塞命令。该适配层不替换也不修改上游 [ci.yml](../../../../.github/workflows/ci.yml)，只补充 fork 无法继承的事件和 runner 映射。

最终任务保留分支保护使用的 `all checks passed` 名称，依赖全部必需适配任务，并在失败后继续运行；任一依赖失败、取消或跳过都会使它失败。工作流只有仓库只读权限，会取消同一分支上被新提交取代的运行，也不会读取 secret。Linux 任务使用 `origin/master` 检查归档 Agent Note，并采用适合标准托管 runner 的有界 worker 数量。

第一次真实托管运行还暴露了本地定向检查没有发现的既有 fork 分支漂移：过期的生成模块图、PowerShell ACP schema 快照、重复插入现有 `tool-pwsh` loader 行的浏览器 overlay，以及 Remote Modules 覆盖债务。本次修复重新生成并固定前三项。覆盖率方面，纯 wire/配置、草稿校验和 store 状态机文件继续接受逐文件 100% 门禁，并补齐穷举式定向测试。relay 的 WebSocket/网络失败尾部分支和 React/浏览器组装代码保留行为测试与应用测试，但在真实 socket 和布局可被相应测试通道插桩前，加入仓库已有的显式浏览器/网络覆盖债务清单；全局阈值没有降低。

随后一次完整本地重跑又发现两项 fork 分支测试 harness 漂移，而不是产品失败。真实 Host smoke 创建了全新的设置目录，却没有确认带版本号的内测声明，导致模态框拦截之后的所有操作；现在测试会在选择工作区前真实执行并等待这一步用户可见流程。SDK server 集成用例在声明的 Node 24 主通道上可能超过历史的 5 秒或 15 秒 Vitest 预算；其断言、产品超时和协议行为均未改变，只把外层测试预算提高到 30 秒。

第二次托管运行在 pnpm 副作用缓存已预热的情况下执行发布工作流，又暴露了一项确定性的 harness 缺陷。缓存恢复了 node-pty 已生成的 Makefile，却没有恢复该构建图引用的虚拟仓库兄弟文件，因此 manylinux 构建在编译前就失败。发布步骤现在会在进入 manylinux 容器前，显式强制源码构建并调用 node-pty 的安装生命周期。这样无论冷缓存还是暖缓存，node-gyp 都会针对当前安装重新生成构建图；最终的 manylinux 2.28 ABI 构建和 GLIBC 检查仍由容器负责。

## Alternatives considered

**使用手工工作流调度。** 不采用，因为上游必需聚合任务在 `pull_request` 之外会被跳过；接受这种结果会在未执行受保护依赖图时产生绿色状态。

**取消分支保护的必需状态。** 不采用，因为本地检查和运行时页面验收不能替代绑定远端提交的 CI 结论。

**复制完整上游工作流并改写所有事件条件和定制 runner 表达式。** 不采用，因为这会分叉一个大型编排文件。适配层直接调用现有聚合脚本和可复用 Python 运行时工作流。

## Consequences

每个推送的 `codex/**` 提交都会在该 fork 中获得绑定提交的真实结论，因此受保护的拉取请求无需伪造状态即可合并。标准托管 runner 会比上游定制资源池更慢，原生 Windows 阻塞任务也不同于上游 Wine 关键路径，但两者执行相同的仓库原生阻塞命令。上游仓库仍以上游拉取请求 CI 为权威；该适配层只处理当前 fork 缺失的事件。

## Verification

CI 工作流契约测试固定触发器、权限、runner 类型、原生命令、可复用 Python 运行时、必需依赖集合、失败关闭聚合名称，以及 manylinux make 之前强制源码执行 node-pty 安装生命周期的顺序。定向测试固定所有被拒绝的设置/roster 字段、确定性排序、过期 controller 结果抑制、空草稿拒绝，以及 relay/Host 行为。在 Node 24 下，修复后的 SDK/boot 集合 46/46 通过，真实 Host 浏览器 smoke 12/12 通过，完整插桩套件 13,425 个测试通过，statements、branches、functions、lines 均为 100%。合并前，真实分支推送仍必须产生成功的必需任务和 `all checks passed` 状态。
