# Agent Note: 一等订阅模型保持 DSH 工具权威

Status: implemented

[English](2026-09-02-first-class-model-tool-authority.md) | 中文

## 问题

Smart Auto 选择 Claude Code 后，如果订阅资格在准入前失败，DSH 已能正确回退到 Codex。但回退回合仍可能调用 Codex 产品原生命令执行，从而打开一条拥有该会话的 DSH Session 无法结算的第二审批通道。即使同一操作已经由受治理的 DSH 模型工具桥提供，原生请求仍会让本可恢复的回合以 `APPROVAL_REQUIRED` 结束。

现有 `disabled` 原生工具策略不能解决该问题：该策略刻意禁止全部工具，Resident daemon 会拒绝它与模型工具桥同时出现。

## 决策

Resident 协议 v12 新增 `dsh-tools-authoritative`。它要求非空模型工具桥，并进入 canonical command Receipt hash。作为一等主模型的 Claude Code 与 Codex 适配器使用该策略；显式 `physical_operator` 工具、TaskGraph 计划、Debate 无工具角色及远程算子保持既有契约。

一等主模型回合继续使用现有的父 Session Resident lane。显式 resident `physical_operator` 调用现在使用稳定的 `explicit-tool:<parent-session-id>` lane，避免一等主模型回合的粘性只读/禁止审批策略污染显式算子的原生产品权限。升级后的首次显式 resident 调用会为该 lane 创建一个新的原生 Session；既有产品历史不会删除。

Claude Code 接收 `tools: []`，并只允许严格配置的 DSH MCP 工具桥，因此其内置工具表面会被移除。Codex 接收 DSH 动态工具、空的原生 environment 列表、只读 sandbox、禁止审批升级的策略及明确的权威指令。由于 Codex app-server 0.151.0 没有受支持的内置工具 allowlist，DSH 不会声称产品已经隐藏所有内置只读 utility；它保证执行与工作区修改仍由 DSH 工具桥承担。

远程执行会在准入前拒绝该新策略，因为属主本地的模型工具 socket 不能跨越该 transport。`disabled` 仍是唯一无工具策略，并继续禁止与工具桥同时使用。

## 备选方案

- 不采纳复用 `disabled`：它会同时移除原生工具和 DSH 工具。
- 不采纳继续透传 Codex 产品原生审批：拥有该回合的 DSH Session 无法结算第二条审批通道。
- 不采纳让全部 resident 调用统一使用新策略：显式 `physical_operator` 必须保留其已记录的原生产品行为。

## 后果

Smart Auto 可以在 Claude 订阅不合格时回退到 Codex，而不会把工具执行迁移到无人拥有的审批路径。DSH 工具调用继续通过普通的 scope、guard、approval、event 与插件组合表面。Receipt 重放不能改变工具权威，不受支持的远程使用会明确失败。

Codex 的限制被明确记录：当前 app-server 协议可以移除原生 environment、强制只读 sandbox、拒绝带副作用的原生审批并指示模型使用 DSH 工具，但无法从产品展示面移除每个内置只读 utility。未来上游提供 allowlist 后，可以在不改变 DSH 策略名称或 Receipt 语义的前提下加强执行约束。
