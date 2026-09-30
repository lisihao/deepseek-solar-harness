# Agent Note: 有界 Resident daemon 退休兼容性

Status: implemented

[English](2026-09-29-resident-retirement-compatibility.md) | 中文

## 问题

state schema 6 client 在发送 `system.shutdown` 前不能使用严格的 schema 6 握手确认 schema 5 daemon。把握手失败当作可以 kill 已记录 PID 的许可，可能误停替代进程或丢失正在运行的原生工作。

## 决策

业务请求继续使用协议 14/state schema 6 握手。对于返回完整握手响应的 peer，退休会保留现有路径：重新握手已观测的协议、state schema 和 Driver manifest 身份，并且只有响应中的非空 `daemonInstanceId` 与观测到的 PID 都匹配 authority SQLite 记录时，才会在同一条已验证 transport 上发送 `system.shutdown`。

相邻的 schema 5 peer 若对初次 schema 6 握手不返回响应，退休会执行一次直接兼容性探测，请求字段为 `protocol_version: 14`、`state_schema_version: 5` 和当前 Driver manifest 摘要。它只接受声明协议 14/schema 5、Driver 摘要相同、含非空 `buildCommit` 与 `daemonInstanceId` 以及必需方法的响应。随后仍须通过相同的实例与 PID 权威检查，才会优雅停止。peer 不匹配或无法确认时会以 `PROTOCOL_MISMATCH` 安全失败；不会 kill PID，也不会丢失活动工作。这项兼容例外只覆盖相邻的 schema 5 到 schema 6 升级，不增加配置字段。

## 备选方案

- **所有退休都使用严格的 schema 6 握手。** 否决，因为 schema 5 daemon 无法回答该握手，已知升级将无法排空并停止旧 daemon。
- **握手失败后 kill 已记录 PID。** 否决，因为 PID 可能已复用，且该进程可能拥有活动原生工作；必须同时观测并确认 authority 实例与 PID。
- **放宽业务握手以接受 schema 5。** 否决，因为普通请求必须继续严格验证协议和 state schema。
- **接受任意 schema 5 响应进行 shutdown。** 否决，因为响应必须证明相同 Driver manifest、必需方法、daemon 身份和观测到的 authority 所有者。

## 后果

相邻的 3.25.1 风格 daemon 可以在 3.25.2 风格升级期间排空并退休，同时不会削弱普通请求准入。同 schema peer 的不匹配继续使用现有的已观测身份退休路径；无法确认身份的 peer 会保持运行并报告 `PROTOCOL_MISMATCH`。

这条兼容路径有意保持狭窄，并限制在本地 transport。它不承诺通用跨 schema 支持、自动替换进程或恢复无法确认的 daemon。
