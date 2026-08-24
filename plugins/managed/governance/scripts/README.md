# Code Harness

`governance.py` 是项目核心，不依赖 Codex 或 Claude Code 对提示词的服从程度。

## 确定性保证

- Profile 只接受 argv 数组，不执行 shell 字符串。
- Gate 环境变量必须在 Profile 的字符串映射中显式声明，由 Harness 注入，不拼接 shell。
- 改动发现包含 unstaged、staged、untracked 和可选 branch range。
- Harness 将 `--changed-from` 作为 `GOVERNANCE_CHANGED_FROM` 传给子门禁，保持 clean worktree 的分支差异语义。
- `check_changed_text.py` 对上述全部改动状态检查 whitespace diff 和冲突标记。
- `check_changed_format.py` 只把匹配后缀的本次改动文件交给项目 formatter，避免存量格式债务掩盖新回归。
- scope 和 gate 选择由机器配置决定。
- 每个 gate 保留退出码、超时、耗时、输出 SHA-256 和尾部摘要。
- 任一必需 gate 失败，进程退出非零。
- attestation 绑定 profile bytes、Git HEAD、changed paths 和当前文件内容；变化后自动失效。
- `--report @git` 让 Git 解析普通 checkout 或 linked worktree 各自的 attestation 路径。
- `export_bundle.py` 将 Harness 与项目 Profile 导出为带版本和 SHA-256 清单的仓内 bundle，供远端 CI 使用。
- Profile 可用 `max_concurrency` 限制并发，并用 gate `needs` 声明依赖；Harness 会传递选择依赖，拒绝缺失或成环的依赖，并阻断失败依赖的消费者。
- Profile 可启用 `evidence_reuse`：只有 gate 命令、相关输入、依赖证据、基线、平台与执行器版本一致时才复用成功证据；amend/rebase 后只要旧提交仍可解析，也按精确指纹或两个提交树之间的差异判定，不把“非祖先”误当作全部失效。声明 `incremental_command` 的 gate 可只验证上次证据之后的改动。报告会标明 `reused`、`incremental` 和来源提交。

## 强制执行

Agent 主动调用只是反馈路径。真正的“必须通过”需要把 `verify` 接入 pre-push 和 required CI，并让 CI 保存/校验 attestation。参考 `integrations/`。
