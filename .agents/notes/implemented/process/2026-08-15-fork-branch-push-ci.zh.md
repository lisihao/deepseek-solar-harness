# Agent Note: Fork 分支推送 CI

Status: implemented

[English](2026-08-15-fork-branch-push-ci.md) | 中文

## Problem

GitHub 会把 fork 贡献的拉取请求事件发送给目标仓库，而不会在 fork 自身产生该事件。因此，以当前公共 fork 为目标的拉取请求无法启动上游 `pull_request` 工作流，但分支保护仍会等待 `all checks passed`。手工调度并不等价，因为上游聚合任务只在拉取请求中运行；被跳过的聚合任务可能在没有执行依赖任务时满足必需检查。

## Decision

该 fork 由 [fork-ci.yml](../../../../.github/workflows/fork-ci.yml) 提供只作用于 `codex/**` 分支的推送触发适配层。它在标准 GitHub 托管 runner 上调用仓库原生的 Linux 主门禁、Node 兼容性、Python SDK、发布形态 Python 运行时和 Windows 阻塞命令。该适配层不替换也不修改上游 [ci.yml](../../../../.github/workflows/ci.yml)，只补充 fork 无法继承的事件和 runner 映射。

最终任务保留分支保护使用的 `all checks passed` 名称，依赖全部必需适配任务，并在失败后继续运行；任一依赖失败、取消或跳过都会使它失败。工作流只有仓库只读权限，会取消同一分支上被新提交取代的运行，也不会读取 secret。Linux 任务使用 `origin/master` 检查归档 Agent Note，并采用适合标准托管 runner 的有界 worker 数量。

## Alternatives considered

**使用手工工作流调度。** 不采用，因为上游必需聚合任务在 `pull_request` 之外会被跳过；接受这种结果会在未执行受保护依赖图时产生绿色状态。

**取消分支保护的必需状态。** 不采用，因为本地检查和运行时页面验收不能替代绑定远端提交的 CI 结论。

**复制完整上游工作流并改写所有事件条件和定制 runner 表达式。** 不采用，因为这会分叉一个大型编排文件。适配层直接调用现有聚合脚本和可复用 Python 运行时工作流。

## Consequences

每个推送的 `codex/**` 提交都会在该 fork 中获得绑定提交的真实结论，因此受保护的拉取请求无需伪造状态即可合并。标准托管 runner 会比上游定制资源池更慢，原生 Windows 阻塞任务也不同于上游 Wine 关键路径，但两者执行相同的仓库原生阻塞命令。上游仓库仍以上游拉取请求 CI 为权威；该适配层只处理当前 fork 缺失的事件。

## Verification

CI 工作流契约测试固定触发器、权限、runner 类型、原生命令、可复用 Python 运行时、必需依赖集合和失败关闭聚合名称。合并前，真实分支推送必须产生成功的必需任务和 `all checks passed` 状态。
