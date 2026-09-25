# Agent Note：所有者显式 Resident 认证

Status: implemented

[English](2026-08-28-owner-explicit-resident-authentication.md) | 中文

## 问题

Claude Code 订阅资格审查可能报告 `auth_required`，但 DSH 之前没有由所有者控制的恢复动作。重复刷新面板和产品失败不能弹出多个 OAuth 窗口；已配对的远程 Frontend 也不能让 Server 自动启动浏览器登录。资格与执行还必须使用同一个实际解析到的产品可执行文件，避免旧系统 CLI 为另一套凭据客户端完成认证。

## 决策

Resident 协议 v10 新增 `operator.authenticate` 与 Provider 无关的 `ctx.residentOperators.authenticate()` 管理 seam。产品 Driver 可以选择实现认证；只有 CLI 或 Resident 面板中的本机所有者显式操作才能启动。daemon 会把同一算子的并发请求合并为一个产品登录进程。如果 Provider 已经通过资格审查，则直接返回当前状态，不再启动进程。

Claude Driver 通过正常资格与执行选中的同一个绝对路径调用 `claude auth login`，使用相同的凭据清理原生环境，完成后重新执行资格审查。DSH 不读取、复制、刷新或持久化 OAuth 数据；Claude Code 与操作系统凭据存储仍是 token 权威。轮询、启动、资格失败和产品 401 只报告状态，绝不会自动触发登录。

认证后的 Host 路由继续允许 loopback 所有者和已配对设备 GET，但登录 POST 只接受 loopback 所有者请求。远程 Frontend 不显示登录按钮，而是提示前往 Server 本机操作。登录完成后会失效 Provider 缓存，使新资格状态立即可见。

## 验证

聚焦 daemon 测试证明并发认证请求只调用一次 Driver，并返回同一份通过资格审查的结果。Host 路由测试证明 loopback 所有者可以启动登录，而已认证远程管理员得到 `LOCAL_OWNER_REQUIRED`。客户端测试固定登录必须通过显式 POST。受影响的 project-reference TypeScript 构建通过。

## 考虑过的替代方案

**在 401 后或轮询时自动启动登录。** 拒绝，因为无关状态读取会产生浏览器副作用，并发刷新还可能重复打开窗口。

**把 Claude token 复制到 DSH 状态。** 拒绝，因为这会制造第二个凭据权威，并让退出和刷新语义与 Claude Code 分叉。

**允许已配对的远程管理员启动登录。** 拒绝，因为 OAuth callback 与浏览器属于 Server 主机，而不是 Frontend 设备。

## 后果

认证恢复现在是显式、single-flight 的管理动作，与任务执行保持分离。无人值守的远程 Server 仍需所有者在该 Server 上完成 Claude 登录。Codex 继续沿用现有产品原生登录路径，直到其 Driver 明确实现同一可选认证操作。
