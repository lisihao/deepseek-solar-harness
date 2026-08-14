# Code Harness

`governance.py` 是项目核心，不依赖 Codex 或 Claude Code 对提示词的服从程度。

## 确定性保证

- Profile 只接受 argv 数组，不执行 shell 字符串。
- 改动发现包含 unstaged、staged、untracked 和可选 branch range。
- `check_changed_text.py` 对上述全部改动状态检查 whitespace diff 和冲突标记。
- scope 和 gate 选择由机器配置决定。
- 每个 gate 保留退出码、超时、耗时、输出 SHA-256 和尾部摘要。
- 任一必需 gate 失败，进程退出非零。
- attestation 绑定 profile bytes、Git HEAD、changed paths 和当前文件内容；变化后自动失效。
- `export_bundle.py` 将 Harness 与项目 Profile 导出为带版本和 SHA-256 清单的仓内 bundle，供远端 CI 使用。

## 强制执行

Agent 主动调用只是反馈路径。真正的“必须通过”需要把 `verify` 接入 pre-push 和 required CI，并让 CI 保存/校验 attestation。参考 `integrations/`。
