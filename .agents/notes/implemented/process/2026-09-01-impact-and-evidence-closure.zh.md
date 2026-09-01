# Agent Note: 分离变更影响面与 Evidence 输入闭包

Status: implemented

[English](2026-09-01-impact-and-evidence-closure.md) | 中文

## 问题

过去，同一个 scope 标签同时承担两个不同职责：选择应运行的治理门禁，以及决定哪些变更字节进入该门禁的可复用 Evidence 指纹。文档变更确实需要选择 `source-build`，因为 `doc-sync` 会消费已准备的 host contract；但文档字节并不会改变该构建。把选择与指纹输入耦合，会在所有构建输入均未变化时仍使已通过的 source-build 回执失效。

普通拉取请求 CI 还会为明确的纯文档路径集合分配全部 Linux、兼容性、Python、Wine 与原生 Windows 通道。变更前的拉取请求基线实测消耗 82 分 30 秒托管 job wall time；按每个 job 分别取整后约为 92 runner-minutes。必需的 governance 结论在 10 分 59 秒后到达。这些数字是基线，不是预估节省量。

## 决策

治理门禁可以分别声明 `select_when` 与 `input_patterns`。`select_when` 控制调度；`input_patterns` 定义进入 Evidence 指纹的变更文件闭包。只声明旧 `scopes` 的既有 profile 保留原选择与指纹语义。profile 可以逐个迁移门禁；输入选择器变化会有意使旧 Evidence 失效一次，而不是静默重解释旧证据。

`source-build` 与三个依赖安装门禁显式声明源码、manifest、lock、配置及安装脚本输入。它们的命令、可执行文件身份、baseline、依赖指纹与 producer Evidence 仍属于完整复用合同。因此，纯文档变更可以复用输入未变的 source-build 回执；源码、manifest、lock、runtime、命令或依赖变化仍会使它失效。

拉取请求 CI 在普通重作业前复用现有的保守路径分类器。只有显式文档白名单会输出 `run_ci=false`；空输入、未知路径、分类失败、仓库自动化、包输入、源码或 tooling 仍运行完整 CI。稳定的 aggregate job 始终运行。只有成功分类为 docs-only 时，它才接受有意跳过的重作业；失败、取消或意外跳过仍会被拒绝。面向 solar 的 PR 继续由必需治理工作流执行 `doc-sync`；面向其他分支的纯文档 PR 则运行一个定向文档作业。push 与手工 benchmark 行为保持不变。

## 曾考虑的替代方案

**文档变更不再选择 `source-build`。** 不采用，因为当前文档合同会消费生成态 host 输出；删除依赖是在改变正确性，而不是消除重复工作。

**把门禁选择到的全部变更路径都写入指纹。** 不采用，因为调度选择范围本来就可能大于该门禁真实的字节级依赖闭包。

**使用 workflow 顶层 `paths-ignore`。** 不采用，因为它可能让稳定检查名消失，也无法给分支保护提供显式分类结论。

**只按 commit SHA 缓存。** 不采用，因为提交身份既不能证明 amend/rebase 后相关输入等价，也不能覆盖 runtime、可执行文件、依赖和 profile 变化。

## 后果

- 显式纯文档 PR 不再分配普通重 CI，同时保留可见的分类、文档合同与 aggregate 结论。
- 为编排而被选择的门禁，只要声明输入与完整执行合同未变，就可以复用 Evidence。
- 旧 profile 保持兼容；迁移后的门禁在选择器合同变化时承担一次明确的 Evidence 失效。
- 完整治理仍只在稳定变更集的后期集成边界运行一次。定向或缓存 Evidence 不会被提升为发布或部署权威。
- 实际节省量必须由合并后的真实纯文档 PR 测量；上述基线不能证明已实现的改善幅度。

## 验证

定向合同覆盖保守路径分类、docs-only aggregate 语义、旧 profile 校验、独立的门禁选择与输入闭包、纯文档 Evidence 复用，以及源码、manifest、lock、runtime 或依赖变化导致的失效。最终验收要求：集成工作树稳定后运行一次仓库 strict audit、完整 Code-as-Harness verify 与 attest；随后取得精确提交对应的远端 CI，并运行一次纯文档测量 PR。
